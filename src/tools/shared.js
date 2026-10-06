import { cfg } from '../config.js';
import * as audit from '../audit/log.js';
import * as gate from '../approve/gate.js';
import * as targets from '../target.js';
import { resolveMap } from '../secretref.js';
import { scrub, scrubDeep } from '../secrets.js';

// Общая рамка вокруг каждого инструмента: найти цель, спросить человека, разрешить
// секреты, выполнить, вычистить, записать в журнал. Инструменты сами этим не занимаются —
// иначе первый же новый инструмент завёл бы ещё один вариант «как мы тут спрашиваем».

export function text(data) {
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  if (Buffer.byteLength(body) <= cfg.maxTextBytes) return { content: [{ type: 'text', text: body }] };

  const cut = Buffer.from(body).subarray(0, cfg.maxTextBytes).toString('utf8');
  return {
    content: [{
      type: 'text',
      text: `${cut}\n\n… ответ обрезан до TK_MAX_TEXT_BYTES (${cfg.maxTextBytes} Б). `
        + 'Сузьте выборку или заберите результат файлом рабочей области.',
    }],
  };
}

export function fail(message, details) {
  const body = details ? `${message}\n${JSON.stringify(details, null, 2)}` : message;
  return { isError: true, content: [{ type: 'text', text: body }] };
}

/** Разворачивает mutating: булево или предикат от аргументов. */
function isMutating(def, args) {
  return typeof def.mutating === 'function' ? Boolean(def.mutating(args)) : Boolean(def.mutating);
}

// Какие цели годятся какому виду инструментов.
function checkKind(def, target, label) {
  const proto = target.proto || 'ssh';
  if ((def.remote === 'shell' || def.remote === 'docker') && proto !== 'ssh') {
    throw new Error(`«${label}» — ${proto}, а ${def.name} работает только через ssh`);
  }
  if (def.remote === 'db' && !target.db) {
    throw new Error(`у «${label}» нет блока db: откройте подключение conn_open с db: {engine, database, user, password}`);
  }
}

/**
 * Почему этот вызов надо подтвердить отдельно, мимо выданного на сервер разрешения:
 * цель помечена readonly, а вызов изменяющий (у shell — с приметами записи).
 */
function guardOf(target, { mutating, signs }) {
  if (!target?.readonly || !mutating) return null;
  return { reasons: signs ?? ['изменяющий вызов'] };
}

export function wrap(def, sessionCtx) {
  return async (args = {}, extra = {}) => {
    // Вопрос человеку привязывается к этому вызову: без requestId SDK шлёт его в фоновый
    // поток сессии, а если клиент его ещё не открыл — молча выбрасывает, и вызов висит.
    const ctx = { ...sessionCtx, requestId: extra.requestId, sessionId: extra.sessionId ?? sessionCtx.sessionId };
    const entry = audit.start({
      tool: def.name,
      alias: targets.safeConn(args.conn),
      args: typeof args.conn === 'string' ? { ...args, conn: targets.safeConn(args.conn) } : args,
      kind: def.group,
      secretArgs: def.secretArgs,
    });

    let secrets = [];

    try {
      let info = null;
      if (def.remote) {
        const found = targets.lookup(ctx.sessionId, args.conn);
        const label = found.name ?? targets.labelOf(found.target);
        checkKind(def, found.target, label);
        info = {
          ...found,
          label,
          host: targets.hostKeyOf(found.target, def.remote),
          access: targets.accessKeyOf(found.target, def.remote),
        };
        // Секреты, переданные значением (в том числе паролем в адресе ssh://user:pass@host),
        // известны уже сейчас: их вычищаем и из вопроса человеку, а не только из ответа.
        secrets.push(...targets.literalSecrets(found.target));
        entry.target = targets.labelOf(found.target);
      }

      const mutating = isMutating(def, args);
      const signs = def.writeSigns ? def.writeSigns(args, info) : null;
      // Shell изменяющий по построению; пишет ли он на деле, видно по приметам. Без примет
      // хватает разрешения на чтение, и «только для чтения» не спрашивает.
      const writes = mutating && (signs === null || signs.length > 0);
      entry.mutating = mutating;
      entry.writeSigns = signs;

      const summary = def.summary
        ? def.summary(args, info)
        : `${def.name}${info ? ` на «${info.label}»` : ''}`;

      if (def.remote) {
        entry.approval = await gate.authorize(ctx, {
          tool: def.name,
          target: info.label,
          key: info.access,
          mutating: writes,
          guard: guardOf(info.target, { mutating: writes, signs }),
          summary: scrub(summary, secrets),
          details: def.details ? scrubDeep(def.details(args, info), secrets) : undefined,
        });
      }

      // Секреты разрешаются после подтверждения: до него читать их незачем.
      let resolved = null;
      if (def.remote) {
        const made = await targets.materialize(info.target, { kind: def.remote, label: info.label });
        resolved = made.resolved;
        secrets.push(...made.values);
      }

      let filled = args;
      for (const field of def.secretRefs || []) {
        if (!filled[field]) continue;
        const { map, values } = await resolveMap(filled[field]);
        filled = { ...filled, [field]: map };
        secrets.push(...values);
      }
      secrets = [...new Set(secrets.filter(Boolean))];

      const result = await def.run(filled, {
        ctx,
        info,
        resolved,
        approveHostKey: info ? makeHostKeyApprover(ctx, def, info) : undefined,
        secrets,
        addSecret: (value) => { if (value) secrets.push(String(value)); },
      });

      const payload = result?.data ?? result ?? null;
      audit.finish(entry, {
        ok: result?.ok !== false,
        exitCode: result?.exitCode ?? null,
        command: result?.command ?? null,
        stdout: result?.stdout ?? (payload === null ? '' : JSON.stringify(payload)),
        stderr: result?.stderr ?? '',
        secrets,
      });

      // Ответ агенту чистится теми же значениями, что и журнал: `cat .env` или
      // `echo $MYSQL_PWD` иначе вернули бы пароль, переданный ссылкой.
      return text(scrubDeep(payload, secrets));
    } catch (err) {
      audit.finish(entry, { ok: false, error: err.message, stdout: '', stderr: err.stack || '', secrets });

      if (err.name === 'Declined') {
        return fail(err.message, err.decision?.url ? { где: err.decision.url } : undefined);
      }
      if (err.code === 'host_key') {
        return fail(err.message, { хост: err.host, ожидался: err.expected, пришёл: err.actual });
      }
      return fail(`${def.name}: ${scrub(err.message, secrets)}`);
    }
  };
}

/** Замена закреплённого ключа хоста — отдельный вопрос человеку, каждый раз. */
function makeHostKeyApprover(ctx, def, info) {
  return async (fp, { replace } = {}) => {
    try {
      await gate.perCall(ctx, {
        tool: def.name,
        target: info.label,
        summary: `Ключ сервера «${info.label}» сменился: был ${replace}, пришёл ${fp}. Закрепить новый ключ?`,
        details: {
          'что это значит': 'Так выглядит и переустановка сервера, и подмена. Подтверждайте, только если '
            + 'знаете, что ключ сменился честно.',
        },
      });
      return true;
    } catch (err) {
      if (err.name === 'Declined') return false;
      throw err;
    }
  };
}
