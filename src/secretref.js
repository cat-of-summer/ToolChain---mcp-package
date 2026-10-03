import fs from 'node:fs';
import { cfg } from './config.js';
import * as ws from './workspace.js';

// Стенд доступов не хранит. Поле секрета в вызове (пароль, ключ, парольная фраза,
// значения env) принимает одно из трёх:
//
//   значение          — как есть; дальше оно вычищается из ответа и журнала;
//   ws:<путь>         — файл в рабочей области: ключ, загруженный на /upload мимо
//                       контекста модели. Хвостовой перевод строки у пароля срезается;
//   secret://<id>     — ссылка, которую разрешает сервис секретов (TK_SECRET_RESOLVER_URL).
//
// Протокол сервиса секретов ещё не зафиксирован. Сейчас это GET <url>?ref=<ссылка> с
// Bearer-токеном и ответом {"value": "…"}; когда появится свой MCP секретов, меняется
// только resolveRemote.

export const WS_PREFIX = 'ws:';
export const REMOTE_PREFIX = 'secret://';

export const isRef = (value) => typeof value === 'string'
  && (value.startsWith(WS_PREFIX) || value.startsWith(REMOTE_PREFIX));

export class SecretRefError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecretRefError';
    this.code = 'secret_ref';
  }
}

function resolveWs(ref, { trim }) {
  let file;
  try {
    file = ws.resolve(ref.slice(WS_PREFIX.length));
  } catch (err) {
    throw new SecretRefError(err.message);
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new SecretRefError(`файла «${ref}» нет в рабочей области — загрузите его на ${cfg.publicBaseUrl}/upload`);
  }
  const value = fs.readFileSync(file, 'utf8');
  // Ключ PEM без завершающего перевода строки ssh2 не принимает, а пароль с ним не подходит.
  return trim ? value.replace(/\r?\n$/, '') : value;
}

async function resolveRemote(ref) {
  if (!cfg.secretResolverUrl) {
    throw new SecretRefError(
      `резолвер секретов не настроен (TK_SECRET_RESOLVER_URL), ссылку «${ref}» разрешить нечем. `
      + 'Передайте значение напрямую или файлом из рабочей области: ws:<путь>',
    );
  }

  const url = new URL(cfg.secretResolverUrl);
  url.searchParams.set('ref', ref);
  const headers = { accept: 'application/json' };
  if (cfg.secretResolverToken) headers.authorization = `Bearer ${cfg.secretResolverToken}`;

  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(cfg.secretResolverTimeoutMs) });
  } catch (err) {
    throw new SecretRefError(`сервис секретов не ответил на «${ref}»: ${err.message}`);
  }
  if (!res.ok) throw new SecretRefError(`сервис секретов отказал на «${ref}»: HTTP ${res.status}`);

  const body = await res.json().catch(() => null);
  if (typeof body?.value !== 'string') throw new SecretRefError(`сервис секретов вернул на «${ref}» не {value: string}`);
  return body.value;
}

/**
 * Разрешает одно поле. trim — для паролей: файл, сохранённый редактором, кончается
 * переводом строки, а пароль — нет.
 */
export async function resolveValue(value, { trim = true } = {}) {
  if (value === undefined || value === null || value === '') return value;
  const raw = String(value);
  if (raw.startsWith(WS_PREFIX)) return resolveWs(raw, { trim });
  if (raw.startsWith(REMOTE_PREFIX)) return resolveRemote(raw);
  return raw;
}

/** Разрешает объект «имя → значение или ссылка» (env команды). */
export async function resolveMap(map) {
  if (!map) return { map, values: [] };
  const out = {};
  const values = [];
  for (const [key, value] of Object.entries(map)) {
    out[key] = await resolveValue(value);
    if (isRef(value)) values.push(out[key]);
  }
  return { map: out, values };
}
