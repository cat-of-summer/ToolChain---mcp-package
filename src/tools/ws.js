import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { pick } from '../i18n.js';
import { cfg } from '../config.js';
import * as ws from '../workspace.js';

const GROUP = 'ws';

const LIST_MAX = 500;

export const tools = [
  {
    name: 'ws_list',
    group: GROUP,
    mutating: false,
    title: pick({ ru: 'Файлы рабочей области', en: 'Workspace files' }),
    description: pick({
      ru: 'Содержимое каталога рабочей области — места, где выполняется код, куда ложатся загрузки с '
        + `/upload и скачанное с серверов. recursive — всё дерево, до ${LIST_MAX} записей.`,
      en: 'Contents of a workspace directory — where code runs, where /upload uploads and server '
        + `downloads land. recursive — the whole tree, up to ${LIST_MAX} entries.`,
    }),
    input: { path: z.string().optional(), recursive: z.boolean().optional() },
    run: (args) => {
      const dir = ws.resolve(args.path || '.');
      if (!fs.existsSync(dir)) throw new Error(`в рабочей области нет «${args.path}»`);
      if (!fs.statSync(dir).isDirectory()) return { data: ws.stat(dir) };

      const entries = [];
      if (args.recursive) {
        for (const item of ws.walk(dir)) {
          if (entries.length >= LIST_MAX) break;
          entries.push({ path: item.rel, type: item.dir ? 'dir' : 'file', size: item.dir ? undefined : fs.statSync(item.full).size });
        }
      } else {
        for (const name of fs.readdirSync(dir).sort()) {
          if (entries.length >= LIST_MAX) break;
          const st = ws.stat(path.join(dir, name));
          entries.push({ name, type: st.type, size: st.size, mtime: st.mtime });
        }
      }
      return { data: { ...ws.describe(dir), entries, truncated: entries.length >= LIST_MAX } };
    },
  },

  {
    name: 'ws_read',
    group: GROUP,
    mutating: false,
    title: pick({ ru: 'Прочитать файл области', en: 'Read a workspace file' }),
    description: pick({
      ru: 'Текст файла рабочей области с offset и maxBytes — для длинных файлов читайте кусками.',
      en: 'Text of a workspace file with offset and maxBytes — read long files in chunks.',
    }),
    input: {
      path: z.string(),
      offset: z.number().int().nonnegative().optional(),
      maxBytes: z.number().int().positive().optional(),
    },
    run: (args) => {
      const file = ws.resolve(args.path);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`файла «${args.path}» нет`);
      const size = fs.statSync(file).size;
      const offset = Math.min(args.offset || 0, size);
      const take = Math.min(args.maxBytes || cfg.maxTextBytes, cfg.maxTextBytes, size - offset);
      const buf = Buffer.alloc(take);
      const fd = fs.openSync(file, 'r');
      fs.readSync(fd, buf, 0, take, offset);
      fs.closeSync(fd);
      const content = buf.toString('utf8');
      return {
        data: { ...ws.describe(file), size, offset, bytes: take, more: offset + take < size, content },
        stdout: content,
      };
    },
  },

  {
    name: 'ws_write',
    group: GROUP,
    mutating: true,
    title: pick({ ru: 'Записать файл области', en: 'Write a workspace file' }),
    description: pick({
      ru: 'Пишет текст в файл рабочей области, создавая каталоги. append — дописать в конец. Крупные и '
        + 'бинарные файлы с машины человека — через /upload, а не параметром.',
      en: 'Writes text into a workspace file, creating directories. append — add to the end. Large and '
        + 'binary files from the human\'s machine go through /upload, not a parameter.',
    }),
    input: { path: z.string(), content: z.string(), append: z.boolean().optional() },
    run: (args) => {
      const file = ws.resolve(args.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (args.append) fs.appendFileSync(file, args.content);
      else fs.writeFileSync(file, args.content);
      return { data: { ...ws.describe(file), bytes: fs.statSync(file).size } };
    },
  },

  {
    name: 'ws_move',
    group: GROUP,
    mutating: true,
    title: pick({ ru: 'Переместить в области', en: 'Move in the workspace' }),
    description: pick({ ru: 'Переименовывает или переносит файл или каталог рабочей области.', en: 'Renames or moves a workspace file or directory.' }),
    input: { from: z.string(), to: z.string() },
    run: (args) => {
      const from = ws.resolve(args.from);
      const to = ws.resolve(args.to);
      if (!fs.existsSync(from)) throw new Error(`«${args.from}» нет`);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      return { data: { from: args.from, ...ws.describe(to) } };
    },
  },

  {
    name: 'ws_remove',
    group: GROUP,
    mutating: true,
    title: pick({ ru: 'Удалить в области', en: 'Delete in the workspace' }),
    description: pick({
      ru: 'Удаляет файл или каталог рабочей области; каталог с содержимым — с recursive.',
      en: 'Deletes a workspace file or directory; a non-empty directory needs recursive.',
    }),
    input: { path: z.string(), recursive: z.boolean().optional() },
    run: (args) => {
      const target = ws.resolve(args.path);
      if (target === fs.realpathSync(ws.ensure())) throw new Error('корень рабочей области не удаляется — удаляйте его содержимое');
      if (!fs.existsSync(target)) return { data: { removed: false, path: args.path } };
      if (fs.statSync(target).isDirectory()) {
        if (args.recursive) fs.rmSync(target, { recursive: true, force: true });
        else fs.rmdirSync(target);
      } else {
        fs.unlinkSync(target);
      }
      return { data: { removed: true, path: args.path } };
    },
  },

  {
    name: 'ws_link',
    group: GROUP,
    mutating: false,
    title: pick({ ru: 'Ссылка на файл', en: 'File link' }),
    description: pick({
      ru: 'Ссылка, по которой файл рабочей области забирается на машину человека (curl -o), и как '
        + 'загрузить файл в обратную сторону.',
      en: 'A link to fetch a workspace file onto the human\'s machine (curl -o), and how to upload '
        + 'a file the other way.',
    }),
    input: { path: z.string() },
    run: (args) => {
      const file = ws.resolve(args.path);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`файла «${args.path}» нет`);
      const where = ws.describe(file);
      return {
        data: {
          ...where,
          скачать: `curl -fsSL -o ${JSON.stringify(path.basename(file))} ${JSON.stringify(where.url)}`,
          загрузить: `curl -fsS -F file=@<файл> "${cfg.publicBaseUrl}/upload?dir=${encodeURIComponent(path.posix.dirname(where.path))}"`,
        },
      };
    },
  },
];
