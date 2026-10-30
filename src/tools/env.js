import fs from 'node:fs';
import { z } from 'zod';
import { pick } from '../i18n.js';
import { agentOf } from '../agent.js';
import * as mise from '../local/mise.js';
import * as apt from '../local/apt.js';
import * as jobs from '../local/jobs.js';
import * as registry from '../local/registry.js';
import * as lifecycle from '../local/lifecycle.js';
import * as ws from '../workspace.js';
import { jobReply, visibility } from './run.js';

const GROUP = 'env';

const specs = z.array(z.string()).min(1).describe(pick({
  ru: 'mise: python@3.11, php@7.4, node@latest…; пакеты: kit:office, apt:<имя>',
  en: 'mise: python@3.11, php@7.4, node@latest…; packages: kit:office, apt:<name>',
}));

const background = z.boolean().optional().describe(pick({
  ru: 'сразу в фон: ответ — id задачи для job_status',
  en: 'straight to the background: the reply is a job id for job_status',
}));

/** Разводит спецификации: версии mise отдельно, пакеты Debian отдельно. */
function split(list) {
  const system = list.filter(apt.isSystem);
  const miseSpecs = mise.checkSpecs(list.filter((spec) => !apt.isSystem(spec)));
  if (system.length && miseSpecs.length) {
    throw new Error('версии mise и пакеты Debian (kit:, apt:) ставятся разными вызовами');
  }
  return { system: system.map(apt.parse), miseSpecs };
}

/** Видимость для того, что ещё не стоит; стоит всё и видимость не названа — вопроса нет. */
async function choiceFor(ctx, { tool, need, given }) {
  if (need.length || given) return lifecycle.chooseVisibility(ctx, { tool, specs: need, given });
  return { visibility: null, agent: (await agentOf(ctx)).id };
}

/**
 * Установка задачей с учётом по завершении: успела в вызове — учёт до ответа, ушла в фон —
 * когда закончится. Всё это время она отмечена: сверка реестра её версию не перехватит.
 */
async function installJob(job, background, record) {
  const ended = lifecycle.beginInstall();
  let outcome;
  try {
    outcome = await jobs.runForeground(job, { background });
  } catch (err) {
    ended();
    throw err;
  }
  const jobId = outcome.id ?? outcome.report.id;
  const done = jobs.done(jobId).then(() => record(jobs.report(jobId), jobId)).finally(ended);
  if (outcome.finished) await done;
  else done.catch((err) => console.error(`[toolkit] учёт установки ${jobId}: ${err.message}`));
  return outcome;
}

function withChoice(reply, choice) {
  if (choice?.visibility) {
    reply.data.visibility = choice.visibility;
    if (choice.defaulted) reply.data.visibilityNote = 'человек не ответил — поставлено разово; закрепить надолго: env_install с visibility';
  }
  return reply;
}

async function installMise(ctx, args, { argv, cwd, label, tool }) {
  const fresh = await lifecycle.missing(args.tools);
  const choice = await choiceFor(ctx, { tool, need: fresh, given: args.visibility });
  const outcome = await installJob(
    { argv, env: mise.buildEnv(args.tools), cwd, timeoutMs: 0, kind: 'install', label },
    args.background,
    (rep) => rep.exitCode === 0 && lifecycle.recordMise(args.tools, { ...choice, fresh }),
  );
  return withChoice(jobReply(outcome), choice);
}

async function installSystem(ctx, args, parsedList) {
  const need = [];
  for (const parsed of parsedList) if (!registry.get(parsed.id) || !(await apt.installed(parsed.packages))) need.push(parsed);

  const choice = await choiceFor(ctx, { tool: 'env_install', need: need.map((p) => p.id), given: args.visibility });
  if (!need.length) {
    for (const parsed of parsedList) {
      if (choice.visibility) registry.claim(parsed.id, { visibility: choice.visibility, agent: choice.agent });
      else registry.touch(parsed.id, choice.agent);
    }
    return { data: { already: parsedList.map((p) => p.id), ...(choice.visibility ? { visibility: choice.visibility } : {}) } };
  }

  // Что стояло до нас (запечено в образ, поставлено руками), снимать при уборке нельзя.
  const preinstalled = [];
  for (const name of new Set(need.flatMap((p) => p.packages))) if (await apt.installed([name])) preinstalled.push(name);

  const install = lifecycle.startSystemInstall(need, { ...choice, preinstalled });
  const outcome = await installJob(
    { ...install.job, cwd: ws.ensure(), timeoutMs: 0, kind: 'install', label: install.label },
    args.background,
    (_rep, jobId) => install.finalize(jobId),
  );
  return withChoice(jobReply(outcome), choice);
}

