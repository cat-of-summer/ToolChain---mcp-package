import { z } from 'zod';
import { pick } from '../i18n.js';
import { cfg } from '../config.js';
import { connParam } from '../target.js';
import { run as dockerRun, compose as dockerCompose, container, quote } from '../transport/docker.js';

const GROUP = 'docker';

function shape(res) {
  return {
    exitCode: res.code,
    timedOut: res.timedOut,
    truncated: res.truncated,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

// Для чтения ненулевой код — ошибка: «docker: not found» не должен выглядеть как пустой список.
function expectOk(res) {
  if (res.code === 0) return res;
  const reason = (res.stderr || res.stdout || '').trim().split(/\r?\n/)[0] || `код ${res.code}`;
  throw new Error(`docker на хосте ответил ошибкой: ${reason}`);
}

function outcome(res) {
  return {
    data: shape(res),
    ok: res.code === 0,
    exitCode: res.code,
    command: res.command,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

export const tools = [
  {
    name: 'docker_ps',
    group: GROUP,
    remote: 'docker',
    mutating: false,
    title: pick({ ru: 'Контейнеры на сервере', en: 'Containers on the server' }),
    description: pick({
      ru: 'Показывает контейнеры удалённого сервера: имя, образ, состояние, порты. Docker вызывается '
        + 'своим CLI по SSH — сокет наружу не торчит и второго набора кредов не нужно.',
      en: 'Lists containers on the remote server: name, image, state, ports. Docker is driven by its own '
        + 'CLI over SSH — no socket exposed, no second set of credentials.',
    }),
    input: { conn: connParam, all: z.boolean().optional() },
    run: async (args, { resolved, approveHostKey }) => {
      const argv = ['ps', args.all ? '-a' : '', '--format', quote('{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}')]
        .filter(Boolean);
      const res = expectOk(await dockerRun(resolved, argv, { approveHostKey }));
      const rows = res.stdout.trim().split('\n').filter(Boolean).map((line) => {
        const [name, image, state, status, ports] = line.split('\t');
        return { name, image, state, status, ports };
      });
      return { ...outcome(res), data: { containers: rows } };
    },
  },

  {
    name: 'docker_logs',
    group: GROUP,
    remote: 'docker',
    mutating: false,
    title: pick({ ru: 'Логи контейнера', en: 'Container logs' }),
    description: pick({
      ru: 'Хвост логов контейнера. Контейнер по умолчанию — docker.container цели.',
      en: 'Tail of a container log. The container defaults to the target docker.container.',
    }),
    input: {
      conn: connParam,
      container: z.string().optional(),
      tail: z.number().int().positive().optional(),
      since: z.string().optional().describe(pick({ ru: 'например 30m или 2h', en: 'e.g. 30m or 2h' })),
    },
    run: async (args, { resolved, approveHostKey }) => {
      const argv = ['logs', '--tail', String(args.tail || 200)];
      if (args.since) argv.push('--since', quote(args.since));
      argv.push(quote(container(resolved, args.container)));
      const res = expectOk(await dockerRun(resolved, argv, { approveHostKey }));
      return { ...outcome(res), data: { container: container(resolved, args.container), log: res.stdout + res.stderr } };
    },
  },

  {
    name: 'docker_inspect',
    group: GROUP,
    remote: 'docker',
    mutating: false,
    title: pick({ ru: 'Разбор контейнера', en: 'Inspect a container' }),
    description: pick({
      ru: 'Полное описание контейнера: образ, переменные, монтирования, сеть, состояние.',
      en: 'Full container description: image, environment, mounts, network, state.',
    }),
    input: { conn: connParam, container: z.string().optional() },
    run: async (args, { resolved, approveHostKey }) => {
      const name = container(resolved, args.container);
      const res = expectOk(await dockerRun(resolved, ['inspect', quote(name)], { approveHostKey }));
      let parsed = null;
      try { parsed = JSON.parse(res.stdout); } catch { /* вернём как есть */ }
      return { ...outcome(res), data: parsed ? { container: name, inspect: parsed } : shape(res) };
    },
  },

  {
    name: 'docker_exec',
    group: GROUP,
    remote: 'docker',
    mutating: true,
    title: pick({ ru: 'Команда в контейнере', en: 'Command inside a container' }),
    description: pick({
      ru: 'Выполняет команду внутри контейнера на удалённом сервере.',
      en: 'Runs a command inside a container on the remote server.',
    }),
    input: {
      conn: connParam,
      command: z.string(),
      container: z.string().optional(),
      user: z.string().optional(),
      workdir: z.string().optional(),
      timeout: z.number().int().positive().optional(),
    },
    summary: (args, info) => `Выполнить в контейнере «${args.container || info.target.docker?.container}» `
      + `на «${info.label}»: ${args.command}`,
    run: async (args, { resolved, approveHostKey }) => {
      const name = container(resolved, args.container);
      const argv = ['exec'];
      if (args.user) argv.push('-u', quote(args.user));
      if (args.workdir) argv.push('-w', quote(args.workdir));
      argv.push(quote(name), 'sh', '-c', quote(args.command));

      const res = await dockerRun(resolved, argv, {
        approveHostKey,
        timeoutMs: args.timeout ? args.timeout * 1000 : cfg.execTimeoutMs,
      });
      return outcome(res);
    },
  },

  {
    name: 'docker_restart',
    group: GROUP,
    remote: 'docker',
    mutating: true,
    title: pick({ ru: 'Перезапустить контейнер', en: 'Restart a container' }),
    description: pick({
      ru: 'Перезапускает, останавливает или запускает контейнер.',
      en: 'Restarts, stops or starts a container.',
    }),
    input: {
      conn: connParam,
      container: z.string().optional(),
      action: z.enum(['restart', 'stop', 'start']).optional(),
    },
    summary: (args, info) => `${args.action || 'restart'} контейнера «${args.container || info.target.docker?.container}» `
      + `на «${info.label}»`,
    run: async (args, { resolved, approveHostKey }) => {
      const name = container(resolved, args.container);
      const res = await dockerRun(resolved, [args.action || 'restart', quote(name)], { approveHostKey });
      return outcome(res);
    },
  },

  {
    name: 'docker_compose',
    group: GROUP,
    remote: 'docker',
    mutating: true,
    title: pick({ ru: 'docker compose', en: 'docker compose' }),
    description: pick({
      ru: 'Выполняет команду docker compose в каталоге проекта на сервере: up -d, pull, ps, logs. '
        + 'Файл compose и рабочий каталог — docker.composeFile и docker.workdir цели.',
      en: 'Runs a docker compose command in the project directory on the server: up -d, pull, ps, logs. '
        + 'The compose file and workdir are the target docker.composeFile and docker.workdir.',
    }),
    input: {
      conn: connParam,
      args: z.array(z.string()).describe(pick({ ru: 'например ["up", "-d"]', en: 'e.g. ["up", "-d"]' })),
      timeout: z.number().int().positive().optional(),
    },
    summary: (args, info) => `docker compose ${args.args.join(' ')} на «${info.label}» `
      + `(${info.target.docker?.composeFile || info.target.docker?.workdir || 'каталог по умолчанию'})`,
    run: async (args, { resolved, approveHostKey }) => {
      const res = await dockerCompose(resolved, args.args.map(quote), {
        approveHostKey,
        timeoutMs: args.timeout ? args.timeout * 1000 : cfg.execTimeoutMs,
      });
      return outcome(res);
    },
  },
];
