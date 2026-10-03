// Единственное место, где читается окружение. Всё остальное берёт значения отсюда:
// иначе умолчание «сколько ждать подтверждения» разъезжается по трём файлам.

const int = (name, def) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
};

const str = (name, def = '') => {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? def : raw;
};

export const cfg = {
  lang: str('TK_LANG', 'ru'),
  port: int('MCP_PORT', 8933),
  publicBaseUrl: str('PUBLIC_BASE_URL', `http://127.0.0.1:${int('MCP_PORT', 8933)}`),

  // Подтверждения записи на удалённые хосты: host — раз на хост за сессию, off — не спрашивать.
  approval: str('TK_APPROVAL', 'host'),
  approveTimeoutMs: int('TK_APPROVE_TIMEOUT', 300) * 1000,

  // Резолвер ссылок secret://… — сервис секретов. Пока не задан, ссылки отклоняются.
  secretResolverUrl: str('TK_SECRET_RESOLVER_URL'),
  secretResolverToken: str('TK_SECRET_RESOLVER_TOKEN'),
  secretResolverTimeoutMs: int('TK_SECRET_RESOLVER_TIMEOUT', 10) * 1000,

  // Журнал
  logMaxBytes: int('TK_LOG_MAX_BYTES', 1024 * 1024 * 1024),
  logFileBytes: int('TK_LOG_FILE_BYTES', 64 * 1024 * 1024),
  logInlineBytes: int('TK_LOG_INLINE_BYTES', 256 * 1024),

  // Потолки ответов агенту
  maxTextBytes: int('TK_MAX_TEXT_BYTES', 128 * 1024),
  dbMaxRows: int('TK_DB_MAX_ROWS', 500),
  maxUploadBytes: int('TK_MAX_UPLOAD_BYTES', 256 * 1024 * 1024),
  // Потолок вывода одной команды в памяти: без него cat большого файла кладёт сервер
  maxOutputBytes: int('TK_MAX_OUTPUT_BYTES', 32 * 1024 * 1024),

  // Транспорт
  sshIdleMs: int('TK_SSH_IDLE_MS', 300_000),
  execTimeoutMs: int('TK_EXEC_TIMEOUT', 120_000),

  // Рабочая среда. Сколько вызов ждёт команду, прежде чем отдать её в фон задачей:
  // клиенты MCP обрывают долгие вызовы, а сборка php длится минуты.
  foregroundMs: int('TK_FOREGROUND_TIMEOUT', 50) * 1000,
  // Сколько живут завершённые задачи и их логи
  jobsKeep: int('TK_JOBS_KEEP', 200),

  // Проверка обновлений
  updateCheck: str('TK_UPDATE_CHECK', '1') !== '0',
  updateRepo: str('TK_UPDATE_REPO', 'cat-of-summer/Toolkit---mcp-package'),
  updateImage: str('TK_UPDATE_IMAGE', 'ghcr.io/cat-of-summer/toolkit---mcp-package'),
};

/**
 * Версия стенда — это тег образа, и источник у него ровно один: BUNDLE_IMAGE из .env, тот самый
 * ref, который правят руками при обновлении.
 */
export function imageTag(ref = process.env.BUNDLE_IMAGE) {
  const value = String(ref ?? '').trim();
  if (!value) return null;

  // Дайджест сильнее тега: ghcr.io/owner/app@sha256:… тега не несёт вовсе.
  const name = value.split('@')[0];
  const colon = name.lastIndexOf(':');
  if (colon < 0) return null;

  // Двоеточие в имени реестра — это порт (localhost:5000/app), а не тег: у тега слешей нет.
  const tag = name.slice(colon + 1);
  return tag && !tag.includes('/') ? tag : null;
}

cfg.version = imageTag() ?? 'unknown';

export default cfg;
