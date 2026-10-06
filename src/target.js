import fs from 'node:fs';
import { z } from 'zod';
import { pick } from './i18n.js';
import { KNOWN_HOSTS, ensureDirs } from './paths.js';
import { resolveValue, isRef } from './secretref.js';

// Цель — куда идёт удалённый вызов. Стенд доступов не хранит: цель приходит в вызове.
// Чтобы не повторять реквизиты в каждом вызове, её один раз открывают под именем
// (conn_open), и дальше инструментам хватает conn: "имя". Имена живут в памяти сессии
// MCP и умирают вместе с ней: на диск не ложится ничего, кроме закреплённых ключей хостов
// (это не секрет, а защита от подмены сервера).
//
// Для разового вызова conn принимает и адрес: ssh://user@host:22/cwd, sftp://…, ftp://…,
// ftps://… — без пароля (вход ключом или агентом) либо с паролем в адресе.

const secret = z.string().describe(pick({
  ru: 'значение, ws:<путь к файлу в рабочей области> или secret://<id>',
  en: 'value, ws:<path to a workspace file> or secret://<id>',
}));

export const targetSchema = z.object({
  host: z.string().optional().describe(pick({ ru: 'адрес сервера', en: 'server address' })),
  port: z.number().int().positive().optional(),
  user: z.string().optional(),
  password: secret.optional(),
  key: secret.optional().describe(pick({ ru: 'приватный ключ SSH: ws:<путь> или secret://<id>', en: 'SSH private key: ws:<path> or secret://<id>' })),
  passphrase: secret.optional(),
  hostKey: z.string().optional().describe('SHA256:…'),
  proto: z.enum(['ssh', 'ftp', 'ftps']).optional().describe(pick({
    ru: 'ssh (по умолчанию; файлы — по sftp) или ftp/ftps (только files_*)',
    en: 'ssh (default; files go over sftp) or ftp/ftps (files_* only)',
  })),
  root: z.string().optional().describe(pick({ ru: 'корень для относительных путей files_*', en: 'base for relative files_* paths' })),
  cwd: z.string().optional().describe(pick({ ru: 'каталог по умолчанию для ssh_*', en: 'default directory for ssh_*' })),
  shell: z.string().optional(),
  readonly: z.boolean().optional().describe(pick({
    ru: 'каждый похожий на запись вызов спрашивает человека',
    en: 'every write-like call asks the human',
  })),
  db: z.object({
    engine: z.enum(['postgres', 'mysql', 'mariadb']),
    database: z.string(),
    user: z.string(),
    password: secret.optional(),
    host: z.string().optional().describe(pick({
      ru: 'адрес базы со стороны сервера, по умолчанию 127.0.0.1',
      en: 'DB address as seen from the server, default 127.0.0.1',
    })),
    port: z.number().int().positive().optional(),
    ssl: z.boolean().optional(),
    via: z.enum(['tunnel', 'exec', 'direct']).optional().describe(pick({
      ru: 'tunnel — SSH-туннель (по умолчанию), exec — psql/mysql на сервере, direct — по сети без SSH',
      en: 'tunnel — SSH tunnel (default), exec — psql/mysql on the server, direct — over the network, no SSH',
    })),
  }).optional(),
  docker: z.object({
    container: z.string().optional(),
    composeFile: z.string().optional(),
    workdir: z.string().optional(),
    sudo: z.boolean().optional(),
  }).optional(),
});

/** Параметр инструмента: имя открытого подключения или адрес. */
export const connParam = z.string().describe(pick({
  ru: 'имя из conn_open или адрес ssh://user@host[:port][/path], sftp://…, ftp://…, ftps://…',
  en: 'a conn_open name or an address ssh://user@host[:port][/path], sftp://…, ftp://…, ftps://…',
}));

// ── Подключения сессии ────────────────────────────────────────────────────────────────

const sessions = new Map(); // sessionId -> Map<name, { target, openedAt }>
export const STDIO_SESSION = 'stdio';

const bucket = (sessionId) => {
  const key = sessionId || STDIO_SESSION;
  if (!sessions.has(key)) sessions.set(key, new Map());
  return sessions.get(key);
};

