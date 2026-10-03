import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { pick } from '../i18n.js';
import { cfg } from '../config.js';
import * as mise from '../local/mise.js';
import * as jobs from '../local/jobs.js';
import * as ws from '../workspace.js';

// Код агента выполняется в контейнере стенда, в рабочей области: относительные пути в
// коде — это файлы области, туда же ложится то, что скачано с серверов. Версии языков
// берёт mise: tools в вызове, mise.toml каталога (env_use) или глобальные.

/** Ответ инструмента по задаче: завершилась — результат, нет — id и как ждать дальше. */
export function jobReply(outcome) {
  const rep = outcome.report;
  if (!outcome.finished) {
    return {
      data: {
        job: outcome.id,
        status: rep.status,
        дальше: `задача ещё идёт — job_status(id: "${outcome.id}", wait: 50) дождётся и вернёт результат; job_kill остановит`,
        stdout: rep.stdout,
        stderr: rep.stderr,
      },
      command: rep.label,
      stdout: rep.stdout,
      stderr: rep.stderr,
    };
  }
  return {
    data: {
      job: rep.id,
      status: rep.status,
      exitCode: rep.exitCode,
      signal: rep.signal,
      timedOut: rep.timedOut,
      durationMs: rep.durationMs,
      truncated: rep.truncated,
      ...(rep.retried ? { retried: rep.retried } : {}),
      stdout: rep.stdout,
      stderr: rep.stderr,
    },
    ok: rep.exitCode === 0,
    exitCode: rep.exitCode,
    command: rep.label,
    stdout: rep.stdout,
    stderr: rep.stderr,
  };
}

// Как запускать файл с кодом: расширение и команда. Имя — левая часть спецификации mise.
const RUNNERS = {
  python: { ext: 'py', argv: (f) => ['python', f] },
  php: { ext: 'php', argv: (f) => ['php', f] },
  node: { ext: 'mjs', argv: (f) => ['node', f] },
  deno: { ext: 'ts', argv: (f) => ['deno', 'run', '-A', f] },
  bun: { ext: 'ts', argv: (f) => ['bun', 'run', f] },
  ruby: { ext: 'rb', argv: (f) => ['ruby', f] },
  perl: { ext: 'pl', argv: (f) => ['perl', f] },
  lua: { ext: 'lua', argv: (f) => ['lua', f] },
  go: { ext: 'go', argv: (f) => ['go', 'run', f] },
  java: { ext: 'java', argv: (f) => ['java', f] },
  bash: { ext: 'sh', argv: (f) => ['bash', f] },
  sh: { ext: 'sh', argv: (f) => ['sh', f] },
};

// Языки, которые есть в образе без mise: для них tools необязателен.
const BUILTIN = new Set(['bash', 'sh', 'node', 'perl']);

const common = {
  cwd: z.string().optional().describe(pick({ ru: 'каталог рабочей области, по умолчанию корень', en: 'workspace directory, root by default' })),
  env: z.record(z.string()).optional().describe(pick({
    ru: 'переменные: значение, ws:<путь> или secret://<id>',
    en: 'variables: value, ws:<path> or secret://<id>',
  })),
  stdin: z.string().optional(),
  timeout: z.number().int().nonnegative().optional().describe(pick({
    ru: 'секунды жизни процесса; 0 — без потолка (dev-сервер в фоне)',
    en: 'process lifetime in seconds; 0 — no cap (a dev server in the background)',
  })),
  background: z.boolean().optional().describe(pick({
    ru: 'сразу в фон: ответ — id задачи. Без него долгий процесс уходит в фон сам через ~50 с',
    en: 'straight to the background: the reply is a job id. Otherwise a long process goes there by itself after ~50 s',
  })),
};

function timeoutOf(args) {
  if (args.timeout !== undefined) return args.timeout * 1000;
  return args.background ? 0 : cfg.execTimeoutMs;
}

