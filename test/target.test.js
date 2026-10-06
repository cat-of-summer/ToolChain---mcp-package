import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-target-'));
process.env.TK_ROOT = root;

const targets = await import('../src/target.js');
const secretref = await import('../src/secretref.js');
const ws = await import('../src/workspace.js');
const { cfg } = await import('../src/config.js');

test('адрес разбирается в цель', () => {
  assert.deepEqual(targets.parseUrl('ssh://deploy@10.0.0.5:2222/var/www'), {
    host: '10.0.0.5', proto: 'ssh', port: 2222, user: 'deploy', root: '/var/www', cwd: '/var/www',
  });
  assert.deepEqual(targets.parseUrl('ftp://u:p%40ss@ftp.example.com/htdocs'), {
    host: 'ftp.example.com', proto: 'ftp', user: 'u', password: 'p@ss', root: '/htdocs',
  });
  assert.equal(targets.parseUrl('sftp://h').proto, 'ssh', 'sftp — это ssh-цель, файлы по sftp');
  assert.equal(targets.parseUrl('http://h'), null);
  assert.equal(targets.parseUrl('shop-prod'), null);
});

test('пароль из адреса не попадает в журнал', () => {
  assert.equal(targets.safeConn('ftp://u:secret@h/x'), 'ftp://u:****@h/x');
  assert.equal(targets.safeConn('shop-prod'), 'shop-prod');
});

test('подключения живут в своей сессии', () => {
  targets.open('s1', 'shop', { host: 'h1', user: 'u', password: 'p' });
  assert.equal(targets.lookup('s1', 'shop').target.host, 'h1');
  assert.throws(() => targets.lookup('s2', 'shop'), /нет в этой сессии/);
  targets.forget('s1');
  assert.throws(() => targets.lookup('s1', 'shop'), /нет в этой сессии/);
});

test('список подключений без секретов', () => {
  targets.open('s3', 'db', {
    host: 'h', user: 'u', password: 'ssh-пароль',
    db: { engine: 'postgres', database: 'shop', user: 'shop', password: 'пароль-базы' },
  });
  const text = JSON.stringify(targets.list('s3'));
  assert.equal(text.includes('ssh-пароль'), false);
  assert.equal(text.includes('пароль-базы'), false);
  assert.match(text, /"auth":"password"/);
});

test('цель без host и негодное имя отклоняются', () => {
  assert.throws(() => targets.open('s4', 'x', { user: 'u' }), /не задан host/);
  assert.throws(() => targets.open('s4', '-bad', { host: 'h' }), /не годится/);
  assert.doesNotThrow(() => targets.open('s4', 'cloud', {
    db: { engine: 'postgres', database: 'd', user: 'u', host: 'db.cloud', via: 'direct' },
  }), 'база в облаке без SSH обходится без host');
});

test('materialize разрешает секреты и собирает объект транспорта', async () => {
  fs.mkdirSync(path.join(ws.ensure(), 'keys'), { recursive: true });
  fs.writeFileSync(path.join(ws.ensure(), 'keys', 'pw'), 'пароль-из-файла\n');

  const { resolved, values } = await targets.materialize({
    host: 'h', user: 'deploy', password: 'ws:keys/pw',
    db: { engine: 'mysql', database: 'shop', user: 'shop', password: 'литерал' },
  }, { kind: 'db', label: 'shop' });

  assert.equal(resolved.host.secret(), 'пароль-из-файла', 'хвостовой перевод строки срезан');
  assert.equal(resolved.db.password, 'литерал');
  assert.equal(resolved.port, 3306);
  assert.equal(resolved.config.via, 'tunnel');
  assert.deepEqual(values.sort(), ['литерал', 'пароль-из-файла'].sort());
});

test('ftp-цель получает свои реквизиты', async () => {
  const { resolved } = await targets.materialize(
    { host: 'f', proto: 'ftps', user: 'u', password: 'p' },
    { kind: 'files', label: 'f' },
  );
  assert.equal(resolved.config.proto, 'ftps');
  assert.equal(resolved.host, null);
  assert.deepEqual(resolved.ftp, { address: 'f', port: 21, username: 'u', password: 'p', secure: true });
});

test('ключ хоста закрепляется по адресу и порту', () => {
  assert.equal(targets.pinned('h', 22), null);
  targets.pin('h', 22, 'SHA256:abc');
  assert.equal(targets.pinned('h', 22), 'SHA256:abc');
  assert.equal(targets.pinned('h', 2222), null);
});

test('secret:// без резолвера отказывает понятно', async () => {
  await assert.rejects(secretref.resolveValue('secret://shop/db'), /не настроен/);
});

test('ws: вне области и несуществующий файл отклоняются', async () => {
  await assert.rejects(secretref.resolveValue('ws:../../etc/passwd'), /за пределы/);
  await assert.rejects(secretref.resolveValue('ws:нет/такого'), /нет в рабочей области/);
});

test('secret:// разрешается сервисом секретов', async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    assert.equal(req.headers.authorization, 'Bearer test-token');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ value: `значение для ${url.searchParams.get('ref')}` }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cfg.secretResolverUrl = `http://127.0.0.1:${server.address().port}/resolve`;
  cfg.secretResolverToken = 'test-token';
  try {
    assert.equal(await secretref.resolveValue('secret://shop/db'), 'значение для secret://shop/db');
    const { map, values } = await secretref.resolveMap({ A: 'secret://a', B: 'просто' });
    assert.deepEqual(map, { A: 'значение для secret://a', B: 'просто' });
    assert.deepEqual(values, ['значение для secret://a'], 'в вычистку идут только разрешённые ссылки');
  } finally {
    cfg.secretResolverUrl = '';
    server.close();
  }
});

test('ключ разрешения — user@host того, куда идёт вызов', () => {
  const ssh = { host: 'h1', user: 'deploy', db: { engine: 'mysql', database: 'shop', user: 'shop' } };
  assert.equal(targets.accessKeyOf(ssh, 'shell'), 'deploy@h1');
  assert.equal(targets.accessKeyOf(ssh, 'db'), 'deploy@h1', 'база через туннель — тот же вход по SSH');
  assert.equal(targets.accessKeyOf({ host: 'h1', proto: 'ftp', user: 'ftpuser' }, 'files'), 'ftpuser@h1');
  const cloud = { db: { engine: 'postgres', via: 'direct', host: 'db.cloud', user: 'app' } };
  assert.equal(targets.accessKeyOf(cloud, 'db'), 'app@db.cloud');
  assert.equal(targets.accessKeyOf({ host: 'h2' }, 'shell'), 'h2', 'без пользователя — адрес');
});