/** Поставленное, что видно этому агенту: версии mise и наборы пакетов с видимостью и сроками. */
async function visibleInstalls(agent) {
  const index = await lifecycle.miseIndex();
  registry.reconcile(
    'mise',
    new Map([...index.values()].map(({ id, tool, version, path }) => [id, { tool, version, path }])),
    Date.now(),
    { addNew: !lifecycle.installing() },
  );

  const tools = {};
  for (const [tool, versions] of Object.entries(await mise.installed())) {
    const shown = [];
    for (const v of versions) {
      const entry = registry.get(`mise:${tool}@${v.version}`);
      if (entry && !registry.visibleTo(entry, agent)) continue;
      shown.push({ version: v.version, ...(v.active ? { active: true } : {}), ...(entry ? registry.view(entry, agent) : {}) });
    }
    if (shown.length) tools[tool] = shown;
  }

  const system = [];
  for (const entry of registry.all()) {
    if (entry.kind !== 'apt' || !registry.visibleTo(entry, agent)) continue;
    const job = lifecycle.restoringJob(entry.id);
    system.push({
      id: entry.id,
      ...(entry.about ? { about: entry.about } : {}),
      status: job ? `restoring — восстанавливается из кэша, задача ${job}` : (await apt.installed(entry.packages)) ? 'ready' : 'missing',
      ...registry.view(entry, agent),
    });
  }
  return { tools, system };
}

