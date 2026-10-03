import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Тулчейны через mise в контейнере стенда. Ходит в сеть и ставит настоящие версии, поэтому
// включается флагами: TK_MISE_TESTS=1 — python и node (секунды), TK_MISE_SLOW=1 — сборка
// php 7.4 на OpenSSL 1.1 (минуты). Без флагов проверяется только разбор спецификаций.

const fast = process.env.TK_MISE_TESTS === '1';
const slow = process.env.TK_MISE_SLOW === '1';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-mise-'));
process.env.TK_ROOT = root;
process.env.TK_UPDATE_CHECK = '0';
process.env.TK_FOREGROUND_TIMEOUT = '50';

const mise = await import('../src/local/mise.js');
// Как при старте сервера: без проверки хоста версий mise там, где он недоступен, не поставит python.
await (await import('../src/local/reach.js')).probe();

test('спецификации проверяются, шелл в них не пролезает', () => {
  assert.doesNotThrow(() => mise.checkSpecs(['python@3.11', 'node@latest', 'php', 'ubi:owner/repo@1.2.3']));
  assert.throws(() => mise.checkSpecs(['python@3.11; rm -rf /']), /не похоже/);
  assert.throws(() => mise.checkSpecs(['$(id)']), /не похоже/);
});

test('php 5 и 7 собираются на OpenSSL 1.1, остальное — на системном', () => {
  assert.match(mise.buildEnv(['php@7.4']).PKG_CONFIG_PATH, /openssl-1\.1/);
  assert.match(mise.buildEnv(['python@3.11', 'php@5.6']).LDFLAGS, /rpath/);
  assert.deepEqual(mise.buildEnv(['php@8.3']), {});
  assert.deepEqual(mise.buildEnv(['php']), {});
  assert.deepEqual(mise.buildEnv(['python@3.7']), {});
});

test('exec с tools оборачивается в mise exec', () => {
  assert.deepEqual(mise.execArgv([], ['bash', '-c', 'x']), ['bash', '-c', 'x']);
  assert.deepEqual(mise.execArgv(['python@3.11'], ['python', 'a.py']), [mise.MISE, 'exec', 'python@3.11', '--', 'python', 'a.py']);
});

async function client() {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createServer } = await import('../src/server.js');
  const { server } = await createServer({ spec: 'local' });
  const c = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), c.connect(a)]);
  return async (name, args) => {
    const res = await c.callTool({ name, arguments: args });
    const text = res.content[0].text;
    return res.isError ? { error: text } : JSON.parse(text);
  };
}

async function finish(call, res) {
  let current = res;
  while (current.job && current.status === 'running') current = await call('job_status', { id: current.job, wait: 50 });
  return current;
}

test('python и node нужных версий', { skip: !fast, timeout: 600_000 }, async () => {
  const call = await client();
  const py = await finish(call, await call('run_code', { tool: 'python@3.11', code: 'import sys; print(sys.version_info[:2])' }));
  assert.equal(py.exitCode, 0, JSON.stringify(py));
  assert.equal(py.stdout.trim(), '(3, 11)');

  const node = await finish(call, await call('exec', { command: 'node -p process.versions.node', tools: ['node@20'] }));
  assert.match(node.stdout, /^20\./);
});

test('env_use закрепляет версию за каталогом', { skip: !fast, timeout: 600_000 }, async () => {
  const call = await client();
  const used = await finish(call, await call('env_use', { tools: ['python@3.12'], dir: 'py312' }));
  assert.equal(used.exitCode, 0, JSON.stringify(used));
  const res = await call('exec', { command: 'python --version', cwd: 'py312' });
  assert.match(res.stdout, /Python 3\.12/);
});

test('php 7.4 собирается с openssl и ходит по https', { skip: !slow, timeout: 1_800_000 }, async () => {
  const call = await client();
  const installed = await finish(call, await call('env_install', { tools: ['php@7.4'] }));
  assert.equal(installed.exitCode, 0, installed.stderr);

  const res = await finish(call, await call('run_code', {
    tool: 'php@7.4',
    code: '<?php echo PHP_VERSION, " ", OPENSSL_VERSION_TEXT, " ", strlen(file_get_contents("https://github.com")) > 0 ? "https-ok" : "https-fail";',
  }));
  assert.match(res.stdout, /^7\.4\.\d+ OpenSSL 1\.1\.1/);
  assert.match(res.stdout, /https-ok/);
});
