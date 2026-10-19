import test from 'node:test';
import assert from 'node:assert/strict';
import { withVars } from '../src/transport/ssh.js';
import { drain } from '../src/transport/files.js';
import { scrubber, scrubDeep } from '../src/secrets.js';

test('переменные уезжают в stdin, в строке команды только имена', () => {
  const res = withVars("cd '/srv' && mysql -e 'select 1'", { MYSQL_PWD: 'секрет-базы', LANG: 'C' }, 'данные');

  assert.equal(res.command, "{ IFS= read -r MYSQL_PWD && export MYSQL_PWD && IFS= read -r LANG && export LANG; } && cd '/srv' && mysql -e 'select 1'");
  assert.equal(res.stdin, 'секрет-базы\nC\nданные');
  assert.equal(res.command.includes('секрет-базы'), false);
});

test('без переменных команда и stdin не трогаются', () => {
  assert.deepEqual(withVars('ls', undefined, undefined), { command: 'ls', stdin: undefined });
  assert.deepEqual(withVars('ls', {}, 'x'), { command: 'ls', stdin: 'x' });
});

test('негодное имя и многострочное значение отклоняются', () => {
  assert.throws(() => withVars('ls', { 'A;rm': '1' }), /не годится/);
  assert.throws(() => withVars('ls', { KEY: 'a\nb' }), /многострочное/);
});

test('потоковая чистка ловит секрет на границе кусков', () => {
  const secret = 'пароль-базы-42';
  const text = Buffer.from(`начало ${secret} середина ${secret} конец`, 'utf8');

  // Режем на куски по 3 байта: секрет гарантированно разрезан, и не раз, и посреди буквы.
  for (const size of [1, 3, 7, 1000]) {
    const clean = scrubber([secret]);
    const parts = [];
    for (let i = 0; i < text.length; i += size) parts.push(clean.push(text.subarray(i, i + size)));
    parts.push(clean.end());
    const out = Buffer.concat(parts).toString('utf8');

    assert.equal(out, 'начало •••• середина •••• конец', `кусками по ${size}`);
  }
});

test('без секретов поток идёт как есть', () => {
  const clean = scrubber([]);
  const chunk = Buffer.from('abc');
  assert.equal(clean.push(chunk), chunk);
  assert.equal(clean.end().length, 0);
});

test('ответ целиком чистится по строкам, структура остаётся', () => {
  const out = scrubDeep({ stdout: 'pw=hunter22', rows: [['hunter22', 1]], n: 5 }, ['hunter22']);
  assert.deepEqual(out, { stdout: 'pw=••••', rows: [['••••', 1]], n: 5 });
});

test('drain: задачи расходятся по исполнителям, каталог добавляет своё содержимое', async () => {
  const seen = [];
  let running = 0;
  let peak = 0;
  const leaf = (name) => async (worker) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    seen.push(`${worker}:${name}`);
    running--;
  };
  const dir = async () => ['a', 'b', 'c', 'd', 'e', 'f'].map(leaf);

  await drain(['w1', 'w2', 'w3'], [dir]);

  assert.equal(seen.length, 6);
  assert.equal(peak, 3, 'разом работают все исполнители, но не больше');
  assert.ok(new Set(seen.map((s) => s.split(':')[0])).size > 1);
});

test('drain: первая ошибка останавливает раздачу', async () => {
  let started = 0;
  const ok = async () => { started++; await new Promise((resolve) => setTimeout(resolve, 5)); };
  const bad = async () => { started++; throw new Error('сервер оборвал'); };

  await assert.rejects(drain(['w1'], [ok, bad, ok, ok]), /сервер оборвал/);
  assert.equal(started, 2);
});

test('drain: отмена вызова останавливает раздачу', async () => {
  const ctrl = new AbortController();
  let done = 0;
  const task = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    done++;
    if (done === 2) ctrl.abort(new Error('клиент бросил вызов'));
  };

  await assert.rejects(drain(['w1'], Array(10).fill(task), { signal: ctrl.signal }), /клиент бросил вызов/);
  assert.equal(done, 2);
});
