import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { cfg } from '../config.js';
import { LANG, pick } from '../i18n.js';
import { DIRS } from '../paths.js';
import { snapshot } from '../approve/grants.js';
import { pendingCount } from '../approve/queue.js';
import { poolState } from '../transport/ssh.js';
import * as targets from '../target.js';
import * as jobs from '../local/jobs.js';
import * as mise from '../local/mise.js';
import { ownTools } from '../workspace.js';
import { versionsHost } from '../local/reach.js';
import { upgradeSteps } from '../update.js';

const GROUP = 'service';

// Справка по требованию: то, что не влезает в описание инструмента и нужно не на каждом
// вызове. Разделы короткие и про устройство, а не пересказ параметров — их агент видит сам.

const RU = {
  index: `Стенд — рабочая среда агента и прослойка к удалённым серверам.

Локально (в контейнере стенда, в рабочей области):
  env_*   — языки и инструменты через mise: python@3.11, php@7.4, node@latest…
  exec, run_code — команды и код; долгое уходит в фон задачей (job_*)
  tools/bin — скрипты, которые агент пишет себе сам: вызываются по имени, переживают сессию
  ws_*    — файлы рабочей области; с машины человека — /upload, обратно — ссылка /files/…

Нет python, php или нужной утилиты на машине человека — это не повод переходить на bash
и разбирать вручную: тот же код запускается здесь, версия ставится сама. Подробнее — tools.

Удалённо (стенд доступов не хранит — цель приходит в вызове):
  conn_open — запомнить цель под именем до конца сессии; дальше conn: "имя"
  ssh_*, files_* (sftp/ftp/ftps), docker_*, db_*
  audit_*  — журнал всего, что делалось

Разделы: index, tools, workspace, env, run, targets, secrets, approvals, audit.`,

  tools: `Задачу, которую проще решить кодом, решайте кодом, а не цепочкой sed/awk/grep или ручным разбором:
разбор логов и выгрузок, массовая правка файлов, сверка дампов, конвертация форматов, проверки по
списку адресов. Чего нет на машине человека, есть здесь: run_code(tool: "python@3.11") или exec с
tools — недостающая версия ставится сама, pip/npm/composer ставят библиотеки без вопросов.

Повторится — оформите инструментом. tools/bin рабочей области стоит в PATH у exec и run_code:
  - один файл — одна команда, имя — глагол-существительное: parse-access-log, diff-dumps;
  - первая строка после шебанга — комментарий с назначением и аргументами: его показывает
    toolkit_info в «своиИнструменты»;
  - версия языка — в шебанге: #!/usr/bin/env -S mise exec python@3.11 -- python
    (или bash/node без версии); права — chmod +x через exec;
  - вход — аргументы и stdin, выход — stdout; секреты — через env (ws:…, secret://…).

Перед тем как писать новый — посмотрите toolkit_info: похожий, скорее всего, уже есть. Не хватает
возможности — доработайте существующий, а не заводите копию рядом. Рабочая область лежит в томе:
написанное сегодня пригодится в следующей сессии.`,

  workspace: `Рабочая область — каталог в томе стенда. Реальные папки машины человека сюда не монтируются.
Пути всегда относительные к её корню; «..» и симлинки наружу отклоняются.

Как файлы попадают внутрь:
  - с машины человека: curl -F file=@путь "${cfg.publicBaseUrl}/upload?dir=uploads" → ответ с путём;
  - с сервера: files_get(conn, path, to) — файл или каталог целиком;
  - кодом: ws_write, exec (git clone, curl, unzip…).
Как наружу:
  - на сервер: files_put(conn, from: "путь в области", dest);
  - человеку: ws_link — ссылка ${cfg.publicBaseUrl}/files/<путь> для curl -o.
Служебные результаты (вывод команд, код run_code) ложатся в .tk/.`,

  env: `Тулчейны ставит mise. python, node, go, java приходят готовыми сборками за секунды; php и ruby
собираются из исходников — минуты: env_install возвращает id задачи, дождитесь её job_status с wait.
Поставленное лежит в томе и переживает перезапуск — собирается один раз.

Три способа выбрать версию:
  - tools в exec/run_code — на один вызов, недостающее ставится само;
  - env_use(dir, tools) — mise.toml в каталоге области: дальше php/python там нужных версий;
  - env_use с global — для всего остального.
Список версий — env_available(tool, prefix). Что угодно из реестра mise (mise registry):
terraform, kubectl, rust, dotnet и т.д. Чего нет на машине человека — ставится здесь (раздел tools).`,

  run: `exec — bash в контейнере стенда, cwd — рабочая область. Контейнер — песочница стенда: apt-get,
pip, composer и npm ставят что нужно, подтверждений нет.
run_code — код строкой: сохраняется в файл и выполняется нужной версией.
Скрипты из tools/bin вызываются по имени: каталог в PATH (раздел tools).

Любой запуск — задача. Не уложилась в ~${Math.round(cfg.foregroundMs / 1000)} с — вызов отдаёт её id, а она продолжается в фоне.
job_status(id, wait) ждёт и возвращает хвосты потоков, saveTo — stdout целиком в файл области.
background: true — сразу в фон (dev-сервер); timeout: 0 — без потолка жизни.
Секреты для кода — в env ссылкой (ws:…, secret://…): из вывода они вычищаются.`,

  targets: `Цель — сервер, куда идёт вызов: host, port, user, password|key, proto (ssh|ftp|ftps),
root (база для относительных путей files_*), cwd (каталог ssh_*), readonly,
db {engine, database, user, password, host, port, via: tunnel|exec|direct}, docker {container, composeFile, workdir, sudo}.

conn_open(name, target) запоминает цель до конца сессии MCP, на диск ничего не пишется. Дальше
инструментам хватает conn: "name". Разово можно передать адрес: ssh://user@host:22/var/www,
sftp://…, ftp://user:pass@host/htdocs, ftps://….

Ключ SSH-сервера, увиденного впервые, закрепляется (state/known_hosts.json). Смена ключа — отказ;
заменить его можно, открыв цель с hostKey: "SHA256:…" — и человек это подтвердит.
db.via: tunnel — драйвер через SSH-туннель (порт базы наружу не нужен), exec — psql/mysql на самом
сервере (хостинги без проброса), direct — по сети без SSH (облачная база).`,

  secrets: `Стенд секретов не хранит. Поле секрета (password, key, passphrase, db.password, значения env)
принимает:
  - значение — как есть; дальше оно вычищается из ответа, файлов вывода и журнала;
  - ws:<путь> — файл в рабочей области: ключ загружают на /upload мимо контекста модели;
  - secret://<id> — ссылка для сервиса секретов (TK_SECRET_RESOLVER_URL). Не настроен — вызов отказывает.
Предпочтительнее ссылка или файл: значение в аргументах проходит через контекст модели и транскрипт.`,

  approvals: `Локальная работа (env, run, jobs, ws) не спрашивается: это песочница стенда.
Удалённый доступ разрешается пользователю на сервере — user@host — и по уровням, каждый раз за сессию:
  - первый вызов к user@host спрашивает доступ; человек выбирает «только чтение» или сразу
    «чтение и запись». Дальше читающие вызовы идут без вопросов;
  - первый изменяющий вызов при выданном чтении спрашивает запись ещё раз — и всё, дальше молча;
  - знаете заранее, что будете писать, — conn_open(access: "write"): один вопрос на всё.
Разрешение покрывает все протоколы этого пользователя (shell, файлы, docker, база через туннель);
другой пользователь на том же сервере спрашивается отдельно. Отказ запоминается: на чтение — закрывает
доступ, на запись — только запись. TK_APPROVAL=write спрашивает только запись, off — ничего.
Цель с readonly: true спрашивает про каждый похожий на запись вызов — и после выданного разрешения.
Спрашивает клиент (elicitation); если не умеет — заявка ждёт на ${cfg.publicBaseUrl}/approvals
до ${Math.round(cfg.approveTimeoutMs / 1000)} с. Отказ и таймаут — обычный исход: сообщите о нём, не обходите другим инструментом.`,

  audit: `Каждый вызов целиком — аргументы, команда, код возврата, решение по подтверждению, stdout и stderr —
ложится в журнал (JSONL в томе logs). Секреты вырезаются: по имени поля, по содержимому (ключи PEM,
токены, строки подключения) и по значению — всё, что разрешено в вызове.
audit_tail — последнее, audit_query — поиск (onlyChanges — что менялось на сервере), audit_show — запись целиком.
Страница: ${cfg.publicBaseUrl}/audit.`,
};

