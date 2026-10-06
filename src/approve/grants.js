// Разрешения живут в памяти и ровно столько, сколько живёт сессия MCP. На диск они
// не ложатся намеренно: «разрешено до конца сессии» должно кончаться вместе с ней.
// Отказ запоминается наравне с согласием: второй раз о том же не спрашиваем.
//
// Ключ — доступ user@host: под одним адресом бывают пользователи с разными правами,
// и разрешение одному не открывает другого. Уровней два: чтение и запись (запись
// включает чтение). У каждого — true, false (отказано) или undefined (не спрашивали).

const sessions = new Map(); // sessionId -> { access: Map<key, { read, write }>, since }

export const STDIO_SESSION = 'stdio';
export const LEVELS = ['read', 'write'];

function state(sessionId) {
  const key = sessionId || STDIO_SESSION;
  let found = sessions.get(key);
  if (!found) {
    found = { access: new Map(), since: new Date().toISOString() };
    sessions.set(key, found);
  }
  return found;
}

function entry(sessionId, key) {
  const access = state(sessionId).access;
  if (!access.has(key)) access.set(key, { read: undefined, write: undefined });
  return access.get(key);
}

/** @returns { read, write } — true, false или undefined у каждого уровня */
export const get = (sessionId, key) => ({ read: undefined, write: undefined, ...state(sessionId).access.get(key) });

/** Выдаёт уровень; запись заодно выдаёт и чтение. */
export function grant(sessionId, key, level) {
  const current = entry(sessionId, key);
  current.read = true;
  if (level === 'write') current.write = true;
}

/** Запрещает уровень; запрет чтения закрывает и запись. */
export function deny(sessionId, key, level) {
  const current = entry(sessionId, key);
  current.write = false;
  if (level === 'read') current.read = false;
}

export function forget(sessionId) {
  sessions.delete(sessionId || STDIO_SESSION);
}

function describeAccess({ read, write }) {
  if (write) return 'чтение и запись';
  if (read === false) return 'доступ запрещён';
  if (read && write === false) return 'чтение; запись запрещена';
  if (read) return 'чтение';
  return 'запись запрещена';
}

/** Что сейчас разрешено — это же показывает toolkit_info. */
export function snapshot(sessionId) {
  const current = state(sessionId);
  const access = Object.fromEntries([...current.access].map(([key, value]) => [key, describeAccess(value)]));
  return { сессияС: current.since, доступ: access };
}

export const sessionCount = () => sessions.size;
