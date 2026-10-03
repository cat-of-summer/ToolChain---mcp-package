import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { pick } from '../i18n.js';
import { cfg } from '../config.js';
import { connParam } from '../target.js';
import { withFiles, resolvePath, mkdirp } from '../transport/files.js';
import * as ws from '../workspace.js';

const GROUP = 'files';

// Файлы сервера ↔ рабочая область. Содержимое не ходит через контекст модели: забранное
// с сервера ложится в область, на сервер уходит из области. Дальше с ним работает код
// (exec, run_code) по относительному пути, а человеку оно отдаётся ссылкой /files/….

/** Скачивает каталог сервера целиком. Симлинки не раскрываются: дерево может зациклиться. */
async function getTree(api, remote, local, stats) {
  fs.mkdirSync(local, { recursive: true });
  for (const entry of await api.list(remote)) {
    if (entry.name === '.' || entry.name === '..' || entry.link) continue;
    const from = path.posix.join(remote, entry.name);
    const to = path.join(local, entry.name);
    if (entry.dir) {
      await getTree(api, from, to, stats);
    } else {
      await api.downloadTo(from, fs.createWriteStream(to));
      stats.files++;
      stats.bytes += fs.statSync(to).size;
    }
  }
}

async function putTree(api, local, remote, stats) {
  await mkdirp(api, remote);
  for (const item of ws.walk(local)) {
    const dest = path.posix.join(remote, item.rel);
    if (item.dir) {
      await mkdirp(api, dest);
    } else {
      await api.writeStream(dest, fs.createReadStream(item.full));
      stats.files++;
      stats.bytes += fs.statSync(item.full).size;
    }
  }
}

