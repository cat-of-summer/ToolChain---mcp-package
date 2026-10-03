import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-ws-'));
process.env.TK_ROOT = root;

const ws = await import('../src/workspace.js');
const base = fs.realpathSync(ws.ensure());

test('относительный путь и путь с ведущим слешем — от корня области', () => {
  assert.equal(ws.resolve('a/b.txt'), path.join(base, 'a', 'b.txt'));
  assert.equal(ws.resolve('/a/b.txt'), path.join(base, 'a', 'b.txt'));
  assert.equal(ws.resolve('ws:a/b.txt'), path.join(base, 'a', 'b.txt'));
  assert.equal(ws.resolve('.'), base);
  assert.equal(ws.resolve('a\\b.txt'), path.join(base, 'a', 'b.txt'), 'обратный слеш из Windows — разделитель');
});

test('выход за пределы области отклоняется', () => {
  assert.throws(() => ws.resolve('../etc/passwd'), /за пределы/);
  assert.throws(() => ws.resolve('a/../../x'), /за пределы/);
});

test('симлинк наружу отклоняется', { skip: process.platform === 'win32' }, () => {
  fs.symlinkSync('/etc', path.join(base, 'out'));
  assert.throws(() => ws.resolve('out/passwd'), /за пределы/);
  assert.throws(() => ws.resolve('out/new-file'), /за пределы/, 'и для ещё не созданного файла');
});

test('describe даёт относительный путь и ссылку', () => {
  const where = ws.describe(path.join(base, 'dumps', 'shop.sql'));
  assert.equal(where.path, 'dumps/shop.sql');
  assert.match(where.url, /\/files\/dumps\/shop\.sql$/);
});

test('безопасное имя сохраняет кириллицу и режет разделители', () => {
  assert.equal(ws.safeName('Отчёт за май.pdf'), 'Отчёт_за_май.pdf');
  assert.equal(ws.safeName('../../etc/passwd'), 'passwd');
});

test('output кладёт результат в служебный каталог или по явному пути', () => {
  const auto = ws.output('ssh', 'stdout.txt');
  assert.ok(ws.describe(auto).path.startsWith('.tk/ssh/'));
  const explicit = ws.output('ssh', 'stdout.txt', 'logs/out.txt');
  assert.equal(ws.describe(explicit).path, 'logs/out.txt');
  assert.ok(fs.existsSync(path.dirname(explicit)));
});
