import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Сквозной прогон по HTTP против живых мишеней из docker-compose.test.yml: два сервера с SSH,
// две базы за первым (в сеть стенда не выставлены) и FTP. Включается TK_E2E=1, потому что
// без поднятых мишеней он не значит ничего.
//
//   docker compose -f docker-compose.test.yml up -d
//   docker compose -f app/docker-compose.yml exec node env TK_E2E=1 npm test

const enabled = process.env.TK_E2E === '1';
const BASE = process.env.TK_E2E_URL || `http://127.0.0.1:${process.env.MCP_PORT || 8933}`;
const HOST_PASSWORD = 'tester-пароль-стенда';
const DB_PASSWORD = 'shop-пароль-стенда';
const FTP_PASSWORD = 'ftp-пароль-стенда';

const SSH = { host: 'sshd_test', port: 2222, user: 'tester', password: HOST_PASSWORD, cwd: '/config' };

/**
 * @param answer 'accept' | 'read' | 'decline' | null. accept на вопрос о доступе выбирает
 *               «чтение и запись», read — «только чтение». null означает клиента, который
 *               спрашивать не умеет: тогда заявка уходит в веб-очередь.
 */
async function connect(t, answer = 'accept') {
  const capabilities = answer === null ? {} : { elicitation: {} };
  const client = new Client({ name: 'e2e', version: '0' }, { capabilities });

  const asked = [];
  if (answer !== null) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      asked.push(request.params.message);
      if (answer === 'decline') return { action: 'decline' };
      const access = request.params.requestedSchema?.properties?.access;
      if (!access) return { action: 'accept', content: { approve: true } };
      const level = answer === 'read' ? 'read' : 'write';
      // «Только чтение» предлагают не всегда: когда его нечем выбрать, человек отказывает.
      if (!access.oneOf.some((option) => option.const === level)) return { action: 'decline' };
      return { action: 'accept', content: { access: level } };
    });
  }

  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  t.after(() => client.close().catch(() => {}));
  return { client, asked };
}

async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.map((part) => part.text).join('\n');
  let json = null;
  try { json = JSON.parse(text); } catch { /* текст ошибки */ }
  return { isError: Boolean(res.isError), text, json };
}

test('команда на сервере: один вопрос на user@host за сессию', { skip: !enabled }, async (t) => {
  const { client, asked } = await connect(t, 'accept');
  const opened = await call(client, 'conn_open', { name: 'srv', target: SSH });
  assert.equal(opened.isError, false, opened.text);
  assert.equal(opened.text.includes(HOST_PASSWORD), false, 'пароль не вернулся в ответе');

  const res = await call(client, 'ssh_exec', { conn: 'srv', command: 'id -un && pwd' });
  assert.equal(res.isError, false, res.text);
  assert.match(res.json.stdout, /tester\n\/config/);
  assert.equal(asked.length, 1, asked.join(' | '));
  assert.match(asked[0], /tester@sshd_test/);
  assert.match(asked[0], /id -un/, 'человеку показали само действие');

  const again = await call(client, 'ssh_exec', { conn: 'srv', command: 'echo second' });
  assert.equal(again.isError, false, again.text);
  assert.equal(asked.length, 1, 'второй вызов на тот же сервер не спрашивает');
});

test('чтение спрашивается один раз, «только чтение» не пускает запись', { skip: !enabled }, async (t) => {
  const { client, asked } = await connect(t, 'read');
  await call(client, 'conn_open', { name: 'srv', target: SSH });

  const check = await call(client, 'conn_check', { conn: 'srv' });
  assert.equal(check.isError, false, check.text);
  assert.equal(check.json.user, 'tester');
  assert.match(check.json.hostKey, /^SHA256:/, 'ключ хоста закреплён при первом входе');
  assert.equal(asked.length, 1);

  const ls = await call(client, 'ssh_exec', { conn: 'srv', command: 'ls /config' });
  assert.equal(ls.isError, false, ls.text);
  assert.equal(asked.length, 1, 'читающая команда идёт по разрешению на чтение');

  const res = await call(client, 'ssh_exec', { conn: 'srv', command: 'touch /config/не-должно-появиться' });
  assert.equal(res.isError, true);
  assert.match(res.text, /не выполнено/);
  assert.equal(asked.length, 2, 'запись спросили отдельно');
});

