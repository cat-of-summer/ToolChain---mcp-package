import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Корень — каталог, где лежит код (/var/www/html), а не cwd: `docker exec … tk`
// запускается откуда угодно. Всё состояние лежит в подкаталогах, и каждый из них
// смонтирован томом: пересоздание контейнера и docker pull их не задевают.
// TK_ROOT переопределяет корень — им пользуются тесты.
export const ROOT = process.env.TK_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DIRS = {
  // Рабочая область агента: сюда приходят загрузки, отсюда уходят файлы на серверы,
  // здесь же выполняется код. Реальные папки машины человека сюда не монтируются.
  workspace: process.env.TK_WORKSPACE || path.join(ROOT, 'workspace'),
  state: path.join(ROOT, 'state'),
  jobs: path.join(ROOT, 'state', 'jobs'),
  logs: path.join(ROOT, 'logs'),
  blobs: path.join(ROOT, 'logs', 'blobs'),
};

export const KNOWN_HOSTS = path.join(DIRS.state, 'known_hosts.json');

// Инструменты, которые агент пишет себе сам: каталог рабочей области в PATH команд стенда.
export const TOOLS_BIN = 'tools/bin';

export function ensureDirs() {
  for (const dir of Object.values(DIRS)) fs.mkdirSync(dir, { recursive: true });
}

export default { ROOT, DIRS, KNOWN_HOSTS, TOOLS_BIN, ensureDirs };