const EN = {
  index: `The toolkit is the agent's workspace and a layer over remote servers.

Local (in the toolkit container, inside the workspace):
  env_*   — languages and tools via mise: python@3.11, php@7.4, node@latest…
  exec, run_code — commands and code; long runs become background jobs (job_*)
  tools/bin — scripts the agent writes for itself: called by name, they outlive the session
  ws_*    — workspace files; from the human's machine — /upload, back — a /files/… link

No python, php or a needed utility on the human's machine is no reason to fall back to bash and
manual parsing: the same code runs here, the version installs itself. More — tools.

Remote (the toolkit stores no credentials — the target comes with the call):
  conn_open — remember a target under a name for the session; then conn: "name"
  ssh_*, files_* (sftp/ftp/ftps), docker_*, db_*
  audit_*  — journal of everything done

Topics: index, tools, workspace, env, run, targets, secrets, approvals, audit.`,
  tools: `A task that is easier as code gets solved as code, not a chain of sed/awk/grep or manual parsing:
logs and exports, bulk file edits, dump comparison, format conversion, checks over a list of hosts.
What the human's machine lacks is here: run_code(tool: "python@3.11") or exec with tools — a missing
version installs itself, pip/npm/composer install libraries without questions.

If it will repeat, make it a tool. The workspace's tools/bin is on PATH for exec and run_code:
  - one file — one command, named verb-noun: parse-access-log, diff-dumps;
  - the first line after the shebang is a comment with purpose and arguments: toolkit_info shows it;
  - the language version goes into the shebang: #!/usr/bin/env -S mise exec python@3.11 -- python
    (or bash/node without a version); chmod +x via exec;
  - input — arguments and stdin, output — stdout; secrets via env (ws:…, secret://…).

Before writing a new one check toolkit_info: a similar one is likely there. Missing a feature —
extend the existing tool instead of adding a copy. The workspace is a volume: what you write today
serves the next session.`,
  workspace: RU.workspace,
  env: RU.env,
  run: RU.run,
  targets: RU.targets,
  secrets: RU.secrets,
  approvals: RU.approvals,
  audit: RU.audit,
};

