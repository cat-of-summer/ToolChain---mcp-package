import { cfg } from '../config.js';
import * as queue from './queue.js';
import * as grants from './grants.js';
import { redact } from '../secrets.js';

// Разрешение на действие спрашивается у человека и только у него. Два пути: штатный
// elicitation MCP и веб-очередь, если клиент спрашивать не умеет.
//
// Что спрашивается:
//   - доступ к пользователю на сервере (user@host) — по уровням и один раз за сессию:
//     первый вызов спрашивает чтение (человек может сразу дать и запись), первый
//     изменяющий — запись. Дальше вызовы того же уровня идут молча, по всем протоколам
//     этого пользователя (shell, файлы, docker, база). TK_APPROVAL=write спрашивает только
//     запись, off — ничего;
//   - цель с readonly: true — каждый похожий на запись вызов, при любой настройке;
//   - замена закреплённого ключа хоста — каждый раз.
// Работа в рабочей области стенда не спрашивается: это песочница самого стенда.

const LEVEL_TITLES = { read: 'Только чтение', write: 'Чтение и запись' };

export class Declined extends Error {
  constructor(decision, summary) {
    super(`Действие не выполнено: ${reason(decision)}. ${summary}`);
    this.name = 'Declined';
    this.code = 'not_approved';
    this.decision = decision;
  }
}

function reason(decision) {
  if (decision.status === 'timeout') {
    return `подтверждение не получено за ${Math.round(cfg.approveTimeoutMs / 1000)} с`;
  }
  if (decision.scope === 'access') {
    if (decision.readOnly) return `человек разрешил на «${decision.key}» только чтение`;
    if (decision.granted) {
      return decision.need === 'write'
        ? `запись на «${decision.key}» запрещена ранее в этой сессии`
        : `доступ к «${decision.key}» запрещён ранее в этой сессии`;
    }
  }
  return 'человек отказал';
}

/** Схема вопроса: да/нет или выбор уровня доступа. */
function schemaOf(choices) {
  if (!choices) {
    return {
      approve: {
        type: 'boolean',
        title: 'Разрешить?',
        description: 'Да — стенд выполнит действие и запишет его в журнал. Нет — действие не состоится.',
      },
    };
  }
  return {
    access: {
      type: 'string',
      title: 'Доступ',
      oneOf: [
        ...choices.map((level) => ({ const: level, title: LEVEL_TITLES[level] })),
        { const: 'deny', title: 'Отказать' },
      ],
      default: choices[0],
    },
  };
}

/** Ответ клиента → решение. С выбором уровня approved несёт выбранный уровень. */
function readAnswer(content, choices) {
  if (!choices) return content?.approve === false ? { status: 'declined' } : { status: 'approved' };
  const level = content?.access;
  return choices.includes(level) ? { status: 'approved', level } : { status: 'declined' };
}

async function viaElicitation(ctx, { summary, details, choices }) {
  const caps = ctx?.server?.server?.getClientCapabilities?.();
  if (!caps?.elicitation) return null;

  const lines = [summary];
  for (const [key, value] of Object.entries(details || {})) {
    if (value === null || value === undefined || value === '') continue;
    lines.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }

  try {
    const properties = schemaOf(choices);
    const res = await ctx.server.server.elicitInput({
      message: lines.join('\n'),
      requestedSchema: { type: 'object', properties, required: Object.keys(properties) },
    }, {
      timeout: cfg.approveTimeoutMs,
      // Без привязки к запросу SDK шлёт вопрос в фоновый поток сессии, а если клиент
      // его ещё не открыл — молча выбрасывает, и вызов висит до таймаута.
      relatedRequestId: ctx.requestId,
    });

    if (res.action === 'accept') return { ...readAnswer(res.content, choices), via: 'elicitation' };
    if (res.action === 'decline') return { status: 'declined', via: 'elicitation' };
    return null; // cancel — уходим в очередь, вдруг человек ответит там
  } catch {
    return null; // клиент соврал о возможности или отвалился — остаётся очередь
  }
}

/** Текст вопроса уходит наружу — в клиент и на страницу: секреты в нём не нужны. */
function safe(value, depth = 0) {
  if (typeof value === 'string') return redact(value);
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => safe(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, safe(v, depth + 1)]));
}

/**
 * Задаёт человеку один вопрос: сначала клиенту, при неудаче — в веб-очередь.
 * choices — уровни доступа на выбор (первый — тот, о котором спросили); без них вопрос да/нет.
 * Одобренное решение с choices несёт level.
 */
export async function ask(ctx, { tool, target, summary, details, choices }) {
  const cleanSummary = redact(summary);
  const cleanDetails = safe(details);
  const item = { tool, target, summary: cleanSummary, details: cleanDetails, choices };

  const answered = await viaElicitation(ctx, item);
  if (answered) {
    const id = queue.create(item);
    queue.decide(id, answered.level ?? answered.status, 'elicitation');
    return { ...answered, id };
  }

  const id = queue.create(item);
  const outcome = await queue.wait(id, cfg.approveTimeoutMs);
  return { ...fromQueue(outcome, choices), id, url: `${cfg.publicBaseUrl}/approvals` };
}