export const NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;

export function open(sessionId, name, target) {
  if (!NAME.test(name)) throw new Error(`имя «${name}» не годится: буквы, цифры, . _ / -, до 64 символов`);
  const parsed = validate(target);
  bucket(sessionId).set(name, { target: parsed, openedAt: new Date().toISOString() });
  return describeTarget(parsed);
}

export const close = (sessionId, name) => bucket(sessionId).delete(name);

export function list(sessionId) {
  return [...bucket(sessionId)].map(([name, { target, openedAt }]) => ({ name, openedAt, ...describeTarget(target) }));
}

export function forget(sessionId) {
  sessions.delete(sessionId || STDIO_SESSION);
}

export const sessionCount = () => sessions.size;

// ── Разбор ────────────────────────────────────────────────────────────────────────────

const SCHEMES = { 'ssh:': 'ssh', 'sftp:': 'ssh', 'ftp:': 'ftp', 'ftps:': 'ftps' };

export function parseUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  const proto = SCHEMES[url.protocol];
  if (!proto || !url.hostname) return null;

  const target = { host: url.hostname, proto };
  if (url.port) target.port = Number(url.port);
  if (url.username) target.user = decodeURIComponent(url.username);
  if (url.password) target.password = decodeURIComponent(url.password);
  const pathPart = decodeURIComponent(url.pathname || '');
  if (pathPart && pathPart !== '/') {
    target.root = pathPart;
    if (proto === 'ssh') target.cwd = pathPart;
  }
  return target;
}

/** conn для журнала и вопросов человеку: пароль из адреса заменяется маской. */
export function safeConn(conn) {
  if (typeof conn !== 'string') return null;
  try {
    const url = new URL(conn);
    if (!SCHEMES[url.protocol] || !url.password) return conn;
    url.password = '****';
    return url.toString();
  } catch {
    return conn;
  }
}

/** conn из аргументов → цель. */
export function lookup(sessionId, conn) {
  if (!conn) throw new Error('не указано подключение: conn — имя из conn_open или адрес ssh://…');
  const named = bucket(sessionId).get(conn);
  if (named) return { name: conn, target: named.target };
  const parsed = parseUrl(conn);
  if (parsed) return { name: null, target: parsed };
  const known = [...bucket(sessionId).keys()];
  throw new Error(
    `подключения «${conn}» нет в этой сессии${known.length ? ` (открыты: ${known.join(', ')})` : ''}. `
    + 'Откройте его conn_open или передайте адрес ssh://user@host',
  );
}

function validate(target) {
  const parsed = targetSchema.parse(target);
  if (!parsed.host && parsed.db?.via !== 'direct') throw new Error('у цели не задан host');
  if (parsed.db?.via === 'direct' && !parsed.db.host) throw new Error('db.via: direct требует db.host');
  return parsed;
}

const defaultPort = (proto) => (proto === 'ftp' || proto === 'ftps' ? 21 : 22);

/** Подпись цели для человека и журнала: user@host:port. */
export function labelOf(target) {
  const proto = target.proto || 'ssh';
  if (!target.host && target.db) return `${target.db.host}:${target.db.port || ''}`;
  return `${proto === 'ssh' ? '' : `${proto}://`}${target.user ? `${target.user}@` : ''}${target.host}:${target.port || defaultPort(proto)}`;
}

/** Что можно показать человеку, журналу и агенту: без секретов. */
export function describeTarget(target) {
  const proto = target.proto || 'ssh';
  const out = {
    proto,
    host: target.host ?? null,
    port: target.port || defaultPort(proto),
    user: target.user ?? null,
    auth: target.key ? 'key' : target.password ? 'password' : 'agent',
  };
  for (const field of ['root', 'cwd', 'readonly', 'hostKey']) if (target[field] !== undefined) out[field] = target[field];
  if (target.db) {
    const { password, ...db } = target.db;
    out.db = password === undefined ? db : { ...db, password: isRef(password) ? password : '••••' };
  }
  if (target.docker) out.docker = target.docker;
  return out;
}