export const tools = [
  {
    name: 'files_list',
    group: GROUP,
    remote: 'files',
    mutating: false,
    title: pick({ ru: 'Список файлов на сервере', en: 'List server files' }),
    description: pick({
      ru: 'Содержимое каталога на сервере (sftp или ftp/ftps): имена, размеры, права, даты. Относительный '
        + 'путь считается от root цели, абсолютный уходит как есть.',
      en: 'Directory contents on the server (sftp or ftp/ftps): names, sizes, permissions, dates. A relative '
        + 'path is taken from the target root, an absolute one is used as is.',
    }),
    input: { conn: connParam, path: z.string().optional() },
    run: async (args, { resolved, approveHostKey }) => {
      const target = resolvePath(resolved, args.path ?? '.');
      const entries = await withFiles(resolved, { approveHostKey }, (api) => api.list(target));
      return { data: { path: target, entries } };
    },
  },

  {
    name: 'files_stat',
    group: GROUP,
    remote: 'files',
    mutating: false,
    title: pick({ ru: 'Сведения о файле на сервере', en: 'Server file info' }),
    description: pick({ ru: 'Размер, права и время изменения одного файла.', en: 'Size, permissions and mtime of a single file.' }),
    input: { conn: connParam, path: z.string() },
    run: async (args, { resolved, approveHostKey }) => {
      const target = resolvePath(resolved, args.path);
      return { data: await withFiles(resolved, { approveHostKey }, (api) => api.stat(target)) };
    },
  },

  {
    name: 'files_read',
    group: GROUP,
    remote: 'files',
    mutating: false,
    title: pick({ ru: 'Прочитать файл на сервере', en: 'Read a server file' }),
    description: pick({
      ru: 'Возвращает содержимое текстового файла, обрезанное по maxBytes. Целый или бинарный файл — '
        + 'files_get в рабочую область.',
      en: 'Returns the contents of a text file, cut at maxBytes. For a whole or binary file use files_get '
        + 'into the workspace.',
    }),
    input: { conn: connParam, path: z.string(), maxBytes: z.number().int().positive().optional() },
    run: async (args, { resolved, approveHostKey }) => {
      const target = resolvePath(resolved, args.path);
      const maxBytes = Math.min(args.maxBytes || cfg.maxTextBytes, cfg.maxTextBytes);
      const res = await withFiles(resolved, { approveHostKey }, (api) => api.read(target, { maxBytes }));
      const content = res.content.toString('utf8');
      return { data: { path: target, bytes: res.bytes, truncated: res.truncated, content }, stdout: content };
    },
  },

  {
    name: 'files_get',
    group: GROUP,
    remote: 'files',
    mutating: false,
    title: pick({ ru: 'Скачать в рабочую область', en: 'Download into the workspace' }),
    description: pick({
      ru: 'Скачивает файл или каталог (рекурсивно) с сервера в рабочую область. Дальше с ним работает '
        + 'код по относительному пути, человеку он отдаётся ссылкой из ответа.',
      en: 'Downloads a file or a directory (recursively) from the server into the workspace. Code then '
        + 'works with it by relative path; the human gets it by the link in the reply.',
    }),
    input: {
      conn: connParam,
      path: z.string(),
      to: z.string().optional().describe(pick({
        ru: 'путь в рабочей области; по умолчанию downloads/<имя>',
        en: 'workspace path; defaults to downloads/<name>',
      })),
    },
    run: async (args, { resolved, approveHostKey }) => {
      const remote = resolvePath(resolved, args.path);
      const local = ws.resolve(args.to || `downloads/${ws.safeName(path.posix.basename(remote))}`);
      const stats = { files: 0, bytes: 0 };

      await withFiles(resolved, { approveHostKey }, async (api) => {
        const info = await api.stat(remote);
        if (info.dir) return getTree(api, remote, local, stats);
        fs.mkdirSync(path.dirname(local), { recursive: true });
        await api.downloadTo(remote, fs.createWriteStream(local));
        stats.files = 1;
        stats.bytes = fs.statSync(local).size;
        return null;
      });

      return { data: { from: remote, ...ws.describe(local), ...stats } };
    },
  },

  {
    name: 'files_put',
    group: GROUP,
    remote: 'files',
    mutating: true,
    title: pick({ ru: 'Отправить на сервер', en: 'Upload to the server' }),
    description: pick({
      ru: 'Кладёт на сервер файл или каталог (рекурсивно) из рабочей области — from, — либо маленький '
        + 'текст из content. Файл с машины человека сначала загружают на /upload стенда.',
      en: 'Puts a file or a directory (recursively) from the workspace — from — or a small text from '
        + 'content onto the server. A file from the human\'s machine is first uploaded to /upload.',
    }),
    input: {
      conn: connParam,
      dest: z.string().describe(pick({ ru: 'путь на сервере', en: 'path on the server' })),
      from: z.string().optional().describe(pick({ ru: 'путь в рабочей области', en: 'workspace path' })),
      content: z.string().optional(),
    },
    summary: (args, info) => `Положить на «${info.label}»: ${args.from ? `${args.from} → ` : ''}${args.dest}`,
    details: (args) => ({ источник: args.from || 'текст в параметре content' }),
    run: async (args, { resolved, approveHostKey }) => {
      const dest = resolvePath(resolved, args.dest);
      if (!args.from && args.content === undefined) throw new Error('нечего класть: передайте from (путь в рабочей области) или content');

      const stats = { files: 0, bytes: 0 };
      await withFiles(resolved, { approveHostKey }, async (api) => {
        if (!args.from) {
          await api.write(dest, Buffer.from(args.content, 'utf8'));
          stats.files = 1;
          stats.bytes = Buffer.byteLength(args.content);
          return;
        }
        const local = ws.resolve(args.from);
        if (!fs.existsSync(local)) throw new Error(`в рабочей области нет «${args.from}»`);
        if (fs.statSync(local).isDirectory()) return putTree(api, local, dest, stats);
        await api.writeStream(dest, fs.createReadStream(local));
        stats.files = 1;
        stats.bytes = fs.statSync(local).size;
      });

      return { data: { dest, ...stats }, command: `put ${args.from || '(content)'} → ${dest}` };
    },
  },

  {
    name: 'files_move',
    group: GROUP,
    remote: 'files',
    mutating: true,
    title: pick({ ru: 'Переместить на сервере', en: 'Move on the server' }),
    description: pick({ ru: 'Переименовывает или переносит файл на сервере.', en: 'Renames or moves a file on the server.' }),
    input: { conn: connParam, from: z.string(), to: z.string() },
    summary: (args, info) => `Переместить на «${info.label}»: ${args.from} → ${args.to}`,
    run: async (args, { resolved, approveHostKey }) => {
      const from = resolvePath(resolved, args.from);
      const to = resolvePath(resolved, args.to);
      await withFiles(resolved, { approveHostKey }, (api) => api.move(from, to));
      return { data: { from, to }, command: `mv ${from} ${to}` };
    },
  },

  {
    name: 'files_remove',
    group: GROUP,
    remote: 'files',
    mutating: true,
    title: pick({ ru: 'Удалить на сервере', en: 'Delete on the server' }),
    description: pick({
      ru: 'Удаляет файл или пустой каталог. Рекурсивного удаления здесь нет намеренно: снести дерево — '
        + 'это ssh_exec, где команда видна человеку целиком.',
      en: 'Deletes a file or an empty directory. No recursive delete on purpose: wiping a tree is ssh_exec, '
        + 'where the human sees the whole command.',
    }),
    input: { conn: connParam, path: z.string(), dir: z.boolean().optional() },
    summary: (args, info) => `Удалить на «${info.label}»: ${args.path}`,
    run: async (args, { resolved, approveHostKey }) => {
      const target = resolvePath(resolved, args.path);
      await withFiles(resolved, { approveHostKey }, (api) => (args.dir ? api.rmdir(target) : api.remove(target)));
      return { data: { removed: target }, command: `rm ${target}` };
    },
  },

  {
    name: 'files_mkdir',
    group: GROUP,
    remote: 'files',
    mutating: true,
    title: pick({ ru: 'Создать каталог на сервере', en: 'Create a server directory' }),
    description: pick({
      ru: 'Создаёт каталог вместе с недостающими родителями. Существующий каталог ошибкой не считается.',
      en: 'Creates a directory with missing parents. An existing directory is not an error.',
    }),
    input: { conn: connParam, path: z.string() },
    summary: (args, info) => `Создать каталог на «${info.label}»: ${args.path}`,
    run: async (args, { resolved, approveHostKey }) => {
      const target = resolvePath(resolved, args.path);
      const created = await withFiles(resolved, { approveHostKey }, (api) => mkdirp(api, target));
      return { data: { path: target, created }, command: `mkdir -p ${target}` };
    },
  },

  {
    name: 'files_chmod',
    group: GROUP,
    remote: 'files',
    mutating: true,
    title: pick({ ru: 'Сменить права на сервере', en: 'Change server permissions' }),
    description: pick({ ru: 'Права восьмеричным числом, например 644 или 755.', en: 'Octal permissions, e.g. 644 or 755.' }),
    input: { conn: connParam, path: z.string(), mode: z.string().describe('644') },
    summary: (args, info) => `Сменить права на «${info.label}»: ${args.path} → ${args.mode}`,
    run: async (args, { resolved, approveHostKey }) => {
      const target = resolvePath(resolved, args.path);
      const mode = parseInt(args.mode, 8);
      if (Number.isNaN(mode)) throw new Error(`права «${args.mode}» не восьмеричное число`);
      await withFiles(resolved, { approveHostKey }, (api) => api.chmod(target, mode));
      return { data: { path: target, mode: args.mode }, command: `chmod ${args.mode} ${target}` };
    },
  },
];