/** Решение очереди: approved — тот уровень, о котором спросили; read/write — выбранный. */
function fromQueue(outcome, choices) {
  if (!choices) return outcome;
  if (outcome.status === 'approved') return { ...outcome, level: choices[0] };
  if (choices.includes(outcome.status)) return { ...outcome, status: 'approved', level: outcome.status };
  return outcome;
}

/** Вопрос без памяти: задаётся каждый раз. */
export async function perCall(ctx, call) {
  const decision = await ask(ctx, call);
  const record = { required: true, scope: 'call', ...decision };
  if (decision.status !== 'approved') throw new Declined(record, call.summary);
  return record;
}

function accessQuestion(call, need, known) {
  if (need === 'read') {
    return {
      choices: ['read', 'write'],
      summary: `Разрешить этой сессии доступ к «${call.key}»? Первый вызов: ${call.summary}`,
      meaning: 'Разрешение пользователю на этом сервере до конца сессии: shell, файлы, docker и база. '
        + '«Только чтение» — читающие вызовы дальше без вопросов, первая запись спросит ещё раз. '
        + '«Чтение и запись» — без вопросов и запись. Отказ закрывает доступ до конца сессии.',
    };
  }
  const offerRead = known.read === undefined && cfg.approval !== 'write';
  return {
    choices: offerRead ? ['write', 'read'] : ['write'],
    summary: `Разрешить этой сессии запись на «${call.key}»? Первый изменяющий вызов: ${call.summary}`,
    meaning: 'Разрешение на запись пользователю на этом сервере до конца сессии: shell, файлы, docker и база. '
      + (offerRead ? '«Только чтение» — этот вызов не выполнится, читающие пройдут без вопросов. ' : '')
      + 'Отказ закрывает запись до конца сессии, чтение остаётся.',
  };
}

/** Доступ к user@host: уровень спрашивается один раз за сессию, ответ — и отказ тоже — запоминается. */
async function perAccess(ctx, call) {
  const need = call.mutating ? 'write' : 'read';
  if (need === 'read' && cfg.approval === 'write') return { required: false };

  const base = { required: true, scope: 'access', key: call.key, need };
  const known = grants.get(ctx.sessionId, call.key);

  if (known[need] === false) throw new Declined({ ...base, status: 'declined', granted: 'ранее' }, call.summary);
  if (known[need]) return { ...base, status: 'approved', level: need, granted: 'ранее в этой сессии' };

  const question = accessQuestion(call, need, known);
  const decision = await ask(ctx, {
    tool: call.tool,
    target: call.target,
    summary: question.summary,
    details: { ...(call.details || {}), 'что это значит': question.meaning },
    choices: question.choices,
  });

  if (decision.status !== 'approved') {
    grants.deny(ctx.sessionId, call.key, need);
    throw new Declined({ ...base, ...decision }, call.summary);
  }

  grants.grant(ctx.sessionId, call.key, decision.level);
  if (need === 'write' && decision.level !== 'write') {
    grants.deny(ctx.sessionId, call.key, 'write');
    throw new Declined({ ...base, ...decision, status: 'declined', readOnly: true }, call.summary);
  }
  return { ...base, ...decision };
}

function guardCall(call) {
  const { reasons } = call.guard;
  return {
    tool: call.tool,
    target: call.target,
    summary: `«${call.target}» помечен «только для чтения», а вызов похож на изменяющий. Разрешить именно его? `
      + call.summary,
    details: {
      ...(call.details || {}),
      'почему спрашиваю': reasons.join('; '),
      'что это значит': 'Разрешение только на этот вызов: следующий похожий спросит снова.',
    },
  };
}

/**
 * Пропускает вызов или бросает Declined. Возвращает запись для журнала: по ней видно,
 * спрашивали ли человека сейчас или действие прошло по выданному раньше разрешению.
 * call.key — user@host; без него вызов не удалённый и доступ не спрашивается.
 */
export async function authorize(ctx, call) {
  let record = { required: false };
  let questions = 0;

  try {
    if (call.key && cfg.approval !== 'off') {
      record = await perAccess(ctx, call);
      if (record.id) questions++;
    }
    // readonly спрашивает про каждый похожий на запись вызов и после выданного на сервер
    // разрешения: иначе флаг ничего бы не значил после первого же «да».
    if (call.guard) {
      record = await perCall(ctx, guardCall(call));
      questions++;
    }
  } catch (err) {
    if (err.decision) err.decision.questions = questions + (err.decision.id ? 1 : 0);
    throw err;
  }
  return { ...record, questions };
}