export const tools = [
  {
    name: 'exec',
    group: 'run',
    mutating: true,
    secretRefs: ['env'],
    title: pick({ ru: 'Команда в рабочей среде', en: 'Command in the workspace' }),
    description: pick({
      ru: 'Выполняет команду bash в контейнере стенда, в рабочей области: pip/composer/npm install, сборка, '
        + 'тесты, скрипты над скачанными файлами, git clone. tools — версии mise на этот вызов '
        + '(недостающие ставятся сами). Долгое уходит в фон задачей.',
      en: 'Runs a bash command in the toolkit container, inside the workspace: pip/composer/npm install, '
        + 'builds, tests, scripts over downloaded files, git clone. tools — mise versions for this call '
        + '(missing ones get installed). Long runs move to a background job.',
    }),
    input: {
      command: z.string(),
      tools: z.array(z.string()).optional().describe('python@3.11, php@7.4, node@22…'),
      ...common,
    },
    run: async (args, { secrets }) => jobReply(await jobs.runForeground({
      argv: mise.execArgv(args.tools, ['bash', '-c', args.command]),
      cwd: ws.resolve(args.cwd || '.'),
      env: { ...mise.buildEnv(args.tools), ...args.env },
      stdin: args.stdin,
      timeoutMs: timeoutOf(args),
      label: args.command,
      secrets,
    }, { background: args.background })),
  },

  {
    name: 'run_code',
    group: 'run',
    mutating: true,
    secretRefs: ['env'],
    title: pick({ ru: 'Выполнить код', en: 'Run code' }),
    description: pick({
      ru: `Сохраняет код в файл и выполняет нужной версией языка. tool: ${Object.keys(RUNNERS).join(', ')} `
        + '— с версией через @ (python@3.11, php@7.4). Код видит рабочую область по относительным путям.',
      en: `Saves code to a file and runs it with the requested language version. tool: ${Object.keys(RUNNERS).join(', ')} `
        + '— with a version after @ (python@3.11, php@7.4). The code sees the workspace by relative paths.',
    }),
    input: {
      tool: z.string().describe('python@3.11'),
      code: z.string(),
      args: z.array(z.string()).optional(),
      file: z.string().optional().describe(pick({
        ru: 'куда сохранить код в рабочей области; по умолчанию .tk/run/<метка>/main.<ext>',
        en: 'where to save the code in the workspace; defaults to .tk/run/<stamp>/main.<ext>',
      })),
      ...common,
    },
    run: async (args, { secrets }) => {
      const name = mise.toolName(args.tool);
      const runner = RUNNERS[name];
      if (!runner) {
        throw new Error(`run_code не знает, как запускать «${name}». Есть: ${Object.keys(RUNNERS).join(', ')}. `
          + 'Для остального — exec с tools и своей командой');
      }

      const file = args.file ? ws.resolve(args.file) : ws.output('run', `main.${runner.ext}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, args.code);

      const cwd = ws.resolve(args.cwd || '.');
      const tools = args.tool.includes('@') || !BUILTIN.has(name) ? [args.tool] : [];
      const outcome = await jobs.runForeground({
        argv: mise.execArgv(tools, [...runner.argv(file), ...(args.args || [])]),
        cwd,
        env: { ...mise.buildEnv(tools), ...args.env },
        stdin: args.stdin,
        timeoutMs: timeoutOf(args),
        label: `${args.tool} ${ws.describe(file).path}`,
        kind: 'code',
        secrets,
      }, { background: args.background });

      const reply = jobReply(outcome);
      reply.data.file = ws.describe(file).path;
      return reply;
    },
  },

  {
    name: 'job_list',
    group: 'jobs',
    mutating: false,
    title: pick({ ru: 'Задачи', en: 'Jobs' }),
    description: pick({
      ru: 'Задачи рабочей среды: фоновые команды, код, установки тулчейнов — со статусом и временем.',
      en: 'Workspace jobs: background commands, code runs, toolchain installs — with status and timing.',
    }),
    input: {},
    run: () => ({ data: { jobs: jobs.list() } }),
  },

  {
    name: 'job_status',
    group: 'jobs',
    mutating: false,
    title: pick({ ru: 'Состояние задачи', en: 'Job status' }),
    description: pick({
      ru: 'Статус задачи и хвосты stdout/stderr. wait — подождать завершения до стольких секунд. '
        + 'saveTo — положить stdout целиком в файл рабочей области.',
      en: 'Job status and stdout/stderr tails. wait — wait up to that many seconds for it to finish. '
        + 'saveTo — copy the whole stdout into a workspace file.',
    }),
    input: {
      id: z.string(),
      wait: z.number().int().nonnegative().max(Math.floor(cfg.foregroundMs / 1000)).optional(),
      saveTo: z.string().optional(),
    },
    run: async (args) => {
      if (args.wait) await jobs.wait(args.id, args.wait * 1000);
      const rep = jobs.report(args.id);
      if (args.saveTo) {
        const file = ws.resolve(args.saveTo);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        jobs.saveStdout(args.id, file);
        rep.saved = ws.describe(file);
      }
      delete rep.logs;
      return { data: rep };
    },
  },

  {
    name: 'job_kill',
    group: 'jobs',
    mutating: true,
    title: pick({ ru: 'Остановить задачу', en: 'Stop a job' }),
    description: pick({
      ru: 'Останавливает задачу вместе со всем, что она запустила.',
      en: 'Stops a job together with everything it started.',
    }),
    input: { id: z.string() },
    run: (args) => ({ data: jobs.kill(args.id) }),
  },
];
