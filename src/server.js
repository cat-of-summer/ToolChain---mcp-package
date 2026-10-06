import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { cfg } from './config.js';
import { pick } from './i18n.js';
import { select } from './tools/groups.js';
import { wrap } from './tools/shared.js';
import { TOPICS } from './tools/help.js';
import * as query from './audit/query.js';
import { checkForUpdate, updateNotice } from './update.js';

// Инструкции клиент показывает модели при подключении. Здесь не список инструментов —
// его модель и так видит, — а то, чего в списке не видно: как устроен обмен файлами,
// откуда берутся реквизиты и что произойдёт при изменяющем вызове.
function instructions(groups, notice) {
  const local = groups.some((g) => ['env', 'run', 'jobs', 'ws'].includes(g));
  const remote = groups.some((g) => ['ssh', 'files', 'docker', 'db'].includes(g));

  const ru = [
    'Стенд — рабочая среда агента и прослойка к удалённым серверам.',
    ...(local ? [
      '',
      'Рабочая среда — контейнер стенда с рабочей областью (свой каталог, не папки машины человека).',
      'Языки ставит mise: tools: ["python@3.11"] в exec/run_code или env_use для каталога; php и ruby',
      'собираются минуты — такой вызов вернёт id задачи, дождитесь её job_status с wait.',
      `Файл с машины человека: curl -F file=@путь "${cfg.publicBaseUrl}/upload?dir=uploads"; обратно — ws_link.`,
      '',
      'Нет python, php или утилиты на машине человека — не повод переходить на bash и разбирать вручную:',
      'тот же код запускается здесь (run_code с tool: "python@3.11"). Задачу, которую проще решить кодом,',
      'решайте кодом; повторится — сохраните скрипт в tools/bin рабочей области (он в PATH, описание —',
      'первой строкой) и вызывайте по имени. Перед новым скриптом проверьте свои в toolkit_info — help tools.',
    ] : []),
    ...(remote ? [
      '',
      'Стенд доступов не хранит: реквизиты приходят в вызове. Откройте цель conn_open(name, target) —',
      'дальше ssh_*, files_*, docker_*, db_* берут conn: "name". Пароль или ключ — значением, файлом',
      'рабочей области (ws:путь) или ссылкой secret://<id>; из ответов и журнала они вычищаются.',
      'Файлы ходят через рабочую область: files_get кладёт туда, files_put берёт оттуда.',
      'Доступ спрашивается на user@host и по разу за сессию: первый вызов — чтение (человек может сразу',
      'дать и запись), первый изменяющий — запись; дальше молча. Будете писать — conn_open(access: "write"),',
      'один вопрос на всё. Отказ и таймаут — обычный исход: сообщите о нём и не обходите другим инструментом.',
    ] : []),
    '',
    `Подробности — help (разделы: ${Object.keys(TOPICS).join(', ')}), состояние — toolkit_info.`,
    `Поднятые группы инструментов: ${groups.join(', ')}.`,
  ];

  const en = [
    'The toolkit is the agent\'s workspace and a layer over remote servers.',
    ...(local ? [
      '',
      'The workspace is the toolkit container with its own directory (not the human\'s folders).',
      'Languages come from mise: tools: ["python@3.11"] in exec/run_code or env_use for a directory; php and',
      'ruby compile for minutes — such a call returns a job id, wait for it with job_status and wait.',
      `A file from the human's machine: curl -F file=@path "${cfg.publicBaseUrl}/upload?dir=uploads"; back — ws_link.`,
      '',
      'No python, php or a utility on the human\'s machine is no reason to fall back to bash and manual parsing:',
      'the same code runs here (run_code with tool: "python@3.11"). Solve as code what is easier as code; if it',
      'will repeat, save the script to the workspace\'s tools/bin (on PATH, purpose in the first line) and call it',
      'by name. Before writing a new one check your own in toolkit_info — help tools.',
    ] : []),
    ...(remote ? [
      '',
      'The toolkit stores no credentials: they come with the call. Open a target with conn_open(name, target);',
      'then ssh_*, files_*, docker_*, db_* take conn: "name". A password or key goes as a value, a workspace',
      'file (ws:path) or a secret://<id> reference; it is scrubbed from replies and the journal.',
      'Files travel through the workspace: files_get puts them there, files_put takes them from there.',
      'Access is asked per user@host, once per session and level: the first call asks for reading (the human',
      'may grant writing right away), the first mutating one — for writing; then silence. Going to write —',
      'conn_open(access: "write"), one question for all. A refusal or a timeout is a normal outcome: report it',
      'and do not route around it with another tool.',
    ] : []),
    '',
    `Details — help (topics: ${Object.keys(TOPICS).join(', ')}), state — toolkit_info.`,
    `Active tool groups: ${groups.join(', ')}.`,
  ];

  const text = pick({ ru: ru.join('\n'), en: en.join('\n') });
  // Уведомление об обновлении — частью инструкций: агент должен увидеть его, не вызывая ничего.
  return notice ? `${text}\n\n${notice}` : text;
}

/*
 * Проверка обновлений запускается один раз на процесс и переживает переподключения:
 * спрашивать GitHub на каждой новой сессии незачем.
 */
let updatePromise = null;
export const update = () => (updatePromise ??= checkForUpdate().catch(() => null));

export async function createServer({ spec = 'all' } = {}) {
  const { groups, tools } = select(spec);
  const updateState = await update();

  const server = new McpServer(
    { name: 'toolkit', version: cfg.version },
    { instructions: instructions(groups, updateNotice(updateState)) },
  );

  const ctx = { server, groups, toolCount: tools.length, update: updateState };

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
