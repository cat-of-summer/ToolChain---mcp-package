import path from 'node:path';
import { connect, sftp } from './ssh.js';
import { make as makeSftp } from './sftp.js';
import { open as openFtp } from './ftp.js';

// Путь в аргументах инструмента считается относительно root цели, если он задан и путь
// не абсолютный. Абсолютный путь уходит как есть: root избавляет от повторного ввода
// одного и того же префикса, а не строит клетку.
export function resolvePath(resolved, target) {
  const root = resolved.config.root;
  const value = String(target ?? '.');
  if (!root) return value;
  if (value.startsWith('/')) return value;
  return path.posix.join(root, value);
}

/**
 * Создаёт каталог вместе с недостающими родителями. sftp умеет только один уровень,
 * ftp — сразу дерево; уравниваем, чтобы у инструмента было одно поведение на оба протокола.
 */
export async function mkdirp(api, target) {
  const parts = String(target).split('/').filter(Boolean);
  const created = [];
  let current = target.startsWith('/') ? '' : '.';

  for (const part of parts) {
    current = current === '.' ? part : `${current}/${part}`;
    try {
      await api.mkdir(current);
      created.push(current);
    } catch {
      // Уже есть или создан параллельно — проверим в конце по stat.
    }
  }

  await api.stat(target);
  return created;
}

/**
 * Раздаёт задачи исполнителям: каждый берёт следующую, как освободится. Задача получает
 * своего исполнителя и может вернуть новые задачи — так каталог добавляет в очередь своё
 * содержимое. Первая ошибка или отмена вызова останавливает раздачу; начатое доделывается.
 */
export async function drain(workers, tasks, { signal } = {}) {
  const queue = [...tasks];
  let busy = 0;
  let error = null;
  const waiting = [];
  const wake = () => { for (const resolve of waiting.splice(0)) resolve(); };
  const onAbort = () => { error ??= signal.reason ?? new Error('вызов отменён'); wake(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  const work = async (worker) => {
    while (!error) {
      const task = queue.shift();
      if (!task) {
        if (busy === 0) return;
        await new Promise((resolve) => waiting.push(resolve));
        continue;
      }
      busy++;
      try {
        const more = await task(worker);
        if (more?.length) queue.push(...more);
      } catch (err) {
        error ??= err;
      } finally {
        busy--;
        wake();
      }
    }
  };

  try {
    await Promise.all(workers.map(work));
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (error) throw error;
}

/**
 * fn получает api и pool(n): до n исполнителей для drain, первый из них — сам api. Через
 * FTP по одному соединению файлы идут строго друг за другом, и на каждый уходят PASV, новое
 * соединение данных и ожидание 226 — для темы в сотни файлов это минуты. Поэтому для FTP
 * pool открывает дополнительные соединения; кого сервер не пустил (лимит на пользователя),
 * того просто нет. sftp держит параллельные запросы в одном канале, ему хватает одного api.
 */
export async function withFiles(resolved, { approveHostKey } = {}, fn) {
  if (resolved.config.proto === 'sftp') {
    const client = await connect(resolved.host, { approveHostKey });
    const handle = await sftp(client);
    const api = makeSftp(handle);
    try {
      return await fn(api, { pool: async (n) => Array(Math.max(1, n)).fill(api) });
    } finally {
      // Закрывается только канал sftp: само соединение живёт в пуле и ещё пригодится.
      await api.close();
    }
  }

  const api = await openFtp(resolved.ftp);
  const extra = [];
  const pool = async (n) => {
    const opened = await Promise.allSettled(Array.from({ length: Math.max(0, n - 1 - extra.length) }, () => openFtp(resolved.ftp)));
    extra.push(...opened.filter((res) => res.status === 'fulfilled').map((res) => res.value));
    return [api, ...extra];
  };
  try {
    return await fn(api, { pool });
  } finally {
    await Promise.all([api, ...extra].map((one) => one.close()));
  }
}
