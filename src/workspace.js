import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from './config.js';
import { DIRS, TOOLS_BIN } from './paths.js';

// Рабочая область — единственное место обмена файлами. Загрузка с машины человека
// (/upload), скачанное с сервера (files_get), дамп базы, вывод команды — всё ложится
// сюда, и всё отсюда же забирается: кодом по относительному пути, на сервер через
// files_put, на машину человека ссылкой /files/….
//
// Путь агента всегда относительный к корню области. Абсолютный путь контейнера и
// выход через «..» или симлинк отклоняются: область — не окно в файловую систему
// сервера, на котором лежат журнал и состояние.

export const root = () => DIRS.workspace;

const inside = (base, file) => {
  const rel = path.relative(base, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Ближайший существующий предок пути — по нему проверяется, куда ведут симлинки. */
function realOfExisting(file) {
  let current = file;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return path.join(fs.realpathSync(current), path.relative(current, file));
}

/**
 * Путь агента → абсолютный путь в области. Принимает «a/b.txt», «/a/b.txt» (ведущий
 * слеш — от корня области, а не контейнера) и «ws:a/b.txt».
 */
export function resolve(value = '.') {
  const raw = String(value ?? '.').replace(/^ws:/, '').replace(/\\/g, '/');
  const base = fs.realpathSync(ensure());
  const file = path.resolve(base, `.${raw.startsWith('/') ? '' : '/'}${raw}`);

  if (!inside(base, file) || !inside(base, realOfExisting(file))) {
    throw new Error(`путь «${value}» выходит за пределы рабочей области`);
  }
  return file;
}

export function ensure() {
  fs.mkdirSync(DIRS.workspace, { recursive: true });
  return DIRS.workspace;
}

/** Абсолютный путь в области → то, что видит агент: относительный путь и ссылка. */
export function describe(file) {
  const base = fs.realpathSync(ensure());
  const rel = path.relative(base, file).split(path.sep).join('/');
  return {
    path: rel || '.',
    url: `${cfg.publicBaseUrl}/files/${rel.split('/').map(encodeURIComponent).join('/')}`,
  };
}

const SAFE = /[^\p{L}\p{N}._-]+/gu;

export function safeName(name) {
  const base = path.basename(String(name || 'file')).replace(SAFE, '_');
  return base.slice(0, 120) || 'file';
}

export function stamp() {
  return `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}_${crypto.randomBytes(2).toString('hex')}`;
}

/**
 * Файл под результат (вывод команды, дамп). Явный путь агента уважается, без него —
 * служебный каталог .tk/<вид>/<метка>/<имя>, чтобы результаты не сыпались в корень.
 */
export function output(kind, name, explicit) {
  const file = explicit ? resolve(explicit) : resolve(`.tk/${kind}/${stamp()}/${safeName(name)}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

export function stat(file) {
  const st = fs.lstatSync(file);
  return {
    ...describe(file),
    type: st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file',
    size: st.size,
    mode: (st.mode & 0o7777).toString(8).padStart(4, '0'),
    mtime: st.mtime.toISOString(),
  };
}

/** Обходит каталог области, отдаёт файлы с путями относительно него. Симлинки не раскрывает. */
export function* walk(dir, prefix = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      yield { rel, full, dir: true };
      yield* walk(full, rel);
    } else if (entry.isFile()) {
      yield { rel, full, dir: false };
    }
  }
}

/** Описание скрипта — первая строка-комментарий после шебанга. */
function summaryOf(file) {
  let head = '';
  try { head = fs.readFileSync(file, 'utf8').slice(0, 2048); } catch { return null; }
  const lines = head.split('\n').slice(0, 5);
  if (lines[0]?.startsWith('#!')) lines.shift();
  const line = lines.find((l) => /^\s*(#|\/\/|--)/.test(l));
  return line ? line.replace(/^\s*(#+|\/\/+|--)\s*/, '').trim() || null : null;
}

/** Инструменты, которые агент написал себе: tools/bin с описаниями. */
export function ownTools() {
  const dir = path.join(DIRS.workspace, TOOLS_BIN);
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
  } catch {
    return []; // каталога ещё нет
  }
  return names.map((name) => ({ name, about: summaryOf(path.join(dir, name)) }));
}
