# Toolkit

Рабочая среда ИИ-агента и прослойка к удалённым серверам в одном MCP-сервере.

- **Рабочая среда.** Контейнер со своей рабочей областью. Языки и инструменты ставит
  [mise](https://mise.jdx.dev): `python@3.11`, `php@7.4`, `node@latest`, `go`, `ruby`, `java` и всё
  из его реестра. Агент пишет файлы, выполняет команды и код, долгое уходит в фоновые задачи.
  Повторяющуюся работу агент оформляет скриптами в `tools/bin` и вызывает их по имени.
- **Удалённые серверы.** SSH, SFTP, FTP/FTPS, базы postgres/mysql через SSH-туннель, docker на
  сервере. Файлы ходят через рабочую область: скачал с сервера → обработал кодом → отправил обратно.
- **Доступов стенд не хранит.** Реквизиты приходят в вызове: значением, файлом рабочей области
  или ссылкой на сервис секретов. Из ответов и журнала они вычищаются.
- **Журнал и подтверждения.** Каждый вызов целиком ложится в журнал. Доступ к `user@host`
  спрашивается у человека по разу за сессию: сначала чтение, потом запись — или сразу оба.

Заменяет [ConnectionRegistry](https://github.com/cat-of-summer/ConnectionRegistry---mcp-package):
транспорты, журнал и подтверждения перенесены оттуда, реестра доступов, проектов и заметок нет.

---

## Установка из готового образа

Нужен Docker, общая сеть и роутер — шаг [«Общая сеть и роутер»](#1-общая-сеть-и-роутер).

```sh
mkdir -p ~/toolkit && cd ~/toolkit
base=https://github.com/cat-of-summer/ToolChain---mcp-package/releases/latest/download
curl -fsSL -o docker-compose.yml "$base/docker-compose.yml"
curl -fsSL -o .env               "$base/default.env.example"
docker compose up -d
```

Готово, когда `docker compose ps` показывает `healthy`:

```sh
curl http://127.0.0.1:8092/health
docker compose exec toolkit tk doctor
```

Рабочая область, тулчейны, состояние и журнал лежат в томах `workspace`, `tools`, `state`, `logs` —
они переживают `docker pull`. Собранный однажды php второй раз не собирается.

> [!warning]
> Стенд слушает только `127.0.0.1` и должен там оставаться: в контейнере выполняется произвольный
> код агента. Если его всё же надо выставить наружу — за Traefik с HTTPS и с `HTTP_LOGIN`.

---

## Установка из исходников

### 0. Клонирование

Код сервера лежит в подмодуле `app/data` — ветка `app` этого же репозитория.

```sh
git clone --recurse-submodules https://github.com/cat-of-summer/ToolChain---mcp-package.git
```

### 1. Общая сеть и роутер

Если вы пользуетесь [docker_toolkit](https://github.com/cat-of-summer/docker_toolkit), они уже
подняты — шаг пропускается.

```sh
cd network  && cp .env.example .env && docker compose up -d
cd ../traefik && cp .env.example .env && docker compose up -d
```

### 2. Стенд

```sh
cd ../app && cp .env.example .env
docker compose up -d --build
```

Первая сборка образа идёт несколько минут: в нём библиотеки для сборки тулчейнов и OpenSSL 1.1
для php 5/7. Готово, когда в `docker compose logs -f node` появилось `команда tk готова` и
`streamable http на 0.0.0.0:8933/mcp`.

---

## Подключение к агенту

```sh
claude mcp add --transport http toolkit http://127.0.0.1:8092/mcp --header "X-Toolkit-Agent: shop"
```

`X-Toolkit-Agent` - имя агента для приватных установок ([Тулчейны](#тулчейны)): по нему стенд узнаёт
агента и в следующих сессиях. Без заголовка имя берётся из MCP roots - корня проекта, который сообщает
клиент; нет и их - агент безымянный, и вариант "приватно" ему не предлагается. Для stdio - переменная
`TK_AGENT`. Чьё имя видит стенд - `toolkit_info`, поле `агент`.

Хвост адреса сокращает набор инструментов: `/mcp/local` — только рабочая среда, `/mcp/remote` —
только серверы, `/mcp/transfer` — ssh, файлы и рабочая область, `/mcp/db+audit` — названные
группы. Группы: `env`, `run`, `jobs`, `ws`, `ssh`, `files`, `docker`, `db`, `audit`; `toolkit_info`
и `help` есть на любом адресе.

stdio (процесс на сессию; подтверждения — только если клиент умеет elicitation или через `tk approve`):

```json
{
  "mcpServers": {
    "toolkit": {
      "command": "docker",
      "args": ["compose", "-f", "/полный/путь/к/app/docker-compose.yml",
               "exec", "-T", "node", "npm", "run", "mcp:stdio"]
    }
  }
}
```

---

## Как это работает

### Рабочая область

Каталог в томе стенда. Всё, с чем работает агент, попадает внутрь явно - кроме
[папки проектов](#папка-проектов-хоста), если она подключена.

| Откуда | Как |
|---|---|
| с машины человека | `curl -F file=@путь "http://127.0.0.1:8092/upload?dir=uploads"` |
| с сервера | `files_get` — файл или каталог целиком |
| кодом | `ws_write`, `exec` (`git clone`, `curl`, `unzip`…) |

| Куда | Как |
|---|---|
| на сервер | `files_put` с `from` — путь в области; каталог уходит рекурсивно |
| человеку | `ws_link` → `curl -o … http://127.0.0.1:8092/files/<путь>` |

Пути агента всегда относительные к корню области; выход через `..` или симлинк отклоняется.
Служебные результаты - код `run_code`, вывод команд - ложатся в `.tk/`.

### Папка проектов хоста

Чаще всего агент поднимает свой контейнер с php не из-за версии, а потому что `docker run -v $PWD`
видит файлы проекта. Стенд видит их так же, если в `.env` задать `PROJECTS_DIR=O:/Projects`: папка
монтируется в `/var/www/html/projects` **на чтение и запись**, а `exec`, `run_code`, `env_use`, `ws_*`
и `files_get`/`files_put` принимают пути под ней как есть - `O:\Projects\shop\src` - или в виде
`host:shop/src`. `php -l`, `composer install` и тесты идут прямо в проекте, а `.tool-versions` и
`mise.toml` проекта выбирают версию php.

> [!warning]
> Код агента в стенде получает запись в эти файлы. Bind-монтирование с NTFS медленное:
> `composer install` в проекте на Windows идёт заметно дольше, чем в рабочей области.

Ссылок `/files/…` у файлов проектов нет: они и так на машине человека. Относительный `PROJECTS_DIR`
(в релизе по умолчанию `./projects`) префиксом не служит - тогда только `host:…`.

### Свои инструменты агента

Инструкции MCP и `help tools` направляют агента решать кодом то, что проще решить кодом, а не
откатываться на bash, когда на машине человека нет python или php: тот же код идёт в стенд. То,
что повторится, агент сохраняет скриптом в `tools/bin` рабочей области:

- каталог стоит в `PATH` у `exec` и `run_code` — скрипт вызывается по имени;
- версия языка — в шебанге: `#!/usr/bin/env -S mise exec python@3.11 -- python`;
- первая строка-комментарий — описание; `toolkit_info` перечисляет скрипты с ним в `своиИнструменты`.

Рабочая область лежит в томе, так что написанное переживает сессии и пересоздание контейнера.

### Тулчейны

mise ставит версии в том `tools`. python, node, go, java приходят готовыми сборками за секунды;
php и ruby собираются из исходников — минуты. Версию выбирают тремя способами:

- `tools: ["php@7.4"]` в `exec` или `run_code` — на один вызов, недостающее ставится само;
- `env_use` — `mise.toml` в каталоге рабочей области: дальше `php` там нужной версии;
- `env_use` с `global` — для всего остального.

Списки версий mise берёт с `mise-versions.jdx.dev`. Этот хост за Cloudflare и доступен не везде.
Стенд проверяет его при старте и раз в 15 минут; если тот не отвечает, сам переключает mise на
первоисточники (GitHub, сайты языков), а python — на сборку из исходников: минуты вместо секунд,
но работает. Доступность бывает переменной, поэтому установка, упавшая именно на этом хосте,
сразу повторяется через первоисточники — в ответе это видно по полю `retried`.
Состояние видно в `toolkit_info`, поле `среда.хостВерсий`. Явно заданные в `.env`
`MISE_USE_VERSIONS_HOST` и `MISE_PYTHON_COMPILE` этот выбор отменяют. Для частых установок
стоит задать `MISE_GITHUB_TOKEN`: без него API GitHub даёт 60 запросов в час.

Чего нет в mise, ставится пакетами Debian: `env_install(["kit:office"])`. Наборы:

| Набор | Что внутри |
|---|---|
| `kit:office` | LibreOffice без GUI (`soffice --headless --convert-to pdf`, а также docx, xlsx, odt), шрифты, метрически совместимые с MS Office |
| `kit:pdf` | poppler (`pdftotext`, `pdfinfo`, `pdftoppm`), `qpdf`, ghostscript |
| `kit:ocr` | tesseract с русским и английским |
| `kit:media` | ffmpeg, ImageMagick, exiftool |

Любой другой пакет - `apt:<имя>`. Списки пакетов и скачанные `.deb` лежат в томе `tools/.apt`, поэтому
после пересоздания контейнера стенд при старте ставит живые наборы заново из этого кэша - в фоне и
без сети, если её нет; пока идёт, `env_list` показывает `restoring`. `apt-get install` в `exec` тоже
работает, но пропадёт вместе с контейнером.

**Видимость и срок жизни.** Новую установку - версию mise или набор - стенд спрашивает у человека:

| Вариант | Кому видно | Сколько живёт без использования |
|---|---|---|
| публично | всем агентам | `TK_TOOL_TTL_PUBLIC` (30 дней) + `TK_TOOL_TTL_PER_DAY` (3 дня) за каждые сутки с использованием, не дольше `TK_TOOL_TTL_MAX` (180 дней) |
| разово | всем агентам | `TK_TOOL_TTL_ONCE` (12 часов) от последнего использования |
| приватно | только этому агенту (`X-Toolkit-Agent` или MCP roots) | как публично, база - `TK_TOOL_TTL_PRIVATE` |

Без ответа - разово. Агент передаёт `visibility` в `env_install` или `exec`, только когда человек уже
сказал, - тогда вопроса нет. Каждый запуск продлевает срок того, чем пользуется: версий из `tools`,
подхваченных шимами в `cwd`, наборов, чьи программы есть в команде. Уборщик раз в `TK_TOOLS_SWEEP`
(час) снимает истёкшее, не трогая закреплённое `env_use` с `global` и то, чем пользуется идущая задача,
и убирает каталоги недособранных версий, которых mise не знает. Каждое удаление - запись журнала с
`tool: "sweep"`. Реестр - `tools/.tk/registry.json`; что стояло до него, считается публичным.

Приватность - это видимость в `env_list` и защита от `env_uninstall` чужим агентом, а не изоляция:
код всех агентов выполняется в одном контейнере.

php 5 и 7 не собираются с OpenSSL 3 из Debian bookworm (`ext/openssl` падает на
`RSA_SSLV23_PADDING`). Для них в образе рядом собран OpenSSL 1.1.1w в `/opt/openssl-1.1`, и стенд
сам переключает на него сборку, когда в спецификации php 5 или 7. Набор системных библиотек для
сборки взят из CI [git_toolkit](https://github.com/cat-of-summer/git_toolkit), туда же добавлен
`--with-sodium` через `PHP_EXTRA_CONFIGURE_OPTIONS`.

### Задачи

Любой запуск — `exec`, `run_code`, `env_install` — задача. Уложилась в `TK_FOREGROUND_TIMEOUT`
(50 с) — вызов возвращает результат как обычно. Нет — возвращает id, задача продолжается в фоне;
`job_status` с `wait` её дожидается, `job_kill` гасит вместе со всем, что она запустила.
`background: true` и `timeout: 0` — для dev-серверов. Потоки задачи пишутся целиком, в ответ
уходит хвост; `job_status` с `saveTo` кладёт stdout целиком в рабочую область.

Окружение стенда (`TK_*`, токен сервиса секретов) в код агента не передаётся.

### Подключения

Стенд доступов не хранит. Цель описывается в вызове:

```json
{
  "host": "203.0.113.10", "port": 22, "user": "deploy",
  "key": "ws:keys/id_ed25519",
  "cwd": "/var/www/shop", "root": "/var/www/shop",
  "db": { "engine": "mysql", "database": "shop", "user": "shop", "password": "secret://shop/db" },
  "docker": { "container": "shop_queue", "composeFile": "/opt/shop/docker-compose.yml" }
}
```

`conn_open(name, target)` запоминает её до конца сессии MCP — дальше `ssh_*`, `files_*`, `docker_*`,
`db_*` берут `conn: "name"`. На диск не пишется ничего. Для разового вызова `conn` принимает
адрес: `ssh://user@host:22/var/www`, `sftp://…`, `ftp://user:pass@host/htdocs`, `ftps://…`.

- `proto: ftp | ftps` — сервер только с FTP: работают `files_*`.
- `db.via`: `tunnel` (по умолчанию) — драйвер через SSH-туннель, порт базы наружу не нужен;
  `exec` - `psql`/`mysql` на самом сервере, для хостингов без проброса; `direct` - по сети без SSH.
  В `exec` клиент берётся `mariadb` или `mysql` (дамп - `mariadb-dump` или `mysqldump`), что нашлось.
- `db.socket` - Unix-сокет базы на сервере вместо `db.host`: когда у пользователя базы права только
  на `localhost` и по TCP с `127.0.0.1` он не входит. Путь - `/run/mysqld/mysqld.sock`, у postgres -
  каталог `/var/run/postgresql` или файл `.s.PGSQL.5432`. Работает в `tunnel` (проброс сокета по SSH,
  нужен `AllowStreamLocalForwarding yes`) и в `exec`. Отказ "Access denied … @'127.0.0.1'" сам
  подсказывает это поле.
- `readonly: true` — каждый похожий на запись вызов спрашивает человека. Ставится по просьбе человека:
  для работы только на чтение хватает `access: "read"`.

Ключ SSH-сервера, увиденного впервые, закрепляется в `state/known_hosts.json`. Смена ключа —
отказ; заменить его можно, открыв цель с `hostKey: "SHA256:…"`, — и человек это подтвердит.

### Секреты

Поле секрета (`password`, `key`, `passphrase`, `db.password`, значения `env`) принимает:

| Вид | Что делает |
|---|---|
| значение | используется как есть и вычищается из ответа, файлов вывода и журнала |
| `ws:<путь>` | файл рабочей области — ключ загружают на `/upload` мимо контекста модели |
| `secret://<id>` | ссылка для сервиса секретов `TK_SECRET_RESOLVER_URL` |

Сервис секретов отдельным MCP ещё не спроектирован. Сейчас стенд разрешает ссылку запросом
`GET <TK_SECRET_RESOLVER_URL>?ref=<ссылка>` с `Authorization: Bearer <TK_SECRET_RESOLVER_TOKEN>`
и ждёт `{"value": "…"}`. Не настроен — ссылка отклоняется с объяснением.

### Подтверждения

- Работа в рабочей области (`env`, `run`, `jobs`, `ws`) не спрашивается: это песочница стенда.
- Удалённый доступ выдаётся пользователю на сервере — `user@host` — по уровням, по разу за сессию.
  Первый вызов спрашивает доступ: человек выбирает «только чтение» или сразу «чтение и запись».
  Дальше чтение идёт молча; первый изменяющий вызов при выданном чтении спрашивает запись ещё раз.
  Агент, который знает, что будет писать, открывает цель `conn_open(access: "write")` — один вопрос.
- Разрешение покрывает все протоколы пользователя: shell, файлы, docker, базу через туннель.
  Другой пользователь того же сервера спрашивается отдельно. Отказ человека в доступе закрывает его
  до конца сессии, отказ в записи - только запись. Таймаут и вызов, брошенный клиентом, отказом не
  считаются: повторный вызов спросит снова.
- Shell-команда изменяющая, если в ней есть приметы записи: `rm`, перенаправление в файл,
  `git pull`, распаковка, код интерпретатору (`python -c`, `php script.php`) и т. п. Без примет
  хватает разрешения на чтение. Функции, определённые в той же команде (`M(){ mysql -e "$1"; }; M "select …"`),
  разбираются на месте вызова. Разбор — эвристика и ошибается в сторону лишнего вопроса; SQL надёжнее
  слать через `db_query`.
- `readonly: true` спрашивает про каждый похожий на запись вызов — и после выданного разрешения.
- `TK_APPROVAL=write` спрашивает только запись, `off` — ничего, кроме `readonly`.
- `db_query`: `SELECT` идёт без вопроса, несколько запросов через `;` отклоняются.

Спрашивает сам клиент (MCP elicitation). Если не умеет или человек закрыл окно - заявка ждёт на
`http://127.0.0.1:8092/approvals`, с сервера - `tk approve ls` и `tk approve read|write|yes|no <id>`.
`TK_APPROVE_TIMEOUT` (5 минут) - общее время на вопрос в клиенте и на странице, а не каждому по столько.
Решение по каждому вызову, включая `timeout` и `cancelled`, видно в журнале, поле `approval`.
Разрешения живут в памяти и умирают вместе с сессией.

### Журнал

Каждый вызов: время, подключение, инструмент, аргументы, команда, код возврата, решение по
подтверждению, stdout и stderr целиком. Секреты вырезаются по имени поля, по содержимому (ключи
PEM, токены, строки подключения) и по значению — всё, что разрешено в вызове. JSONL в томе `logs`,
потолок — `TK_LOG_MAX_BYTES`. Смотреть: `http://127.0.0.1:8092/audit`, `tk log tail`,
агенту — `audit_tail`, `audit_query`, `audit_show`.

---

## Что стенд умеет

Описание каждого инструмента агент получает по протоколу; ниже — карта. После `;` — то, что
меняет состояние.

| Группа | Инструменты |
|---|---|
| env | `env_list`, `env_available`; `env_install`, `env_use`, `env_uninstall` |
| run | `exec`, `run_code` |
| jobs | `job_list`, `job_status`; `job_kill` |
| ws | `ws_list`, `ws_read`, `ws_link`; `ws_write`, `ws_move`, `ws_remove` |
| ssh | `conn_open`, `conn_list`, `conn_close`, `conn_check`; `ssh_exec`, `ssh_script` |
| files | `files_list`, `files_stat`, `files_read`, `files_get`; `files_put`, `files_move`, `files_remove`, `files_mkdir`, `files_chmod` |
| docker | `docker_ps`, `docker_logs`, `docker_inspect`; `docker_exec`, `docker_restart`, `docker_compose` |
| db | `db_tables`, `db_schema`, `db_query`, `db_dump` |
| audit | `audit_tail`, `audit_query`, `audit_show` |
| служебные | `toolkit_info`, `help` (разделы `tools`, `workspace`, `env`, `run`, `targets`, `secrets`, `approvals`, `audit`) |

---

## Работа руками

```sh
docker compose exec node tk doctor         # сервер, mise, каталоги, OpenSSL для php 5/7
docker compose exec node tk approve ls     # что ждёт разрешения
docker compose exec node tk log tail       # последние действия
docker compose exec node tk mise ls        # mise с окружением стенда
```

Из готового образа сервис называется `toolkit`: `docker compose exec toolkit tk …`.

---

## Настройки

Всё в `app/.env`, с пояснениями в `app/.env.example`.

| Параметр | Зачем менять |
|---|---|
| `EXTERNAL_ACCESS`, `MCP_ACCESS` | порты стенда и MCP напрямую; по умолчанию `8092` и `8933` |
| `PUBLIC_BASE_URL` | база ссылок `/files/…` в ответах агенту |
| `TK_LANG` | язык описаний инструментов: `ru`, `en`, `auto` |
| `TK_APPROVAL`, `TK_APPROVE_TIMEOUT` | подтверждения доступа: `host` (чтение и запись), `write` (только запись) или `off`; сколько ждать ответа |
| `TK_SECRET_RESOLVER_URL`, `TK_SECRET_RESOLVER_TOKEN` | сервис секретов для `secret://…` |
| `PROJECTS_DIR` | папка проектов хоста, которую стенд видит на чтение и запись; пусто - не подключать |
| `TK_TOOL_TTL_ONCE`, `TK_TOOL_TTL_PUBLIC`, `TK_TOOL_TTL_PRIVATE`, `TK_TOOL_TTL_PER_DAY`, `TK_TOOL_TTL_MAX`, `TK_TOOLS_SWEEP` | срок жизни поставленного и как часто уборщик его проверяет |
| `TK_FOREGROUND_TIMEOUT` | сколько секунд вызов ждёт команду, прежде чем отдать её в фон |
| `TK_JOBS_KEEP` | сколько завершённых задач хранить |
| `TK_EXEC_TIMEOUT` | таймаут команды по умолчанию |
| `TK_FILES_PARALLEL` | сколько файлов `files_get` и `files_put` передают разом в каталоге; для FTP - число соединений, по умолчанию `8` |
| `TK_MAX_TEXT_BYTES`, `TK_DB_MAX_ROWS`, `TK_MAX_UPLOAD_BYTES` | потолки ответа, выборки, загрузки |
| `TK_LOG_MAX_BYTES` | потолок журнала |
| `MISE_VERSION`, `NODE_APT_PACKAGES` | версия mise и дополнительные пакеты Debian в образе |
| `TK_UPDATE_CHECK` | `0` выключает проверку обновлений |

---

## Тесты

Прогоняются в контейнере стенда:

```sh
docker compose -f app/docker-compose.yml exec node npm test
```

Без внешних серверов: рабочая область и её границы, цели и ссылки на секреты, подтверждения,
задачи и рабочая среда через MCP, журнал, разбор SQL и shell, бюджет манифеста.

Сквозной прогон — против мишеней из `docker-compose.test.yml`: два SSH-сервера, postgres и mysql
за первым (в сеть стенда не выставлены — `db_query` доказывает туннель), FTP.

```sh
docker compose -f docker-compose.test.yml up -d
docker compose -f app/docker-compose.yml exec node env TK_E2E=1 npm test
docker compose -f docker-compose.test.yml down -v
```

Установка тулчейнов — `TK_MISE_TESTS=1` (python и node; секунды, а без `mise-versions.jdx.dev` —
минуты на сборку python) и `TK_MISE_SLOW=1` (сборка php 7.4 на OpenSSL 1.1, минуты).

---

## Из чего собран

MCP-сервер на Node 22 (`@modelcontextprotocol/sdk`, `ssh2`, `basic-ftp`, `pg`, `mysql2`), mise,
nginx как вход. Репозиторий один, веток две:

- **`infrastructure`** — обёртка: docker-бандл, nginx, traefik, network, CI, README;
- **`app`** — подмодуль `app/data`: сервер, CLI `tk`, тесты.

Правка кода — коммит в подмодуле плюс обновление указателя здесь. Образ собирает
[dockerbundle](https://github.com/cat-of-summer/DockerBundle---python) по `docker-bundle.yml`,
CI — общий workflow [git_toolkit](https://github.com/cat-of-summer/git_toolkit).

---

## Лицензия

MIT — текст в [LICENSE](LICENSE).
