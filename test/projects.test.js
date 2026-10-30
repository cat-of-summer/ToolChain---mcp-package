import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Папка проектов хоста: агент знает путь хоста (O:\Projects\shop), стенд — точку монтирования.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-projects-'));
process.env.TK_ROOT = root;
delete process.env.TK_PROJECTS_ROOT;
process.env.PROJECTS_DIR = 'O:\\Projects';

const ws = await import('../src/workspace.js');
const { PROJECTS } = await import('../src/paths.js');

test('без смонтированной папки пути хоста отвечают понятной ошибкой', () => {
  assert.throws(() => ws.resolve('host:shop', { projects: true }), /не подключена: задайте PROJECTS_DIR/);
  assert.throws(() => ws.resolve('O:/Projects/shop', { projects: true }), /не подключена/);
});

test('путь хоста и host: ведут в одну точку монтирования', () => {
  fs.mkdirSync(path.join(PROJECTS, 'shop', 'src'), { recursive: true });
  const base = fs.realpathSync(PROJECTS);
  const expected = path.join(base, 'shop', 'src');

  assert.equal(ws.resolve('host:shop/src', { projects: true }), expected);
  assert.equal(ws.resolve('O:\\Projects\\shop\\src', { projects: true }), expected);
  assert.equal(ws.resolve('o:/projects/shop/src', { projects: true }), expected, 'буква диска и регистр Windows не важны');
  assert.equal(ws.resolve('O:/Projects', { projects: true }), base);
});

test('без projects: true пути хоста — обычные пути рабочей области', () => {
  const base = fs.realpathSync(ws.ensure());
  assert.equal(ws.resolve('host:shop'), path.join(base, 'host:shop'));
});

test('выход за пределы папки проектов отклоняется', () => {
  assert.throws(() => ws.resolve('host:../state', { projects: true }), /за пределы папки проектов/);
  assert.throws(() => ws.resolve('O:/Projects/shop/../../x', { projects: true }), /за пределы/);
});

test('describe называет файл проекта путём host:, без ссылки на скачивание', () => {
  const file = ws.resolve('host:shop/src/index.php', { projects: true });
  assert.deepEqual(ws.describe(file), { path: 'host:shop/src/index.php' });
});

test('корень папки проектов узнаётся — ws_remove его не снесёт', () => {
  assert.equal(ws.isProjectsRoot(ws.resolve('host:', { projects: true })), true);
  assert.equal(ws.isProjectsRoot(ws.resolve('host:shop', { projects: true })), false);
});
