import fs from 'node:fs';
import { z } from 'zod';
import { pick } from '../i18n.js';
import * as mise from '../local/mise.js';
import * as jobs from '../local/jobs.js';
import * as ws from '../workspace.js';
import { jobReply } from './run.js';

const GROUP = 'env';

const specs = z.array(z.string()).min(1).describe(pick({
  ru: 'инструменты mise: python@3.11, php@7.4, node@latest, go@1.22, ruby@3, java@21…',
  en: 'mise tools: python@3.11, php@7.4, node@latest, go@1.22, ruby@3, java@21…',
}));

const background = z.boolean().optional().describe(pick({
  ru: 'сразу в фон: ответ — id задачи для job_status',
  en: 'straight to the background: the reply is a job id for job_status',
}));

export const tools = [
  {
    name: 'env_list',
    group: GROUP,
    mutating: false,
    title: pick({ ru: 'Поставленные тулчейны', en: 'Installed toolchains' }),
    description: pick({
      ru: 'Какие версии языков и инструментов уже стоят (mise) и какие активны в каталоге рабочей области. '
        + 'Поставленное хранится в томе и переживает перезапуск.',
      en: 'Which language and tool versions are installed (mise) and which are active in a workspace '
        + 'directory. Installs live in a volume and survive restarts.',
    }),
    input: {
      dir: z.string().optional().describe(pick({ ru: 'каталог рабочей области для «активных»', en: 'workspace directory for "active"' })),
    },
    run: async (args) => {
      const cwd = ws.resolve(args.dir || '.');
      return { data: { installed: await mise.installed(), active: await mise.current(cwd), mise: await mise.version() } };
    },
  },

  {
    name: 'env_available',
    group: GROUP,
    mutating: false,
    title: pick({ ru: 'Доступные версии', en: 'Available versions' }),
    description: pick({
      ru: 'Версии инструмента, которые mise может поставить, свежие в конце. prefix сужает: 3.11 → 3.11.*.',
      en: 'Versions mise can install for a tool, newest last. prefix narrows: 3.11 → 3.11.*.',
    }),
    input: { tool: z.string(), prefix: z.string().optional() },
    run: async (args) => {
      mise.checkSpecs([args.tool]);
      return { data: { tool: args.tool, ...(await mise.available(args.tool, args.prefix)) } };
    },
  },

  {
    name: 'env_install',
    group: GROUP,
    mutating: true,
    title: pick({ ru: 'Поставить тулчейн', en: 'Install a toolchain' }),
    description: pick({
      ru: 'Ставит версии через mise. python, node, go ставятся готовыми сборками за секунды; php и '
        + 'ruby собираются из исходников — минуты, и тогда вызов возвращает id задачи: дождитесь её '
        + 'job_status с wait. Ставить заранее не обязательно: exec и run_code с tools ставят недостающее сами.',
      en: 'Installs versions via mise. python, node, go come prebuilt in seconds; php and ruby are compiled '
        + 'from source — minutes, and then the call returns a job id: wait for it with job_status and wait. '
        + 'Installing up front is optional: exec and run_code with tools install what is missing.',
    }),
    input: { tools: specs, background },
    run: async (args) => jobReply(await jobs.runForeground({
      argv: mise.installArgv(args.tools),
      env: mise.buildEnv(args.tools),
      cwd: ws.ensure(),
      timeoutMs: 0,
      kind: 'install',
      label: `mise install ${args.tools.join(' ')}`,
    }, { background: args.background })),
  },

  {
    name: 'env_use',
    group: GROUP,
    mutating: true,
    title: pick({ ru: 'Закрепить версии', en: 'Pin versions' }),
    description: pick({
      ru: 'Закрепляет версии за каталогом рабочей области (пишет mise.toml) или глобально. После этого '
        + 'python, php, node в этом каталоге — нужных версий без tools в каждом вызове. Недостающее ставится.',
      en: 'Pins versions to a workspace directory (writes mise.toml) or globally. After that python, php, '
        + 'node in that directory are the right versions without tools on every call. Missing ones get installed.',
    }),
    input: {
      tools: specs,
      dir: z.string().optional().describe(pick({ ru: 'каталог рабочей области, по умолчанию корень', en: 'workspace directory, root by default' })),
      global: z.boolean().optional(),
      background,
    },
    run: async (args) => {
      // Каталог под mise.toml создаётся: закрепить версии за новым проектом — обычный первый шаг.
      const cwd = ws.resolve(args.dir || '.');
      fs.mkdirSync(cwd, { recursive: true });
      return jobReply(await jobs.runForeground({
        argv: mise.useArgv(args.tools, { global: args.global }),
        env: mise.buildEnv(args.tools),
        cwd,
        timeoutMs: 0,
        kind: 'install',
        label: `mise use ${args.global ? '--global ' : ''}${args.tools.join(' ')}`,
      }, { background: args.background }));
    },
  },

  {
    name: 'env_uninstall',
    group: GROUP,
    mutating: true,
    title: pick({ ru: 'Удалить тулчейн', en: 'Uninstall a toolchain' }),
    description: pick({
      ru: 'Удаляет поставленные версии из тома тулчейнов — например, чтобы пересобрать php с другими опциями.',
      en: 'Removes installed versions from the toolchain volume — e.g. to rebuild php with other options.',
    }),
    input: { tools: specs },
    run: async (args) => jobReply(await jobs.runForeground({
      argv: mise.uninstallArgv(args.tools),
      cwd: ws.ensure(),
      kind: 'install',
      label: `mise uninstall ${args.tools.join(' ')}`,
    })),
  },
];