/** Секреты цели, переданные значением, а не ссылкой: их знаем до разрешения ссылок. */
export function literalSecrets(target) {
  return [target.password, target.key, target.passphrase, target.db?.password]
    .filter((value) => typeof value === 'string' && value && !isRef(value));
}

/** Адрес сервера, куда на деле идёт вызов: у облачной базы это db.host, а не host цели. */
export function hostKeyOf(target, kind) {
  if (kind === 'db' && target.db?.via === 'direct') return target.db.host;
  return target.host;
}

/**
 * Ключ разрешения: user@host. Разрешение выдаётся пользователю на сервере, а не серверу
 * целиком, и покрывает все протоколы этого пользователя (shell, файлы, docker, база через туннель).
 */
export function accessKeyOf(target, kind) {
  const direct = kind === 'db' && target.db?.via === 'direct';
  const host = hostKeyOf(target, kind);
  const user = direct ? target.db.user : target.user;
  return user ? `${user}@${host}` : host;
}

// ── Закреплённые ключи хостов ─────────────────────────────────────────────────────────

function readPins() {
  try { return JSON.parse(fs.readFileSync(KNOWN_HOSTS, 'utf8')); } catch { return {}; }
}

export const pinned = (address, port) => readPins()[`${address}:${port}`] ?? null;

export function pin(address, port, fingerprint) {
  ensureDirs();
  const pins = readPins();
  pins[`${address}:${port}`] = fingerprint;
  fs.writeFileSync(KNOWN_HOSTS, `${JSON.stringify(pins, null, 2)}\n`);
}

// ── Цель → объект транспорта ──────────────────────────────────────────────────────────

/**
 * Разрешает секреты цели (после подтверждения: до него читать их незачем) и строит
 * объект того вида, что ждут транспорты. values — всё разрешённое, для вычистки.
 */
export async function materialize(target, { kind, label }) {
  const values = [];
  const take = async (value, opts) => {
    const resolved = await resolveValue(value, opts);
    if (resolved) values.push(resolved);
    return resolved;
  };

  const proto = target.proto || 'ssh';
  const password = await take(target.password);
  // Ключ не обрезается: PEM без завершающего перевода строки ssh2 не читает.
  const key = await take(target.key, { trim: false });
  const passphrase = await take(target.passphrase);

  const port = target.port || defaultPort(proto);
  const host = target.host && proto === 'ssh' ? {
    alias: `${target.user ? `${target.user}@` : ''}${target.host}:${port}`,
    address: target.host,
    port,
    username: target.user,
    authKind: key ? 'key' : password ? 'password' : 'agent',
    secret: () => key ?? password,
    passphrase: () => passphrase,
    pinnedKey: pinned(target.host, port),
    wantedKey: target.hostKey ?? null,
    readonly: Boolean(target.readonly),
  } : null;

  const resolved = {
    alias: label,
    kind,
    proto,
    host,
    port,
    config: {
      cwd: target.cwd,
      shell: target.shell,
      root: target.root,
      readonly: target.readonly,
      proto: proto === 'ssh' ? 'sftp' : proto,
    },
  };

  if (kind === 'files' && proto !== 'ssh') {
    resolved.ftp = { address: target.host, port, username: target.user, password, secure: proto === 'ftps' };
  }

  if (kind === 'db') {
    if (!target.db) throw new Error(`у «${label}» нет блока db — откройте подключение с db: {engine, database, user, …}`);
    const db = target.db;
    const dbPassword = await take(db.password);
    const via = db.via || 'tunnel';
    if (via !== 'direct' && !host) throw new Error(`db.via: ${via} ходит через SSH, а у «${label}» нет SSH-хоста`);
    resolved.host = via === 'direct' ? null : host;
    resolved.port = db.port || (db.engine === 'postgres' ? 5432 : 3306);
    resolved.config = {
      engine: db.engine,
      address: db.host || '127.0.0.1',
      database: db.database,
      username: db.user,
      ssl: db.ssl,
      via: via === 'exec' ? 'exec' : 'tunnel',
      readonly: target.readonly,
    };
    resolved.db = { password: dbPassword };
  }

  if (kind === 'docker') resolved.config = { ...resolved.config, ...(target.docker || {}) };

  return { resolved, values };
}