test('отказ в доступе — это отказ', { skip: !enabled }, async (t) => {
  const { client } = await connect(t, 'decline');
  await call(client, 'conn_open', { name: 'srv', target: SSH });
  const res = await call(client, 'files_list', { conn: 'srv', path: '/config' });
  assert.equal(res.isError, true);
  assert.match(res.text, /не выполнено/);
});

test('conn_open с access: write — один вопрос на всё', { skip: !enabled }, async (t) => {
  const { client, asked } = await connect(t, 'accept');
  const opened = await call(client, 'conn_open', { name: 'srv', target: SSH, access: 'write' });
  assert.equal(opened.isError, false, opened.text);
  assert.equal(asked.length, 1);
  await call(client, 'files_list', { conn: 'srv', path: '/config' });
  const res = await call(client, 'ssh_exec', { conn: 'srv', command: 'touch /config/e2e-flag && rm /config/e2e-flag' });
  assert.equal(res.isError, false, res.text);
  assert.equal(asked.length, 1);
});

test('пароль вычищается из вывода, адрес с паролем — из журнала', { skip: !enabled }, async (t) => {
  const { client } = await connect(t);
  const url = `ssh://tester:${encodeURIComponent(HOST_PASSWORD)}@sshd_test:2222/config`;
  const res = await call(client, 'ssh_exec', { conn: url, command: `echo "${HOST_PASSWORD}"` });
  assert.equal(res.isError, false, res.text);
  assert.equal(res.text.includes(HOST_PASSWORD), false);

  const log = await call(client, 'audit_query', { tool: 'ssh_exec', limit: 1 });
  const full = await call(client, 'audit_show', { id: log.json.entries[0].id });
  assert.equal(full.text.includes(HOST_PASSWORD), false, 'пароль не лёг в журнал');
  assert.equal(full.text.includes(encodeURIComponent(HOST_PASSWORD)), false);
});

test('ключ из рабочей области: кладём ключ на второй сервер и входим им', { skip: !enabled }, async (t) => {
  const { client } = await connect(t);
  await call(client, 'conn_open', { name: 'srv', target: SSH });

  const gen = await call(client, 'exec', { command: 'rm -f keys/e2e keys/e2e.pub; mkdir -p keys && ssh-keygen -q -t ed25519 -N "" -f keys/e2e && cat keys/e2e.pub' });
  assert.equal(gen.json.exitCode, 0, gen.text);
  const pub = gen.json.stdout.trim();

  await call(client, 'conn_open', { name: 'dev-pw', target: { host: 'sshd_dev', port: 2222, user: 'deploy', password: 'dev-stand-password' } });
  const put = await call(client, 'ssh_exec', {
    conn: 'dev-pw',
    command: 'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys',
    stdin: `${pub}\n`,
  });
  assert.equal(put.json.exitCode, 0, put.text);

  await call(client, 'conn_open', { name: 'dev', target: { host: 'sshd_dev', port: 2222, user: 'deploy', key: 'ws:keys/e2e' } });
  const res = await call(client, 'ssh_exec', { conn: 'dev', command: 'id -un' });
  assert.equal(res.isError, false, res.text);
  assert.equal(res.json.stdout.trim(), 'deploy');
  assert.equal(res.text.includes('PRIVATE KEY'), false);
});

test('sftp: каталог туда и обратно через рабочую область', { skip: !enabled }, async (t) => {
  const { client } = await connect(t);
  await call(client, 'conn_open', { name: 'srv', target: { ...SSH, root: '/config' } });

  await call(client, 'ws_write', { path: 'site/index.php', content: '<?php echo "ok";' });
  await call(client, 'ws_write', { path: 'site/css/app.css', content: 'body{}' });

  const put = await call(client, 'files_put', { conn: 'srv', from: 'site', dest: 'e2e-site' });
  assert.equal(put.isError, false, put.text);
  assert.equal(put.json.files, 2);

  const listed = await call(client, 'files_list', { conn: 'srv', path: 'e2e-site/css' });
  assert.ok(listed.json.entries.some((e) => e.name === 'app.css'));

  const got = await call(client, 'files_get', { conn: 'srv', path: 'e2e-site', to: 'back/site' });
  assert.equal(got.isError, false, got.text);
  assert.equal(got.json.files, 2);
  const read = await call(client, 'ws_read', { path: 'back/site/css/app.css' });
  assert.equal(read.json.content, 'body{}');

  await call(client, 'ssh_exec', { conn: 'srv', command: 'rm -rf /config/e2e-site' });
});

