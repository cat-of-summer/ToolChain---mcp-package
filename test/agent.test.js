import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-agent-'));
process.env.MISE_DATA_DIR = path.join(process.env.TK_ROOT, 'tools');
delete process.env.TK_AGENT;

const agents = await import('../src/agent.js');
const apt = await import('../src/local/apt.js');

const client = (caps, roots) => ({
  server: {
    getClientCapabilities: () => caps,
    listRoots: async () => {
      if (roots instanceof Error) throw roots;
      return { roots };
    },
  },
});

test('корень проекта из roots — путь, как его знает человек', () => {
  assert.equal(agents.fromRoot('file:///o%3A/Projects/shop'), 'O:/Projects/shop');
  assert.equal(agents.fromRoot('file:///O:/Projects/shop/'), 'O:/Projects/shop');
  assert.equal(agents.fromRoot('file:///home/me/shop'), '/home/me/shop');
});

test('заголовок старше roots', async () => {
  const ctx = { agent: 'shop-bot', sessionId: 's1', server: client({ roots: {} }, [{ uri: 'file:///x' }]) };
  assert.deepEqual(await agents.agentOf(ctx), { id: 'shop-bot', source: 'header' });
});

test('без заголовка — первый root клиента, один раз на сессию', async () => {
  let calls = 0;
  const server = { getClientCapabilities: () => ({ roots: {} }), listRoots: async () => { calls++; return { roots: [{ uri: 'file:///o%3A/Projects/shop' }] }; } };
  const ctx = { sessionId: 's2', server: { server } };
  assert.deepEqual(await agents.agentOf(ctx), { id: 'O:/Projects/shop', source: 'roots' });
  await agents.agentOf(ctx);
  assert.equal(calls, 1);
});

test('нет ни заголовка, ни roots — агент безымянный', async () => {
  assert.deepEqual(await agents.agentOf({ sessionId: 's3', server: client({}, []) }), { id: null, source: null });
});

test('клиент не ответил на roots — безымянный сейчас, но спросим снова', async () => {
  const ctx = { sessionId: 's4', server: client({ roots: {} }, new Error('timeout')) };
  assert.equal((await agents.agentOf(ctx)).id, null);
  ctx.server = client({ roots: {} }, [{ uri: 'file:///srv/app' }]);
  assert.equal((await agents.agentOf(ctx)).id, '/srv/app');
});

test('заголовок чистится от управляющих символов и длины', () => {
  assert.equal(agents.clean('  bot\nname\u0007 '), 'botname');
  assert.equal(agents.clean(''), null);
  assert.equal(agents.clean('x'.repeat(500)).length, 200);
});

test('kit: и apt: разбираются, чужое отклоняется', () => {
  const office = apt.parse('kit:office');
  assert.equal(office.id, 'kit:office');
  assert.ok(office.packages.includes('libreoffice-writer-nogui'));
  assert.deepEqual(apt.parse('apt:poppler-utils').packages, ['poppler-utils']);
  assert.throws(() => apt.parse('kit:nope'), /набора «nope» нет/);
  assert.throws(() => apt.parse('apt:rm -rf /'), /не похоже на пакет/);
  assert.equal(apt.isSystem('kit:office'), true);
  assert.equal(apt.isSystem('aqua:cli/cli'), false, 'бэкенды mise с двоеточием — не пакеты');
});

test('задача установки apt: кэш и списки в томе, пакеты аргументами, а не в тексте скрипта', () => {
  const job = apt.installJob(['poppler-utils', 'qpdf']);
  assert.deepEqual(job.argv.slice(-2), ['poppler-utils', 'qpdf']);
  assert.match(job.env.TK_APT_OPTS, /Dir::Cache::archives=.*\.apt/);
  assert.match(job.env.TK_APT_OPTS, /Keep-Downloaded-Packages=true/);
  assert.throws(() => apt.installJob(['x; rm -rf /']), /не похоже на имя пакета/);
});

test('использование набора узнаётся по его программам в команде', () => {
  assert.equal(apt.mentions('cd docs && soffice --headless --convert-to pdf a.docx', ['soffice']), true);
  assert.equal(apt.mentions('echo officeholder', ['soffice']), false);
  assert.equal(apt.mentions('ls', []), false);
});
