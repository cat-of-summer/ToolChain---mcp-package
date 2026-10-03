// Разрешения живут в памяти и ровно столько, сколько живёт сессия MCP. На диск они
// не ложатся намеренно: «разрешено до конца сессии» должно кончаться вместе с ней.
// Отказ запоминается наравне с согласием: второй раз о том же не спрашиваем.

const sessions = new Map(); // sessionId -> { hosts: Map<host, 'granted'|'denied'>, since }

export const STDIO_SESSION = 'stdio';

function state(sessionId) {
  const key = sessionId || STDIO_SESSION;
  let found = sessions.get(key);
  if (!found) {
    found = { hosts: new Map(), since: new Date().toISOString() };
    sessions.set(key, found);
  }
  return found;
}

/** @returns 'granted' | 'denied' | undefined */
export const get = (sessionId, host) => state(sessionId).hosts.get(host);

export function set(sessionId, host, granted) {
  state(sessionId).hosts.set(host, granted ? 'granted' : 'denied');
  return granted;
}

export function forget(sessionId) {
  sessions.delete(sessionId || STDIO_SESSION);
}

/** Что сейчас разрешено — это же показывает toolkit_info. */
export function snapshot(sessionId) {
  const current = state(sessionId);
  const hosts = Object.fromEntries([...current.hosts].map(([host, value]) => [
    host, value === 'granted' ? 'запись разрешена' : 'запись запрещена',
  ]));
  return { сессияС: current.since, хосты: hosts };
}

export const sessionCount = () => sessions.size;
