import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from './config.js';
import { DIRS, PROJECTS, TOOLS_BIN } from './paths.js';

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

/** Подключена ли папка проектов хоста: смонтирована (PROJECTS_DIR) и не пуста. */
export function projectsMounted() {
  try {
    return fs.readdirSync(PROJECTS).some((name) => name !== '.gitkeep');
  } catch {
    return false;
  }
}

/**
 * Путь в папке проектов хоста или null, если путь не о ней. Принимает «host:shop/src» и
 * путь хоста, который знает агент: при PROJECTS_DIR=O:/Projects — «O:\Projects\shop\src».
 */
function projectPath(raw) {
  let rel = null;
  if (raw.startsWith('host:')) rel = raw.slice('host:'.length);
  else if (cfg.projectsHost) {
    const prefix = cfg.projectsHost.replace(/\\/g, '/').replace(/\/+$/, '');
    // Буква диска Windows регистра не различает: o:/projects и O:/Projects — одно.
    const same = /^[A-Za-z]:/.test(prefix) ? raw.toLowerCase() : raw;
    const head = /^[A-Za-z]:/.test(prefix) ? prefix.toLowerCase() : prefix;
    if (same === head || same.startsWith(`${head}/`)) rel = raw.slice(prefix.length);
  }
  if (rel === null) return null;

  if (!projectsMounted()) {
    throw new Error('папка проектов хоста не подключена: задайте PROJECTS_DIR в .env стенда и пересоздайте контейнер');
  }
  const base = fs.realpathSync(PROJECTS);
  const file = path.resolve(base, `.${rel.startsWith('/') ? '' : '/'}${rel}`);
  if (!inside(base, file) || !inside(base, realOfExisting(file))) {
    throw new Error(`путь «${raw}» выходит за пределы папки проектов`);
  }
  return file;
}

/**
 * Путь агента → абсолютный путь в области. Принимает «a/b.txt», «/a/b.txt» (ведущий
 * слеш — от корня области, а не контейнера) и «ws:a/b.txt». С projects: true — и файлы
 * проектов хоста (host:…, путь хоста под PROJECTS_DIR): так exec работает прямо в проекте.
 * Ссылки /files/… и /upload остаются только для рабочей области.
 */
export function resolve(value = '.', { projects = false } = {}) {
  if (projects) {
    const found = projectPath(String(value ?? '.').replace(/\\/g, '/'));
    if (found) return found;
  }
  const raw = String(value ?? '.').replace(/^ws:/, '').replace(/\\/g, '/');
  const base = fs.realpathSync(ensure());
  const file = path.resolve(base, `.${raw.startsWith('/') ? '' : '/'}${raw}`);

  if (!inside(base, file) || !inside(base, realOfExisting(file))) {
    throw new Error(`путь «${value}» выходит за пределы рабочей области`);
  }
  return file;
}

export const isProjectsRoot = (file) => fs.existsSync(PROJECTS) && file === fs.realpathSync(PROJECTS);

export function ensure() {
  fs.mkdirSync(DIRS.workspace, { recursive: true });
  return DIRS.workspace;
}

/** Абсолютный путь в области → то, что видит агент: относительный путь и ссылка. */
export function describe(file) {
  // Файл проекта хоста — его путь host:…; ссылки на скачивание у него нет: он и так на машине человека.
  if (fs.existsSync(PROJECTS) && inside(fs.realpathSync(PROJECTS), file)) {
    return { path: `host:${path.relative(fs.realpathSync(PROJECTS), file).split(path.sep).join('/')}` };
  }
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