export const TOPICS = LANG === 'en' ? EN : RU;

function dirSize(dir) {
  let total = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      total += st.isDirectory() ? dirSize(full) : st.size;
    }
  } catch { /* каталога ещё нет */ }
  return total;
}

export const tools = [
  {
    name: 'toolkit_info',
    group: GROUP,
    mutating: false,
    title: pick({ ru: 'Состояние стенда', en: 'Toolkit state' }),
    description: pick({
      ru: 'Версия и обновление, поднятые группы инструментов, mise, свои инструменты агента (tools/bin), '
        + 'открытые подключения и разрешения этой сессии, задачи, висящие подтверждения, адреса /upload и '
        + '/files. Сюда идут, когда инструмент ответил странно, и перед тем, как писать новый скрипт.',
      en: 'Version and update, active tool groups, mise, the agent\'s own tools (tools/bin), this session\'s open connections and grants, '
        + 'jobs, pending approvals, /upload and /files addresses. Check here when a tool answers oddly.',
    }),
    input: {},
    run: async (_args, { ctx }) => {
      const caps = ctx?.server?.server?.getClientCapabilities?.();
      return {
        data: {
          версия: cfg.version,
          обновление: ctx?.update
            ? { ...ctx.update, upgrade: ctx.update.upgrade || upgradeSteps(ctx.update.latest) }
            : { updateAvailable: null, unavailable: 'проверка не выполнялась' },
          язык: LANG,
          инструменты: { группы: ctx?.groups || ['все'], сколько: ctx?.toolCount ?? null },
          среда: {
            mise: await mise.version(),
            задачВРаботе: jobs.running(),
            хостВерсий: { true: 'mise-versions.jdx.dev доступен', false: 'недоступен — версии из первоисточников, python собирается из исходников', null: 'ещё не проверен' }[versionsHost()],
          },
          своиИнструменты: ownTools(),
          подключения: targets.list(ctx?.sessionId),
          подтверждения: {
            режим: `TK_APPROVAL=${cfg.approval}`,
            выданоВЭтойСессии: snapshot(ctx?.sessionId),
            таймаутСекунд: Math.round(cfg.approveTimeoutMs / 1000),
            ждут: pendingCount(),
            клиентУмеетСпрашивать: Boolean(caps?.elicitation),
            страница: `${cfg.publicBaseUrl}/approvals`,
          },
          секреты: { резолвер: cfg.secretResolverUrl ? 'настроен' : 'не настроен — secret://… отклоняются' },
          журнал: { размерБайт: dirSize(DIRS.logs), потолокБайт: cfg.logMaxBytes, страница: `${cfg.publicBaseUrl}/audit` },
          соединения: { живыеSSH: poolState() },
          обмен: {
            загрузка: `curl -F file=@<файл> "${cfg.publicBaseUrl}/upload?dir=uploads"`,
            скачивание: `${cfg.publicBaseUrl}/files/<путь в рабочей области>`,
          },
        },
      };
    },
  },

  {
    name: 'help',
    group: GROUP,
    mutating: false,
    title: pick({ ru: 'Справка', en: 'Help' }),
    description: pick({
      ru: `Устройство стенда по разделам: ${Object.keys(RU).join(', ')}. Без topic — оглавление.`,
      en: `How the toolkit works, by topic: ${Object.keys(RU).join(', ')}. Without topic — the index.`,
    }),
    input: { topic: z.enum(Object.keys(RU)).optional() },
    run: (args) => ({ data: TOPICS[args.topic || 'index'] }),
  },
];
