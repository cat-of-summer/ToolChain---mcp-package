import test from 'node:test';
import assert from 'node:assert/strict';
import { command, program, explainDenied } from '../src/transport/db/remote.js';
import * as mysql from '../src/transport/db/mysql.js';
import * as pg from '../src/transport/db/pg.js';

const base = { host: '127.0.0.1', port: 3306, database: 'shop', username: 'shop' };

test('mysql на сервере: сокет вместо -h/-P, клиент mariadb или mysql', () => {
  const tcp = command(base, 'mysql').line;
  assert.match(tcp, /'-h' '127\.0\.0\.1' '-P' '3306'/);

  const sock = command({ ...base, socket: '/run/mysqld/mysqld.sock' }, 'mysql').line;
  assert.match(sock, /'--socket=\/run\/mysqld\/mysqld\.sock'/);
  assert.equal(sock.includes("'-h'"), false, 'адреса при сокете нет');
  assert.ok(sock.startsWith(program('mysql')));
  assert.equal(program('mysql'), '"$(command -v mariadb || command -v mysql || echo mysql)"');
  assert.equal(program('psql'), "'psql'");
});

test('psql на сервере: каталог сокета уходит в -h', () => {
  const line = command({ ...base, port: 5432, socket: '/var/run/postgresql' }, 'postgres').line;
  assert.match(line, /'-h' '\/var\/run\/postgresql' '-p' '5432'/);
});

test('дамп через сокет', () => {
  const my = mysql.dumpArgv({ ...base, socket: '/run/mysqld/mysqld.sock' });
  assert.ok(my.includes('--socket=/run/mysqld/mysqld.sock'));
  assert.equal(my.includes('-h'), false);
  assert.deepEqual(mysql.dumpArgv(base).slice(4, 8), ['-h', '127.0.0.1', '-P', '3306']);

  const p = pg.dumpArgv({ ...base, port: 5432, socket: '/var/run/postgresql' });
  assert.deepEqual(p.slice(3, 7), ['-h', '/var/run/postgresql', '-p', '5432']);
});

test('сокет postgres — каталогом или файлом', () => {
  assert.deepEqual(pg.socketPaths('/var/run/postgresql/', 5432), {
    dir: '/var/run/postgresql', port: 5432, file: '/var/run/postgresql/.s.PGSQL.5432',
  });
  assert.deepEqual(pg.socketPaths('/tmp/.s.PGSQL.5433', 5432), { dir: '/tmp', port: 5433, file: '/tmp/.s.PGSQL.5433' });
});

test('отказ с 127.0.0.1 подсказывает db.socket', () => {
  const my = "ERROR 1045 (28000): Access denied for user 'shop'@'127.0.0.1' (using password: YES)";
  assert.match(explainDenied(my), /db\.socket/);
  assert.match(explainDenied('no pg_hba.conf entry for host "127.0.0.1", user "shop", database "shop"'), /db\.socket/);
  assert.equal(explainDenied(my, { socket: '/run/mysqld/mysqld.sock' }), my, 'через сокет советовать нечего');
  assert.equal(explainDenied("Access denied for user 'shop'@'10.0.0.7'"), "Access denied for user 'shop'@'10.0.0.7'");
});
