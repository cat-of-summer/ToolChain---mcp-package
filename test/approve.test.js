import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-approve-'));
process.env.TK_ROOT = root;
process.env.TK_APPROVE_TIMEOUT = '2';

const gate = await import('../src/approve/gate.js');
const queue = await import('../src/approve/queue.js');
const grants = await import('../src/approve/grants.js');
const { cfg } = await import('../src/config.js');

// Клиент без elicitation: вопрос уходит в очередь, «человек» отвечает через неё.
const ctx = (sessionId) => ({ sessionId, server: { server: { getClientCapabilities: () => ({}) } } });

/** Ответит на следующую заявку: approved | declined | read | write. Возвращает заявку. */
function answer(status) {
  const seen = {};
  const onChange = ({ id, action }) => {
    if (action !== 'created') return;
    queue.events.off('change', onChange);
    seen.item = queue.get(id);
    setImmediate(() => queue.decide(id, status, 'test'));
  };
  queue.events.on('change', onChange);
  return seen;
}

const read = (over = {}) => ({ tool: 'files_list', target: 'shop', key: 'deploy@h1', mutating: false, summary: 'ls /', ...over });
const write = (over = {}) => read({ tool: 'ssh_exec', mutating: true, summary: 'rm -rf x', ...over });

test('первое чтение спрашивает доступ, дальше чтение молча', async () => {
  const asked = answer('approved');
  const first = await gate.authorize(ctx('a'), read());
  assert.equal(first.level, 'read');
  assert.equal(first.questions, 1);
  assert.deepEqual(asked.item.choices, ['read', 'write'], 'человеку предложили сразу и запись');

  const second = await gate.authorize(ctx('a'), read({ summary: 'cat x' }));
  assert.equal(second.granted, 'ранее в этой сессии');
  assert.equal(second.questions, 0);
});

test('после чтения первая запись спрашивает один раз', async () => {
  answer('approved');
  await gate.authorize(ctx('b'), read());

  const asked = answer('approved');
  const first = await gate.authorize(ctx('b'), write());
  assert.equal(first.level, 'write');
  assert.deepEqual(asked.item.choices, ['write'], 'чтение уже есть — спрашиваем только запись');

  const again = await gate.authorize(ctx('b'), write({ summary: 'другая команда' }));
  assert.equal(again.questions, 0);
});

test('«чтение и запись» на первом вопросе — больше не спрашивают', async () => {
  answer('write');
  await gate.authorize(ctx('c'), read());
  const before = queue.recent().length;
  await gate.authorize(ctx('c'), write());
  await gate.authorize(ctx('c'), read());
  assert.equal(queue.recent().length, before, 'новых заявок нет');
});

test('первым — запись: вопрос сразу о записи, «только чтение» оставляет чтение', async () => {
  const asked = answer('read');
  await assert.rejects(gate.authorize(ctx('d'), write()), /только чтение/);
  assert.deepEqual(asked.item.choices, ['write', 'read']);

  const res = await gate.authorize(ctx('d'), read());
  assert.equal(res.questions, 0, 'чтение выдано тем же ответом');
  await assert.rejects(gate.authorize(ctx('d'), write()), /запись .* запрещена ранее/);
});

test('доступ выдаётся пользователю: другой user на том же сервере спрашивается отдельно', async () => {
  answer('write');
  await gate.authorize(ctx('e'), read());
  answer('declined');
  await assert.rejects(gate.authorize(ctx('e'), read({ key: 'root@h1' })), { name: 'Declined' });
  answer('declined');
  await assert.rejects(gate.authorize(ctx('e2'), read()), { name: 'Declined' }, 'и не переходит в другую сессию');
});

test('отказ в записи оставляет чтение, отказ в доступе закрывает всё', async () => {
  answer('approved');
  await gate.authorize(ctx('f'), read());
  answer('declined');
  await assert.rejects(gate.authorize(ctx('f'), write()), { name: 'Declined' });
  assert.equal((await gate.authorize(ctx('f'), read())).questions, 0);

  answer('declined');
  await assert.rejects(gate.authorize(ctx('g'), read()), { name: 'Declined' });
  const before = queue.recent().length;
  await assert.rejects(gate.authorize(ctx('g'), write()), /запрещена ранее/);
  await assert.rejects(gate.authorize(ctx('g'), read()), /запрещён ранее/);
  assert.equal(queue.recent().length, before, 'второй раз о том же не спрашивают');
});

test('очередь принимает только предложенные уровни', () => {
  const id = queue.create({ tool: 't', summary: 's', choices: ['write'] });
  assert.throws(() => queue.decide(id, 'read'), /не понято/);
  queue.decide(id, 'write');
  const plain = queue.create({ tool: 't', summary: 's' });
  assert.throws(() => queue.decide(plain, 'write'), /не понято/);
  queue.decide(plain, 'declined');
});

test('snapshot показывает уровни по user@host', async () => {
  answer('approved');
  await gate.authorize(ctx('h'), read());
  assert.deepEqual(grants.snapshot('h').доступ, { 'deploy@h1': 'чтение' });
});

test('readonly спрашивает каждый раз, и после разрешения на сервер', async () => {
  answer('write');
  await gate.authorize(ctx('i'), write());
  answer('approved');
  const res = await gate.authorize(ctx('i'), write({ guard: { reasons: ['rm'] } }));
  assert.equal(res.scope, 'call');
  answer('declined');
  await assert.rejects(gate.authorize(ctx('i'), write({ guard: { reasons: ['rm'] } })), { name: 'Declined' });
});

test('без ответа — отказ по таймауту', async () => {
  await assert.rejects(gate.authorize(ctx('j'), read()), /не получено/);
});

test('TK_APPROVAL=write спрашивает только запись', async () => {
  cfg.approval = 'write';
  try {
    const res = await gate.authorize(ctx('k'), read());
    assert.equal(res.required, false);
    const asked = answer('approved');
    await gate.authorize(ctx('k'), write());
    assert.deepEqual(asked.item.choices, ['write']);
  } finally {
    cfg.approval = 'host';
  }
});

test('TK_APPROVAL=off не спрашивает о доступе, но readonly — спрашивает', async () => {
  cfg.approval = 'off';
  try {
    assert.equal((await gate.authorize(ctx('l'), read())).required, false);
    assert.equal((await gate.authorize(ctx('l'), write())).required, false);
    answer('approved');
    const guarded = await gate.authorize(ctx('l'), write({ guard: { reasons: ['rm'] } }));
    assert.equal(guarded.status, 'approved');
  } finally {
    cfg.approval = 'host';
  }
});

test('без ключа (не удалённый вызов) — не спрашивается', async () => {
  const res = await gate.authorize(ctx('m'), { tool: 'exec', mutating: true, summary: 'ls' });
  assert.equal(res.required, false);
});
