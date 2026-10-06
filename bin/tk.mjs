#!/usr/bin/env node
// tk — работа со стендом руками, без агента: состояние, подтверждения, журнал, задачи.
// Подтверждения и задачи живут в памяти сервера, поэтому команда ходит в его HTTP API,
// а не в файлы: так она видит ровно то, что видит агент.

import fs from 'node:fs';
import { cfg } from '../src/config.js';
import { DIRS } from '../src/paths.js';
import * as query from '../src/audit/query.js';
import * as mise from '../src/local/mise.js';

const base = `http://127.0.0.1:${cfg.port}`;
const [, , command, sub, ...rest] = process.argv;

const out = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));

async function api(path, init) {
  const res = await fetch(`${base}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

const HELP = `tk — стенд Toolkit руками

  tk doctor                      состояние: сервер, mise, каталоги, OpenSSL для php 5/7
  tk approve ls                  что ждёт разрешения
  tk approve yes|no <id>         разрешить (что спросили) или отказать
  tk approve read|write <id>     доступ к серверу: только чтение или чтение и запись
  tk log tail [N]                последние действия
  tk log show <id>               запись журнала целиком
  tk mise <аргументы>            mise с окружением стенда (например: tk mise ls)`;

async function doctor() {
  const report = {};
  try {
    report.сервер = await api('/health');
  } catch (err) {
    report.сервер = `не отвечает на ${base}: ${err.message}`;
  }
  report.mise = await mise.version();
  report.каталоги = Object.fromEntries(Object.entries(DIRS).map(([name, dir]) => [name, fs.existsSync(dir) ? dir : `${dir} — нет`]));
  report.opensslДляPhp57 = fs.existsSync(`${mise.LEGACY_OPENSSL}/lib/libssl.so.1.1`)
    ? mise.LEGACY_OPENSSL
    : `нет ${mise.LEGACY_OPENSSL} — php@5 и php@7 не соберутся`;
  report.резолверСекретов = cfg.secretResolverUrl || 'не настроен';
  out(report);
}

async function main() {
  switch (command) {
    case 'doctor':
      return doctor();

    case 'approve':
      if (sub === 'ls' || !sub) return out((await api('/api/approvals')).pending);
      if (['yes', 'no', 'read', 'write'].includes(sub) && rest[0]) {
        const decision = { yes: 'approved', no: 'declined' }[sub] ?? sub;
        return out(await api(`/api/approvals/${rest[0]}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision }),
        }));
      }
      break;

    case 'log':
      if (sub === 'tail' || !sub) return out(query.list({ limit: Number(rest[0]) || 20 }));
      if (sub === 'show' && rest[0]) return out(query.get(rest[0]) ?? `записи «${rest[0]}» нет`);
      break;

    case 'mise': {
      const { spawnSync } = await import('node:child_process');
      const args = [sub, ...rest].filter(Boolean);
      const res = spawnSync(mise.MISE, args, { stdio: 'inherit', env: { ...process.env, ...mise.buildEnv(args) } });
      process.exitCode = res.status ?? 1;
      return undefined;
    }

    default:
      break;
  }
  out(HELP);
  return undefined;
}

main().catch((err) => {
  console.error(`tk: ${err.message}`);
  process.exitCode = 1;
});
