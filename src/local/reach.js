// Списки версий mise берёт с mise-versions.jdx.dev. Хост за Cloudflare и доступен не везде:
// там, где его нет, каждый запрос ждёт таймаута, а python не ставится вовсе — список готовых
// сборок есть только там. Поэтому при старте стенд один раз проверяет хост и, если тот не
// отвечает, переключает mise на первоисточники: версии — из GitHub и сайтов языков, python —
// сборкой из исходников (минуты вместо секунд, но работает).
//
// Доступность бывает переменной: хост отвечает, а через час рвёт TLS. Поэтому проверка
// повторяется раз в REPROBE_MS, а сбой самой установки на этом хосте (см. jobs.runForeground)
// сразу помечает его недоступным — задача перезапускается через первоисточники.
//
// Явно заданные в окружении MISE_USE_VERSIONS_HOST и MISE_PYTHON_COMPILE не трогаются.

const HOST = 'https://mise-versions.jdx.dev/';
const TIMEOUT_MS = 4000;
const REPROBE_MS = 15 * 60 * 1000;

/** Признак того, что задача упала именно на хосте версий. */
export const FAILED_ON_HOST = /mise-versions\.jdx\.dev/;

export function markDown() {
  reachable = false;
}

export function watch() {
  probe();
  setInterval(probe, REPROBE_MS).unref();
}

let reachable = null; // null — ещё не проверяли

export async function probe(fetchImpl = globalThis.fetch) {
  const before = reachable;
  try {
    const res = await fetchImpl(HOST, { method: 'HEAD', signal: AbortSignal.timeout(TIMEOUT_MS) });
    reachable = res.status < 500;
  } catch {
    reachable = false;
  }
  if (before !== reachable && (before !== null || !reachable)) {
    console.log(reachable
      ? '[toolkit] mise-versions.jdx.dev снова доступен — mise на обычном пути'
      : '[toolkit] mise-versions.jdx.dev недоступен — mise берёт версии из первоисточников, python собирается из исходников');
  }
  return reachable;
}

export const versionsHost = () => reachable;

/** Добавки к окружению mise: пусто, пока хост доступен или не проверен. */
export function fallbackEnv(env = process.env) {
  if (reachable !== false) return {};
  const out = {};
  if (env.MISE_USE_VERSIONS_HOST === undefined) out.MISE_USE_VERSIONS_HOST = 'false';
  if (env.MISE_PYTHON_COMPILE === undefined) out.MISE_PYTHON_COMPILE = 'true';
  return out;
}

/** Для тестов. */
export function reset(value = null) {
  reachable = value;
}
