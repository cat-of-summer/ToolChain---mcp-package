import { cfg } from '../config.js';
import * as queue from './queue.js';
import * as grants from './grants.js';
import { redact } from '../secrets.js';

// Разрешение на действие спрашивается у человека и только у него. Два пути: штатный
// elicitation MCP и веб-очередь, если клиент спрашивать не умеет.
//
// Что спрашивается:
//   - первая запись на удалённый сервер — один раз за сессию, разрешение покрывает все
//     протоколы этого сервера (shell, файлы, docker, база). TK_APPROVAL=off отключает;
//   - цель с readonly: true — каждый похожий на запись вызов, при любой настройке;
//   - замена закреплённого ключа хоста — каждый раз.
// Работа в рабочей области стенда не спрашивается: это песочница самого стенда.

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
  if (decision.scope === 'host' && decision.granted) return `запись на «${decision.host}» запрещена ранее в этой сессии`;
  return 'человек отказал';
}

async function viaElicitation(ctx, { summary, details }) {
  const caps = ctx?.server?.server?.getClientCapabilities?.();
  if (!caps?.elicitation) return null;

  const lines = [summary];
  for (const [key, value] of Object.entries(details || {})) {
    if (value === null || value === undefined || value === '') continue;
    lines.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }

  try {
    const res = await ctx.server.server.elicitInput({
      message: lines.join('\n'),
      requestedSchema: {
        type: 'object',
        properties: {
          approve: {
            type: 'boolean',
            title: 'Разрешить?',
            description: 'Да — стенд выполнит действие и запишет его в журнал. Нет — действие не состоится.',
          },
        },
        required: ['approve'],
      },
    }, {
      timeout: cfg.approveTimeoutMs,
      // Без привязки к запросу SDK шлёт вопрос в фоновый поток сессии, а если клиент
      // его ещё не открыл — молча выбрасывает, и вызов висит до таймаута.
      relatedRequestId: ctx.requestId,
    });

    if (res.action === 'accept') {
      return { status: res.content?.approve === false ? 'declined' : 'approved', via: 'elicitation' };
    }
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

/** Задаёт человеку один вопрос: сначала клиенту, при неудаче — в веб-очередь. */
export async function ask(ctx, { tool, target, summary, details }) {
  const cleanSummary = redact(summary);
  const cleanDetails = safe(details);

  const answered = await viaElicitation(ctx, { summary: cleanSummary, details: cleanDetails });
  if (answered) {
    const id = queue.create({ tool, target, summary: cleanSummary, details: cleanDetails });
    queue.decide(id, answered.status, 'elicitation');
    return { ...answered, id };
  }

  const id = queue.create({ tool, target, summary: cleanSummary, details: cleanDetails });
  const outcome = await queue.wait(id, cfg.approveTimeoutMs);
  return { ...outcome, id, url: `${cfg.publicBaseUrl}/approvals` };
}

/** Вопрос без памяти: задаётся каждый раз. */
export async function perCall(ctx, call) {
  const decision = await ask(ctx, call);
  const record = { required: true, scope: 'call', ...decision };
  if (decision.status !== 'approved') throw new Declined(record, call.summary);
  return record;
}

/** Запись на сервер: спрашивается один раз за сессию, ответ — и отказ тоже — запоминается. */
async function perHost(ctx, call) {
  const base = { required: true, scope: 'host', host: call.host };
  const known = grants.get(ctx.sessionId, call.host);

  if (known === 'denied') throw new Declined({ ...base, status: 'declined', granted: 'ранее' }, call.summary);
  if (known === 'granted') return { ...base, status: 'approved', granted: 'ранее в этой сессии' };

  const summary = `Разрешить этой сессии запись на сервер «${call.host}»? Первый изменяющий вызов: ${call.summary}`;
  const details = {
    ...(call.details || {}),
    'что это значит': 'Разрешение на сервер целиком до конца сессии: shell, файлы, docker и база. '
      + 'Отказ закрывает запись на этот сервер до конца сессии, чтение остаётся.',
  };
  const decision = await ask(ctx, { tool: call.tool, target: call.target, summary, details });
  grants.set(ctx.sessionId, call.host, decision.status === 'approved');
  if (decision.status !== 'approved') throw new Declined({ ...base, ...decision }, call.summary);
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
 */
export async function authorize(ctx, call) {
  let record = { required: false };
  let questions = 0;

  try {
    if (call.mutating && call.host && cfg.approval !== 'off') {
      record = await perHost(ctx, call);
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
