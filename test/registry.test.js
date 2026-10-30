import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-registry-'));
process.env.TK_ROOT = root;
// В контейнере стенда MISE_DATA_DIR указывает на настоящий том tools — реестр туда писать нельзя.
process.env.MISE_DATA_DIR = path.join(root, 'tools');
process.env.TK_TOOL_TTL_ONCE = '12h';
process.env.TK_TOOL_TTL_PUBLIC = '30d';
process.env.TK_TOOL_TTL_PRIVATE = '10d';
process.env.TK_TOOL_TTL_PER_DAY = '3d';
process.env.TK_TOOL_TTL_MAX = '40d';

const registry = await import('../src/local/registry.js');
const { duration } = await import('../src/config.js');

const H = 3600_000;
const D = 24 * H;
const T0 = Date.parse('2026-10-01T10:00:00Z');
const meta = { kind: 'mise', tool: 'php', version: '8.3.35' };

test('длительности: 12h, 30d, 90m, голые секунды; мусор — умолчание', () => {
  assert.equal(duration('12h'), 12 * H);
  assert.equal(duration('30d'), 30 * D);
  assert.equal(duration('90m'), 90 * 60_000);
  assert.equal(duration('45'), 45_000);
  assert.equal(duration('чушь', '1h'), H);
});

test('разовая живёт 12 ч от последнего использования, и использование продлевает', () => {
  registry.claim('mise:a@1', { visibility: 'once', agent: null, meta, now: T0 });
  assert.equal(registry.expiresAt(registry.get('mise:a@1')), T0 + 12 * H);

  registry.touch('mise:a@1', 'x', T0 + 10 * H);
  assert.equal(registry.expiresAt(registry.get('mise:a@1')), T0 + 22 * H, 'не исчезает посреди работы');
  assert.deepEqual(registry.expired(T0 + 21 * H).map((e) => e.id).includes('mise:a@1'), false);
  assert.deepEqual(registry.expired(T0 + 23 * H).map((e) => e.id).includes('mise:a@1'), true);
});

test('публичная: база плюс сутки использования, но не дольше потолка; вызовы в одни сутки не копятся', () => {
  registry.claim('mise:b@1', { visibility: 'public', agent: 'a', meta, now: T0 });
  for (let i = 0; i < 50; i++) registry.touch('mise:b@1', 'a', T0 + i * 60_000);
  const sameDay = registry.get('mise:b@1').claims[0];
  assert.equal(sameDay.activeDays, 1, 'полсотни вызовов за вечер — одни сутки');

  const last = T0 + 2 * D;
  registry.touch('mise:b@1', 'a', T0 + D);
  registry.touch('mise:b@1', 'a', last);
  assert.equal(registry.expiresAt(registry.get('mise:b@1')), last + 30 * D + 2 * 3 * D);

  for (let day = 3; day < 20; day++) registry.touch('mise:b@1', 'a', T0 + day * D);
  const capped = registry.get('mise:b@1');
  assert.equal(registry.expiresAt(capped), Date.parse(capped.claims[0].lastUsedAt) + 40 * D, 'потолок TK_TOOL_TTL_MAX');
});

test('приватная видна только своему агенту, чужой её не удалит', () => {
  registry.claim('mise:c@1', { visibility: 'private', agent: 'alice', meta, now: T0 });
  const entry = registry.get('mise:c@1');
  assert.equal(registry.visibleTo(entry, 'alice'), true);
  assert.equal(registry.visibleTo(entry, 'bob'), false);
  assert.equal(registry.visibleTo(entry, null), false);
  assert.equal(registry.canRemove(entry, 'bob'), false);
  assert.equal(registry.canRemove(entry, 'alice'), true);
  assert.equal(registry.view(entry, 'alice').visibility, 'private');
  assert.equal(registry.view(entry, 'alice').yours, true);
});

test('приватно без имени агента — ошибка, а не безымянная приватная', () => {
  assert.throws(() => registry.claim('mise:d@1', { visibility: 'private', agent: null, meta }), /X-Toolkit-Agent/);
});

test('чужой агент воспользовался приватной — у него появляется разовая, а приватная не продлевается', () => {
  registry.claim('mise:e@1', { visibility: 'private', agent: 'alice', meta, now: T0 });
  registry.touch('mise:e@1', 'bob', T0 + H);
  const entry = registry.get('mise:e@1');
  const alice = entry.claims.find((c) => c.visibility === 'private');
  const once = entry.claims.find((c) => c.visibility === 'once');
  assert.equal(alice.lastUsedAt, new Date(T0).toISOString());
  assert.ok(once, 'разовая заявка для bob');
  assert.equal(registry.visibleTo(entry, 'bob'), true);
});

test('запись живёт по самой долгой заявке', () => {
  registry.claim('mise:f@1', { visibility: 'once', agent: null, meta, now: T0 });
  registry.claim('mise:f@1', { visibility: 'private', agent: 'alice', meta, now: T0 });
  assert.equal(registry.expiresAt(registry.get('mise:f@1')), T0 + 10 * D);
});

test('закреплённое глобально не истекает', () => {
  registry.claim('mise:g@1', { visibility: 'once', agent: null, meta, now: T0 });
  registry.update('mise:g@1', { pinned: true });
  assert.equal(registry.expiresAt(registry.get('mise:g@1')), null);
  assert.equal(registry.expired(T0 + 1000 * D).some((e) => e.id === 'mise:g@1'), false);
});

test('сверка: до реестра стоявшее — публичное, потом найденное в обход — разовое; пропавшее уходит', () => {
  fs.rmSync(path.join(root, 'tools'), { recursive: true, force: true });
  registry.reset();

  registry.reconcile('mise', new Map([['mise:python@3.12.15', { tool: 'python', version: '3.12.15' }]]), T0);
  assert.equal(registry.get('mise:python@3.12.15').claims[0].visibility, 'public');

  const res = registry.reconcile('mise', new Map([
    ['mise:python@3.12.15', { tool: 'python', version: '3.12.15' }],
    ['mise:go@1.23.4', { tool: 'go', version: '1.23.4' }],
  ]), T0);
  assert.deepEqual(res.added, ['mise:go@1.23.4']);
  assert.equal(registry.get('mise:go@1.23.4').claims[0].visibility, 'once');

  registry.claim('kit:office', { visibility: 'public', agent: null, meta: { kind: 'apt', packages: ['x'] }, now: T0 });
  const gone = registry.reconcile('mise', new Map([['mise:go@1.23.4', {}]]), T0);
  assert.deepEqual(gone.dropped, ['mise:python@3.12.15']);
  assert.ok(registry.get('kit:office'), 'сверка mise не трогает наборы пакетов');
});

test('реестр переживает перезапуск процесса: лежит в томе tools', () => {
  registry.claim('mise:h@1', { visibility: 'public', agent: null, meta, now: T0 });
  registry.reset();
  assert.ok(registry.get('mise:h@1'));
  assert.ok(fs.existsSync(path.join(root, 'tools', '.tk', 'registry.json')));
});
