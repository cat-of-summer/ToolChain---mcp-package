import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { cfg } from './config.js';
import { pick } from './i18n.js';
import { select } from './tools/groups.js';
import { wrap } from './tools/shared.js';
import { TOPICS } from './tools/help.js';
import * as query from './audit/query.js';
import { checkForUpdate, updateNotice } from './update.js';
import { summary as installedSummary } from './local/lifecycle.js';
import { projectsMounted } from './workspace.js';

// Инструкции клиент показывает модели при подключении. Здесь не список инструментов —
// его модель и так видит, — а то, чего в списке не видно: что стенд заменяет docker run,
// что в нём уже стоит, как устроен обмен файлами и что произойдёт при изменяющем вызове.
// Клиенты обрезают длинные инструкции (около 2 КБ) — текст держится в этом потолке, а
// уведомление об обновлении идёт первым, чтобы обрезка его не съела.
export const INSTRUCTIONS_MAX = 2000;

export function instructions(groups, { notice, installed, projects }) {
  const local = groups.some((g) => ['env', 'run', 'jobs', 'ws'].includes(g));
  const remote = groups.some((g) => ['ssh', 'files', 'docker', 'db'].includes(g));

  const ru = [
    'Стенд — рабочая среда агента и прослойка к удалённым серверам.',
    ...(local ? [
      '',
      'Нужен php, python, node, утилита — exec и run_code здесь, а не docker run и не ручной разбор в bash: '
        + 'версия через tools: ["php@8.1"]'
        + (projects ? `, cwd — проект хоста (${projects}<проект>).` : ', файлы — в рабочей области.'),
      ...(installed ? [`Уже стоят: ${installed}.`] : []),
      'Новую php mise собирает минуты один раз. LibreOffice, pdf, ocr, ffmpeg — env_install kit:office|pdf|ocr|media. '
        + 'Новое стенд спрашивает у человека: публично, разово или приватно.',
      `Файл с машины человека: curl -F file=@путь "${cfg.publicBaseUrl}/upload?dir=uploads"; обратно — ws_link.`,
      'Повторится — скрипт в tools/bin (в PATH, описание первой строкой; свои — toolkit_info).',
    ] : []),
    ...(remote ? [
      '',
      'Доступов стенд не хранит: conn_open(name, target), дальше ssh_*, files_*, docker_*, db_* с conn: "name". '
        + 'Пароль, ключ — значением, ws:путь или secret://<id>; из ответов и журнала вычищаются. '
        + 'Файлы — через рабочую область: files_get туда, files_put оттуда.',
      'Доступ спрашивается на user@host раз за сессию: чтение, первая запись — ещё раз (conn_open(access: "write") — '
        + 'сразу). Отказ действует до конца сессии, таймаут — нет: сообщите человеку, не обходите другим инструментом.',
      'readonly: true — только по просьбе человека. SQL — db_query (via: "exec", db.socket), а не mysql -e в shell.',
    ] : []),
    '',
    `Подробности — help (${Object.keys(TOPICS).join(', ')}), состояние — toolkit_info.`,
  ];

  const en = [
    'The toolkit is the agent\'s workspace and a layer over remote servers.',
    ...(local ? [
      '',
      'Need php, python, node, a utility — exec and run_code here, not docker run and not manual parsing in bash: '
        + 'the version via tools: ["php@8.1"]'
        + (projects ? `, cwd — a host project (${projects}<project>).` : ', files — in the workspace.'),
      ...(installed ? [`Already installed: ${installed}.`] : []),
      'mise compiles a new php once, for minutes. LibreOffice, pdf, ocr, ffmpeg — env_install kit:office|pdf|ocr|media. '
        + 'The toolkit asks the human about new installs: public, once or private.',
      `A file from the human's machine: curl -F file=@path "${cfg.publicBaseUrl}/upload?dir=uploads"; back — ws_link.`,
      'If it repeats — a script in tools/bin (on PATH, purpose in the first line; yours — toolkit_info).',
    ] : []),
    ...(remote ? [
      '',
      'The toolkit stores no credentials: conn_open(name, target), then ssh_*, files_*, docker_*, db_* with conn: "name". '
        + 'A password or key — a value, ws:path or secret://<id>; scrubbed from replies and the journal. '
        + 'Files go through the workspace: files_get there, files_put from there.',
      'Access is asked per user@host once a session: reading, the first write once more (conn_open(access: "write") — '
        + 'at once). A refusal lasts the session, a timeout does not: tell the human, do not route around it.',
      'readonly: true — only when the human asks. SQL — db_query (via: "exec", db.socket), not mysql -e in a shell.',
    ] : []),
    '',
    `Details — help (${Object.keys(TOPICS).join(', ')}), state — toolkit_info.`,
  ];

  const text = pick({ ru: ru.join('\n'), en: en.join('\n') });
  // Уведомление об обновлении — первым: агент должен увидеть его, не вызывая ничего, и обрезка не должна его съесть.
  return notice ? `${notice}\n\n${text}` : text;
}

/*
 * Проверка обновлений запускается один раз на процесс и переживает переподключения:
 * спрашивать GitHub на каждой новой сессии незачем.
 */
let updatePromise = null;
export const update = () => (updatePromise ??= checkForUpdate().catch(() => null));

export async function createServer({ spec = 'all', agent = null } = {}) {
  const { groups, tools } = select(spec);
  const updateState = await update();

  const server = new McpServer(
    { name: 'toolkit', version: cfg.version },
    {
      instructions: instructions(groups, {
        notice: updateNotice(updateState),
        installed: groups.includes('run') ? await installedSummary(agent) : '',
        // Как назвать проект в cwd: путём хоста, если префикс известен, иначе host:.
        projects: !projectsMounted() ? null
          : cfg.projectsHost ? `${cfg.projectsHost.replace(/\\/g, '/').replace(/\/+$/, '')}/` : 'host:',
      }),
    },
  );

  const ctx = { server, groups, toolCount: tools.length, update: updateState, agent };

  for (const def of tools) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input,
        annotations: {
          readOnlyHint: def.mutating === false,
          destructiveHint: def.mutating === true && Boolean(def.remote),
          openWorldHint: Boolean(def.remote),
        },
      },
      wrap(def, ctx),
    );
  }

  registerResources(server);

  return { server, ctx, groups, tools };
}

// Ресурсы дают клиенту закрепить справку в контексте, не тратя на это вызов инструмента.
function registerResources(server) {
  server.registerResource(
    'journal',
    'tk://audit/recent',
    {
      title: pick({ ru: 'Последние действия', en: 'Recent actions' }),
      description: pick({ ru: 'Сводка последних записей журнала', en: 'Summary of the latest journal entries' }),
      mimeType: 'application/json',
    },
    async () => ({
      contents: [{ uri: 'tk://audit/recent', mimeType: 'application/json', text: JSON.stringify(query.list({ limit: 20 }), null, 2) }],
    }),
  );

  for (const [name, text] of Object.entries(TOPICS)) {
    server.registerResource(
      `help-${name}`,
      `tk://help/${name}`,
      { title: `help: ${name}`, mimeType: 'text/markdown' },
      async () => ({ contents: [{ uri: `tk://help/${name}`, mimeType: 'text/markdown', text }] }),
    );
  }
}
