import { z } from 'zod';
import { pick } from '../i18n.js';
import { cfg } from '../config.js';
import { connect, exec, quote } from '../transport/ssh.js';
import { withFiles } from '../transport/files.js';
import * as targets from '../target.js';
import * as gate from '../approve/gate.js';
import * as ws from '../workspace.js';
import { writeSigns, scriptSigns } from '../shellguard.js';

const GROUP = 'ssh';

function shape(res) {
  return {
    exitCode: res.code,
    signal: res.signal,
    timedOut: res.timedOut,
    truncated: res.truncated,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

// Параметры, общие для команды и скрипта: переменные окружения и куда девать stdout.
const common = {
  env: z.record(z.string()).optional().describe(pick({
    ru: 'переменные: значение, ws:<путь> или secret://<id>',
    en: 'variables: value, ws:<path> or secret://<id>',
  })),
  saveTo: z.string().optional().describe(pick({
    ru: 'stdout целиком в файл рабочей области, без потолка; в ответе путь, размер, sha256',
    en: 'whole stdout into a workspace file, no cap; the reply has the path, size, sha256',
  })),
  timeout: z.number().int().positive().optional().describe(pick({ ru: 'секунды', en: 'seconds' })),
};

/** Выполняет и собирает ответ: stdout в тексте либо в файле рабочей области. */
async function run(client, command, args, { resolved, secrets, stdin, label }) {
  const file = args.saveTo ? ws.output('ssh', 'stdout.txt', args.saveTo) : null;

  const res = await exec(client, command, {
    cwd: args.cwd || resolved.config.cwd,
    stdin,
    vars: args.env,
    timeoutMs: args.timeout ? args.timeout * 1000 : cfg.execTimeoutMs,
    stdoutTo: file ? { file, secrets } : undefined,
  });

  if (!file) {
    return { data: shape(res), ok: res.code === 0, exitCode: res.code, command: label ?? res.command, stdout: res.stdout, stderr: res.stderr };
  }

  const where = ws.describe(file);
  return {
    data: {
      exitCode: res.code,
      signal: res.signal,
      timedOut: res.timedOut,
      ...where,
      bytes: res.file.bytes,
      sha256: res.file.sha256,
      stderr: res.stderr,
    },
    ok: res.code === 0,
    exitCode: res.code,
    command: label ?? res.command,
    stdout: `(stdout в ${where.path}, ${res.file.bytes} Б, sha256:${res.file.sha256})`,
    stderr: res.stderr,
  };
}

const envNames = (args) => (args.env ? Object.keys(args.env).join(', ') : undefined);

export const tools = [
  {
    name: 'conn_open',
    group: GROUP,
    mutating: false,
    title: pick({ ru: 'Открыть подключение', en: 'Open a connection' }),
    description: pick({
      ru: 'Запоминает цель под именем до конца сессии, чтобы не повторять реквизиты в каждом вызове: '
        + 'дальше ssh_*, files_*, docker_*, db_* принимают conn: "имя". На диск ничего не пишется. '
        + 'Секретные поля — значением, файлом рабочей области (ws:keys/id_ed25519) или ссылкой secret://<id>. '
        + 'Сервер не трогается: проверить вход — conn_check. access — спросить доступ к user@host сразу, '
        + 'одним вопросом: write, если работа точно с записью, — тогда ни чтение, ни запись дальше не спросят.',
      en: 'Remembers a target under a name until the session ends, so credentials are not repeated: '
        + 'ssh_*, files_*, docker_*, db_* then take conn: "name". Nothing is written to disk. Secret '
        + 'fields take a value, a workspace file (ws:keys/id_ed25519) or a secret://<id> reference. '
        + 'The server is not contacted: use conn_check to test the login. access asks for user@host access '
        + 'up front in one question: write when the work surely writes — then neither reads nor writes ask again.',
    }),
    input: {
      name: z.string().describe(pick({ ru: 'имя, например shop-prod', en: 'name, e.g. shop-prod' })),
      target: targets.targetSchema,
      access: z.enum(['read', 'write']).optional().describe(pick({
        ru: 'спросить доступ сразу: read или write (запись включает чтение)',
        en: 'ask for access right away: read or write (write includes read)',
      })),
    },
    run: async (args, { ctx }) => {
      const opened = targets.open(ctx.sessionId, args.name, args.target);
      if (!args.access) return { data: { name: args.name, ...opened } };

      const target = targets.lookup(ctx.sessionId, args.name).target;
      const key = targets.accessKeyOf(target, target.host ? 'shell' : 'db');
      const approval = await gate.authorize(ctx, {
        tool: 'conn_open',
        target: targets.labelOf(target),
        key,
        mutating: args.access === 'write',
        summary: `агент открыл «${args.name}» и заранее просит ${args.access === 'write' ? 'чтение и запись' : 'чтение'}`,
      });
      return { data: { name: args.name, ...opened, доступ: { [key]: approval.level ?? `не спрашивается (TK_APPROVAL=${cfg.approval})` } } };
    },
  },

  {
    name: 'conn_list',
    group: GROUP,
    mutating: false,
    title: pick({ ru: 'Открытые подключения', en: 'Open connections' }),
    description: pick({
      ru: 'Подключения, открытые в этой сессии conn_open, — без секретов.',
      en: 'Connections opened in this session with conn_open — no secrets.',
    }),
    input: {},
    run: (_args, { ctx }) => ({ data: { connections: targets.list(ctx.sessionId) } }),
  },

  {
    name: 'conn_close',
    group: GROUP,
    mutating: false,
    title: pick({ ru: 'Закрыть подключение', en: 'Close a connection' }),
    description: pick({
      ru: 'Забывает имя, открытое conn_open. Живое SSH-соединение закроется само по простою.',
      en: 'Forgets a name opened with conn_open. A live SSH connection closes by itself when idle.',
    }),
    input: { name: z.string() },
    run: (args, { ctx }) => ({ data: { closed: targets.close(ctx.sessionId, args.name) } }),
  },

  {
    name: 'conn_check',
    group: GROUP,
    // files — вид, который принимает и ssh, и ftp: проверить вход нужно у обоих.
    remote: 'files',
    mutating: false,
    title: pick({ ru: 'Проверить вход', en: 'Check the login' }),
    description: pick({
      ru: 'Входит на сервер и возвращает uname, пользователя и отпечаток ключа хоста. Для ftp/ftps — '
        + 'вход и список корня. Ничего не меняет.',
      en: 'Logs into the server and returns uname, the user and the host key fingerprint. For ftp/ftps — '
        + 'login and a root listing. Changes nothing.',
    }),
    input: { conn: targets.connParam },
    run: async (_args, { resolved, approveHostKey }) => {
      if (resolved.config.proto !== 'sftp') {
        const root = resolved.config.root || '/';
        const entries = await withFiles(resolved, {}, (api) => api.list(root));
        return { data: { ok: true, proto: resolved.config.proto, root, entries: entries.length } };
      }
      const client = await connect(resolved.host, { approveHostKey });
      const res = await exec(client, 'uname -a; id -un; pwd', { cwd: resolved.config.cwd });
      const [uname, user, cwd] = res.stdout.trim().split('\n');
      return { data: { ok: res.code === 0, uname, user, cwd, hostKey: resolved.host.pinnedKey } };
    },
  },

  {
    name: 'ssh_exec',
    group: GROUP,
    remote: 'shell',
    mutating: true,
    secretRefs: ['env'],
    writeSigns: (args) => writeSigns(args.command),
    title: pick({ ru: 'Выполнить команду', en: 'Run a command' }),
    description: pick({
      ru: 'Выполняет команду на сервере. Возвращает код возврата и оба потока; большой вывод — saveTo. '
        + 'Секреты для команды — в env ссылкой (ws:…, secret://…): значение не попадёт ни в строку команды, '
        + 'ни в ps на сервере, ни в журнал.',
      en: 'Runs a command on the server. Returns the exit code and both streams; large output — saveTo. '
        + 'Secrets for the command go in env as references (ws:…, secret://…): the value never appears in '
        + 'the command line, in ps on the server or in the journal.',
    }),
    input: {
      conn: targets.connParam,
      command: z.string().describe(pick({ ru: 'команда как в шелле', en: 'command as typed in a shell' })),
      cwd: z.string().optional(),
      stdin: z.string().optional(),
      ...common,
    },
    summary: (args, info) => `Выполнить на «${info.label}»: ${args.command}`,
    details: (args, info) => ({
      каталог: args.cwd || info.target.cwd || '—',
      переменные: envNames(args),
    }),
    run: async (args, { resolved, approveHostKey, secrets }) => {
      const client = await connect(resolved.host, { approveHostKey });
      return run(client, args.command, args, { resolved, secrets, stdin: args.stdin, label: null });
    },
  },

  {
    name: 'ssh_script',
    group: GROUP,
    remote: 'shell',
    mutating: true,
    secretRefs: ['env'],
    writeSigns: (args, info) => scriptSigns(args.script, args.interpreter || info?.target?.shell || 'sh'),
    title: pick({ ru: 'Выполнить скрипт', en: 'Run a script' }),
    description: pick({
      ru: 'Отдаёт многострочный скрипт интерпретатору на сервере через stdin. Годится там, где '
        + 'команда не влезает в одну строку: цепочка с условиями, heredoc, кавычки внутри кавычек.',
      en: 'Feeds a multi-line script to an interpreter on the server via stdin. For cases a single '
        + 'command line cannot hold: conditionals, heredocs, quotes inside quotes.',
    }),
    input: {
      conn: targets.connParam,
      script: z.string(),
      interpreter: z.string().optional().describe(pick({ ru: 'по умолчанию sh', en: 'defaults to sh' })),
      cwd: z.string().optional(),
      ...common,
    },
    summary: (args, info) => `Выполнить скрипт на «${info.label}», ${args.script.split('\n').length} строк`,
    details: (args) => ({ скрипт: args.script.slice(0, 1500), переменные: envNames(args) }),
    run: async (args, { resolved, approveHostKey, secrets }) => {
      const client = await connect(resolved.host, { approveHostKey });
      const interpreter = args.interpreter || resolved.config.shell || 'sh';
      return run(client, `${quote(interpreter)} -s`, args, {
        resolved,
        secrets,
        stdin: args.script,
        label: `${interpreter} -s <<< (${args.script.split('\n').length} строк)`,
      });
    },
  },
];
