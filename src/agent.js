// Кто такой агент — для приватных инструментов: сессия MCP умирает с подключением, а
// «приватно для агента» должно пережить её. Источники по старшинству:
//   - заголовок X-Toolkit-Agent из настроек клиента (claude mcp add … --header) — явное имя;
//   - TK_AGENT — то же для stdio, где заголовков нет;
//   - корень проекта из MCP roots: клиент сам говорит, в каком каталоге работает агент.
// Ничего из этого нет — агент безымянный, и «приватно» ему не предлагается.

const MAX = 200;
const found = new Map(); // sessionId -> { id, source }

/** Имя агента из заголовка: печатные символы, без хвостовых пробелов, с потолком длины. */
export function clean(value) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text ? text.slice(0, MAX) : null;
}

/** file:///o%3A/Projects/shop → O:/Projects/shop; file:///home/me/shop → /home/me/shop. */
export function fromRoot(uri) {
  let url;
  try { url = new URL(uri); } catch { return null; }
  if (url.protocol !== 'file:') return clean(uri);
  let file = decodeURIComponent(url.pathname);
  if (/^\/[A-Za-z]:/.test(file)) file = file[1].toUpperCase() + file.slice(2);
  return clean(file.replace(/\/+$/, '') || '/');
}

/** { id, source: header | env | roots | null } — ищется один раз на сессию. */
export async function agentOf(ctx) {
  if (ctx?.agent) return { id: ctx.agent, source: 'header' };
  const envAgent = clean(process.env.TK_AGENT);
  if (envAgent) return { id: envAgent, source: 'env' };

  const key = ctx?.sessionId || 'stdio';
  if (found.has(key)) return found.get(key);

  let result = { id: null, source: null };
  const server = ctx?.server?.server;
  if (server?.getClientCapabilities?.()?.roots) {
    try {
      const { roots } = await server.listRoots(undefined, { timeout: 5000 });
      const id = roots?.length ? fromRoot(roots[0].uri) : null;
      if (id) result = { id, source: 'roots' };
    } catch {
      return result; // клиент не ответил — спросим в следующий раз, а не запомним «безымянный»
    }
  }
  found.set(key, result);
  return result;
}

export function forget(sessionId) {
  found.delete(sessionId || 'stdio');
}