test('ftp: файл туда и обратно', { skip: !enabled }, async (t) => {
  const { client } = await connect(t);
  await call(client, 'conn_open', { name: 'ftp', target: { host: 'ftp_test', proto: 'ftp', user: 'ftpuser', password: FTP_PASSWORD } });

  const check = await call(client, 'conn_check', { conn: 'ftp' });
  assert.equal(check.isError, false, check.text);

  await call(client, 'ws_write', { path: 'ftp/hello.txt', content: 'привет по ftp' });
  const put = await call(client, 'files_put', { conn: 'ftp', from: 'ftp/hello.txt', dest: 'hello.txt' });
  assert.equal(put.isError, false, put.text);

  const read = await call(client, 'files_read', { conn: 'ftp', path: 'hello.txt' });
  assert.equal(read.json.content, 'привет по ftp');
  assert.equal(read.text.includes(FTP_PASSWORD), false);

  await call(client, 'files_remove', { conn: 'ftp', path: 'hello.txt' });
});

for (const engine of ['postgres', 'mysql']) {
  test(`${engine}: запрос через SSH-туннель, дамп в рабочую область`, { skip: !enabled }, async (t) => {
    const { client, asked } = await connect(t);
    await call(client, 'conn_open', {
      name: 'db',
      target: { ...SSH, db: { engine, host: `${engine}_test`, database: 'shop', user: 'shop', password: DB_PASSWORD } },
    });

    const res = await call(client, 'db_query', { conn: 'db', sql: 'SELECT 1 AS one' });
    assert.equal(res.isError, false, res.text);
    assert.deepEqual(res.json.rows, [[1]]);
    assert.equal(asked.length, 1, 'один вопрос на доступ к tester@sshd_test');

    const dump = await call(client, 'db_dump', { conn: 'db', schemaOnly: true, to: `dumps/${engine}.sql` });
    assert.equal(dump.isError, false, dump.text);
    assert.equal(dump.json.path, `dumps/${engine}.sql`);
    assert.equal(dump.text.includes(DB_PASSWORD), false);
    assert.equal(asked.length, 1, 'дамп идёт по выданному разрешению');
  });
}

test('readonly спрашивает про каждую запись', { skip: !enabled }, async (t) => {
  const { client, asked } = await connect(t, 'accept');
  await call(client, 'conn_open', { name: 'ro', target: { ...SSH, readonly: true } });

  await call(client, 'ssh_exec', { conn: 'ro', command: 'ls /config' });
  const before = asked.length;
  await call(client, 'ssh_exec', { conn: 'ro', command: 'touch /config/ro-1 && rm /config/ro-1' });
  await call(client, 'ssh_exec', { conn: 'ro', command: 'touch /config/ro-2 && rm /config/ro-2' });
  assert.equal(asked.length - before, 2, asked.join(' | '));
  assert.match(asked.at(-1), /только для чтения/);
});

test('файл рабочей области отдаётся по ссылке, загрузка кладёт его в область', { skip: !enabled }, async (t) => {
  const { client } = await connect(t);
  const form = new FormData();
  form.append('file', new Blob(['содержимое загрузки']), 'загрузка.txt');
  const up = await fetch(`${BASE}/upload?dir=e2e-up`, { method: 'POST', body: form });
  assert.equal(up.status, 200);
  const body = await up.json();
  assert.equal(body.uploaded[0].path, 'e2e-up/загрузка.txt');

  const read = await call(client, 'ws_read', { path: 'e2e-up/загрузка.txt' });
  assert.equal(read.json.content, 'содержимое загрузки');

  const link = await call(client, 'ws_link', { path: 'e2e-up/загрузка.txt' });
  const down = await fetch(link.json.url.replace(/^https?:\/\/[^/]+/, BASE));
  assert.equal(await down.text(), 'содержимое загрузки');

  const escape = await fetch(`${BASE}/files/..%2Fstate%2Fknown_hosts.json`);
  assert.equal(escape.status, 403);
});
