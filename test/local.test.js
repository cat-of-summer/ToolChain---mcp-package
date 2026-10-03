import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Рабочая среда через MCP целиком: инструменты, рамка wrap, задачи. Языки здесь — те, что
// есть в образе без mise (bash, node); установка тулчейнов — в mise.test.js.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-local-'));
process.env.TK_ROOT = root;
process.env.TK_UPDATE_CHECK = '0';
process.env.TK_FOREGROUND_TIMEOUT = '2';

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createServer } = await import('../src/server.js');
const jobs = await import('../src/local/jobs.js');

const { server } = await createServer({ spec: 'local' });
const client = new Client({ name: 'test', version: '0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content[0].text;
  if (res.isError) return { error: text };
  try { return JSON.parse(text); } catch { return text; }
}

test.after(() => jobs.killAll());

test('файл, записанный в область, виден коду по относительному пути', async () => {
  await call('ws_write', { path: 'data/in.txt', content: 'привет\n' });
  const res = await call('exec', { command: 'cat in.txt && pwd', cwd: 'data' });
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /^привет\n/);
  assert.match(res.stdout, /workspace\/data\n$/);
});

test('run_code сохраняет код и выполняет его', async () => {
  const res = await call('run_code', { tool: 'node', code: 'import fs from "node:fs"; console.log(fs.readFileSync("data/in.txt", "utf8").trim().length);' });
  assert.equal(res.exitCode, 0, JSON.stringify(res));
  assert.equal(res.stdout.trim(), '6');
  assert.match(res.file, /^\.tk\/run\/.+\/main\.mjs$/);
});

test('неизвестный язык называет известные', async () => {
  const res = await call('run_code', { tool: 'cobol', code: 'x' });
  assert.match(res.error, /не знает.*python/);
});

test('секрет из env-ссылки вычищается из вывода', async () => {
  await call('ws_write', { path: 'keys/token', content: 'очень-секретный-токен' });
  const res = await call('exec', { command: 'echo "token=$TOKEN"', env: { TOKEN: 'ws:keys/token' } });
  assert.equal(res.stdout.includes('очень-секретный-токен'), false);
  assert.match(res.stdout, /token=•/);
});

test('долгая команда уходит в фон, job_status её дожидается', async () => {
  const res = await call('exec', { command: 'sleep 3; echo готово' });
  assert.ok(res.job, JSON.stringify(res));
  assert.equal(res.status, 'running');
  const done = await call('job_status', { id: res.job, wait: 2 });
  const final = done.status === 'running' ? await call('job_status', { id: res.job, wait: 2 }) : done;
  assert.equal(final.status, 'done');
  assert.match(final.stdout, /готово/);
});

test('job_kill гасит задачу вместе с потомками', async () => {
  const res = await call('exec', { command: 'sleep 60 & sleep 60; wait', background: true });
  await call('job_kill', { id: res.job });
  const after = await call('job_status', { id: res.job, wait: 2 });
  assert.equal(after.status, 'killed');
});

test('таймаут убивает процесс', async () => {
  const res = await call('exec', { command: 'sleep 10', timeout: 1 });
  const final = res.job ? await call('job_status', { id: res.job, wait: 2 }) : res;
  assert.equal(final.timedOut, true);
});

test('окружение стенда в код не протекает', async () => {
  process.env.TK_SECRET_RESOLVER_TOKEN = 'токен-сервера';
  const res = await call('exec', { command: 'env' });
  assert.equal(res.stdout.includes('токен-сервера'), false);
  delete process.env.TK_SECRET_RESOLVER_TOKEN;
});

test('выход из области отклоняется на всех входах', async () => {
  assert.match((await call('ws_read', { path: '../state/known_hosts.json' })).error, /за пределы/);
  assert.match((await call('exec', { command: 'pwd', cwd: '../..' })).error, /за пределы/);
  assert.match((await call('ws_remove', { path: '.', recursive: true })).error, /корень/);
});

test('ws_read читает кусками', async () => {
  await call('ws_write', { path: 'big.txt', content: 'abcdefghij' });
  const part = await call('ws_read', { path: 'big.txt', offset: 3, maxBytes: 4 });
  assert.equal(part.content, 'defg');
  assert.equal(part.more, true);
});

test('журнал пишет локальные вызовы с вычищенным секретом', async () => {
  const { list, get } = await import('../src/audit/query.js');
  const last = list({ tool: 'exec', contains: 'TOKEN', limit: 1 }).entries[0];
  assert.ok(last, 'запись есть');
  const full = JSON.stringify(get(last.id));
  assert.equal(full.includes('очень-секретный-токен'), false);
});

test('сбой на хосте версий mise повторяется через первоисточники', async () => {
  const reach = await import('../src/local/reach.js');
  reach.reset(null);
  const res = await call('exec', {
    command: 'if [ "$MISE_USE_VERSIONS_HOST" = false ]; then echo через-первоисточники; '
      + 'else echo "GET https://mise-versions.jdx.dev/tools/x.gz failed" >&2; exit 1; fi',
  });
  assert.equal(res.exitCode, 0, JSON.stringify(res));
  assert.match(res.stdout, /через-первоисточники/);
  assert.match(res.retried, /повторено/);
  assert.equal(reach.versionsHost(), false);
  reach.reset(null);
});