export const tools = [
  {
    name: 'env_list',
    group: GROUP,
    mutating: false,
    title: pick({ ru: 'Поставленные тулчейны', en: 'Installed toolchains' }),
    description: pick({
      ru: 'Что уже стоит — версии mise и наборы kit:… с видимостью и сроком, — и что активно в каталоге. '
        + 'Смотрите сюда, прежде чем ставить новое или поднимать Docker.',
      en: 'What is installed — mise versions and kit:… sets with visibility and expiry — and what is active in a '
        + 'directory. Check here before installing anything or starting Docker.',
    }),
    input: {
      dir: z.string().optional().describe(pick({ ru: 'каталог рабочей области для «активных»', en: 'workspace directory for "active"' })),
    },
    run: async (args, { ctx }) => {
      const { id: agent, source } = await agentOf(ctx);
      const cwd = ws.resolve(args.dir || '.', { projects: true });
      const { tools: installed, system } = await visibleInstalls(agent);
      return {
        data: {
          installed,
          system,
          kits: Object.fromEntries(Object.entries(apt.KITS).map(([name, kit]) => [`kit:${name}`, kit.about])),
          active: await mise.current(cwd),
          agent: agent ? { id: agent, source } : 'безымянный — приватные установки недоступны',
          mise: await mise.version(),
        },
      };
    },
  },

  {
    name: 'env_available',
    group: GROUP,
    mutating: false,
    title: pick({ ru: 'Доступные версии', en: 'Available versions' }),
    description: pick({
      ru: 'Версии инструмента, которые mise может поставить, свежие в конце. prefix сужает: 3.11 → 3.11.*. '
        + 'Без tool — наборы пакетов kit:….',
      en: 'Versions mise can install for a tool, newest last. prefix narrows: 3.11 → 3.11.*. '
        + 'Without tool — package kits kit:….',
    }),
    input: { tool: z.string().optional(), prefix: z.string().optional() },
    run: async (args) => {
      if (!args.tool || apt.isSystem(args.tool)) {
        return {
          data: {
            kits: Object.fromEntries(Object.entries(apt.KITS).map(([name, kit]) => [`kit:${name}`, { about: kit.about, packages: kit.packages }])),
            любойПакет: 'apt:<имя пакета Debian bookworm>',
          },
        };
      }
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
      ru: 'Ставит версии mise или пакеты Debian (kit:office — LibreOffice, kit:pdf, kit:ocr, kit:media); видимость '
        + 'нового спрашивает у человека. php, ruby, LibreOffice — минуты: вернётся id задачи для job_status.',
      en: 'Installs mise versions or Debian packages (kit:office — LibreOffice, kit:pdf, kit:ocr, kit:media); asks '
        + 'the human about visibility of new ones. php, ruby, LibreOffice take minutes: a job id comes back for job_status.',
    }),
    input: { tools: specs, visibility, background },
    run: async (args, { ctx }) => {
      const { system, miseSpecs } = split(args.tools);
      if (system.length) return installSystem(ctx, args, system);
      return installMise(ctx, { ...args, tools: miseSpecs }, {
        argv: mise.installArgv(miseSpecs), cwd: ws.ensure(), label: `mise install ${miseSpecs.join(' ')}`, tool: 'env_install',
      });
    },
  },

  {
    name: 'env_use',
    group: GROUP,
    mutating: true,
    title: pick({ ru: 'Закрепить версии', en: 'Pin versions' }),
    description: pick({
      ru: 'Закрепляет версии за каталогом (mise.toml) или глобально: дальше python, php, node там нужных версий '
        + 'без tools. Недостающее ставится. Закреплённое глобально уборщик не трогает.',
      en: 'Pins versions to a directory (mise.toml) or globally: python, php, node there are then the right versions '
        + 'without tools. Missing ones get installed. The sweeper never touches global pins.',
    }),
    input: {
      tools: specs,
      dir: z.string().optional().describe(pick({
        ru: 'каталог области или проекта хоста, по умолчанию корень области',
        en: 'workspace or host project directory, the workspace root by default',
      })),
      global: z.boolean().optional(),
      background,
    },
    run: async (args, { ctx }) => {
      const { system, miseSpecs } = split(args.tools);
      if (system.length) throw new Error('kit: и apt: не закрепляются за каталогом — ставьте их env_install, они видны везде');
      // Каталог под mise.toml создаётся: закрепить версии за новым проектом — обычный первый шаг.
      const cwd = ws.resolve(args.dir || '.', { projects: true });
      fs.mkdirSync(cwd, { recursive: true });
      return installMise(ctx, { ...args, tools: miseSpecs }, {
        argv: mise.useArgv(miseSpecs, { global: args.global }),
        cwd,
        label: `mise use ${args.global ? '--global ' : ''}${miseSpecs.join(' ')}`,
        tool: 'env_use',
      });
    },
  },

  {
    name: 'env_uninstall',
    group: GROUP,
    mutating: true,
    title: pick({ ru: 'Удалить тулчейн', en: 'Uninstall a toolchain' }),
    description: pick({
      ru: 'Удаляет версии mise или наборы kit:… — например, чтобы пересобрать php. Чужие приватные не трогает.',
      en: 'Removes mise versions or kit:… sets — e.g. to rebuild php. Leaves other agents\' private ones alone.',
    }),
    input: { tools: specs },
    run: async (args, { ctx }) => {
      const { id: agent } = await agentOf(ctx);
      const { system, miseSpecs } = split(args.tools);

      if (system.length) {
        const removed = [];
        for (const parsed of system) {
          const entry = registry.get(parsed.id);
          if (!entry) throw new Error(`«${parsed.id}» не ставился через стенд — снимать нечего`);
          if (!registry.canRemove(entry, agent)) throw new Error(`«${parsed.id}» приватно нужен другому агенту — не удаляю`);
          const res = await lifecycle.removeSystem(entry, ws.ensure());
          if (!res.ok) return jobReply({ finished: true, report: res.report });
          removed.push({ id: parsed.id, packages: res.packages });
        }
        return { data: { removed } };
      }

      const index = await lifecycle.miseIndex();
      const ids = [];
      for (const spec of miseSpecs) {
        const found = index.get(await mise.where(spec));
        const entry = found && registry.get(found.id);
        if (entry && !registry.canRemove(entry, agent)) throw new Error(`«${spec}» приватно нужен другому агенту — не удаляю`);
        if (found) ids.push(found.id);
      }
      const outcome = await jobs.runForeground({
        argv: mise.uninstallArgv(miseSpecs),
        cwd: ws.ensure(),
        kind: 'install',
        label: `mise uninstall ${miseSpecs.join(' ')}`,
      });
      if (outcome.finished && outcome.report.exitCode === 0) for (const id of ids) registry.remove(id);
      return jobReply(outcome);
    },
  },
];
