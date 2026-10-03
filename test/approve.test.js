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
const { cfg } = await import('../src/config.js');

// Клиент без elicitation: вопрос уходит в очередь, «человек» отвечает через неё.
const ctx = (sessionId) => ({ sessionId, server: { server: { getClientCapabilities: () => ({}) } } });

function answer(status) {
  const onChange = ({ id, action }) => {
    if (action !== 'created') return;
    queue.events.off('change', onChange);
    setImmediate(() => queue.decide(id, status, 'test'));
  };
  queue.events.on('change', onChange);
}

const call = (over = {}) => ({ tool: 'ssh_exec', target: 'shop', host: 'h1', mutating: true, summary: 'rm -rf x', ...over });

test('чтение не спрашивается', async () => {
  const res = await gate.authorize(ctx('a'), call({ mutating: false }));
  assert.equal(res.required, false);
  assert.equal(queue.pendingCount(), 0);
});

test('запись на сервер спрашивается один раз за сессию', async () => {
  answer('approved');
  const first = await gate.authorize(ctx('b'), call());
  assert.equal(first.status, 'approved');
  assert.equal(first.questions, 1);

  const second = await gate.authorize(ctx('b'), call({ summary: 'другая команда' }));
  assert.equal(second.granted, 'ранее в этой сессии');
  assert.equal(second.questions, 0);
});

test('разрешение на один сервер не открывает другой и не переходит в другую сессию', async () => {
  answer('declined');
  await assert.rejects(gate.authorize(ctx('b'), call({ host: 'h2' })), { name: 'Declined' });
  answer('declined');
  await assert.rejects(gate.authorize(ctx('c'), call()), { name: 'Declined' });
});

test('отказ запоминается: второй раз не спрашивают', async () => {
  answer('declined');
  await assert.rejects(gate.authorize(ctx('d'), call()), { name: 'Declined' });
  const before = queue.recent().length;
  await assert.rejects(gate.authorize(ctx('d'), call()), /запрещена ранее/);
  assert.equal(queue.recent().length, before, 'новой заявки нет');
});

test('readonly спрашивает каждый раз, и после разрешения на сервер', async () => {
  answer('approved');
  await gate.authorize(ctx('e'), call());
  answer('approved');
  const res = await gate.authorize(ctx('e'), call({ guard: { reasons: ['rm'] } }));
  assert.equal(res.scope, 'call');
  answer('declined');
  await assert.rejects(gate.authorize(ctx('e'), call({ guard: { reasons: ['rm'] } })), { name: 'Declined' });
});

test('без ответа — отказ по таймауту', async () => {
  await assert.rejects(gate.authorize(ctx('f'), call()), /не получено/);
});

test('TK_APPROVAL=off не спрашивает о записи, но readonly — спрашивает', async () => {
  cfg.approval = 'off';
  try {
    const res = await gate.authorize(ctx('g'), call());
    assert.equal(res.required, false);
    answer('approved');
    const guarded = await gate.authorize(ctx('g'), call({ guard: { reasons: ['rm'] } }));
    assert.equal(guarded.status, 'approved');
  } finally {
    cfg.approval = 'host';
  }
});
