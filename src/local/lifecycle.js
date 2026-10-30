import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cfg } from '../config.js';
import * as gate from '../approve/gate.js';
import { agentOf } from '../agent.js';
import * as registry from './registry.js';
import * as apt from './apt.js';
import * as mise from './mise.js';
import * as jobs from './jobs.js';

// Жизненный цикл поставленного: вопрос «кому доступно» перед установкой, заявка в реестре
// после неё, продление при каждом использовании и восстановление пакетов Debian после
// пересоздания контейнера. Уборка истёкшего — sweeper.js.

const pexec = promisify(execFile);

/** 12 ч, 30 дн, 2 мин — срок для подписи человеку. */
export function span(ms) {
  if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)} дн`;
  if (ms >= 3600_000) return `${Math.round(ms / 3600_000)} ч`;
  return `${Math.max(1, Math.round(ms / 60_000))} мин`;
}

export function titles(agent) {
  return {
    public: 'Публично — всем агентам, надолго',
    once: `Разово — всем, удалится через ${span(cfg.toolTtl.once)} без использования`,
    ...(agent ? { private: `Приватно — только агенту «${agent}»` } : {}),
  };
}

/**
 * Видимость установки: названа в вызове — берётся она (агент передаёт её, только когда
 * человек уже сказал), иначе спрашивается человек. Нет ответа — разово: короткий срок
 * ничего не ломает, а ставить постоянно без согласия не стоит. «Не ставить» — отказ вызова.
 */
export async function chooseVisibility(ctx, { tool, specs, given }) {
  const { id: agent } = await agentOf(ctx);
  if (given) {
    if (given === 'private' && !agent) {
      throw new Error('«приватно» нужно имя агента: задайте заголовок X-Toolkit-Agent в настройках MCP-клиента');
    }
    return { visibility: given, agent };
  }

  const choices = agent ? ['public', 'once', 'private'] : ['public', 'once'];
  const summary = `Поставить ${specs.join(', ')}. Кому будет доступно?`;
  const decision = await gate.ask(ctx, {
    tool,
    summary,
    details: {
      'что это значит': 'Публично и приватно — срок продлевается, пока инструментом пользуются; '
        + 'неиспользуемое уборщик удаляет сам. Без ответа — разово.',
      ...(agent ? {} : { приватно: 'недоступно: агент не назвался (заголовок X-Toolkit-Agent или MCP roots)' }),
    },
    choices,
    titles: titles(agent),
    declineTitle: 'Не ставить',
  });

  if (decision.status === 'approved') return { visibility: decision.level, agent, question: decision.id };
  if (decision.status === 'timeout') return { visibility: 'once', agent, question: decision.id, defaulted: true };
  throw new gate.Declined({ scope: 'call', ...decision }, summary);
}

// --- mise ---------------------------------------------------------------------------------

/** install_path → { id, tool, version } по `mise ls --installed`. */
export async function miseIndex() {
  const installed = await mise.installed();
  const index = new Map();
  for (const [tool, versions] of Object.entries(installed)) {
    for (const v of versions) {
      if (!v.path) continue;
      index.set(v.path, { id: `mise:${tool}@${v.version}`, tool, version: v.version, path: v.path });
    }
  }
  return index;
}

/** Какие спецификации ещё не стоят — о них и спрашивается видимость. */
export async function missing(specs) {
  const found = await Promise.all(specs.map((spec) => mise.where(spec)));
  return specs.filter((_, i) => !found[i]);
}

/**
 * После установки или запуска: спецификации → записи реестра. Новые (и те, о которых
 * сказана видимость) получают заявку, уже стоявшие — продление.
 */
export async function recordMise(specs, { visibility = null, agent = null, fresh = [] } = {}) {
  if (!specs?.length) return [];
  const index = await miseIndex();
  const ids = [];
  for (const spec of specs) {
    const where = await mise.where(spec);
    const found = where && index.get(where);
    if (!found) continue;
    const meta = { kind: 'mise', tool: found.tool, version: found.version, path: found.path };
    if (visibility && (fresh.includes(spec) || !registry.get(found.id) || visibility !== 'once')) {
      registry.claim(found.id, { visibility, agent, meta });
    } else if (!registry.touch(found.id, agent)) {
      registry.claim(found.id, { visibility: 'once', agent, meta });
    }
    ids.push(found.id);
  }
  return ids;
}

// Сколько установок идёт сейчас: пока хоть одна идёт, сверка реестра с диском не заводит
// новых записей — иначе версия, которую ставят приватно, на миг стала бы общей.
let installs = 0;

export const installing = () => installs > 0;

/**
 * Отметить начало установки; вернёт функцию «закончилась». Не закрытая по ошибке отметка
 * снимается сама через три часа: дольше не собирается даже php, а вечная — остановила бы сверку.
 */
export function beginInstall() {
  installs++;
  let open = true;
  const end = () => {
    if (open) installs--;
    open = false;
    clearTimeout(timer);
  };
  const timer = setTimeout(end, 3 * 3600_000);
  timer.unref?.();
  return end;
}

// --- использование ------------------------------------------------------------------------

const busy = new Map(); // id записи -> сколько задач им сейчас пользуется

export const inUse = (id) => (busy.get(id) || 0) > 0;

function hold(ids) {
  for (const id of ids) busy.set(id, (busy.get(id) || 0) + 1);
  return () => {
    for (const id of ids) {
      const left = (busy.get(id) || 1) - 1;
      if (left > 0) busy.set(id, left);
      else busy.delete(id);
    }
  };
}

/** Что задача держит сейчас: версии из tools, а без них — подхваченные шимами в cwd; наборы по командам. */
async function heldBy({ tools, cwd, command }) {
  const ids = [];
  try {
    const index = await miseIndex();
    const paths = tools?.length
      ? (await Promise.all(tools.map((spec) => mise.where(spec)))).filter(Boolean)
      : await mise.installPaths('--current', cwd);
    for (const p of paths) if (index.get(p)) ids.push(index.get(p).id);
  } catch { /* mise не ответил — учёт пропускаем, работа важнее */ }
  for (const entry of registry.all()) {
    if (entry.kind === 'apt' && apt.mentions(command, entry.bins)) ids.push(entry.id);
  }
  return ids;
}

/**
 * Учёт запуска exec/run_code — не задерживая ответ: продлить то, чем пользуется задача,
 * держать это от уборщика, пока она идёт, и записать поставленное ею (tools, которых не было).
 */
export function trackRun(ctx, { jobId, tools, cwd, command, choice, fresh, ended = () => {} }) {
  (async () => {
    const agent = choice ? choice.agent : (await agentOf(ctx)).id;
    const ids = await heldBy({ tools: fresh?.length ? tools.filter((t) => !fresh.includes(t)) : tools, cwd, command });
    for (const id of ids) registry.touch(id, agent);
    const release = hold(ids);
    try {
      await jobs.done(jobId);
      if (fresh?.length) await recordMise(fresh, { visibility: choice?.visibility, agent, fresh });
    } finally {
      release();
      ended();
    }
  })().catch((err) => console.error(`[toolkit] учёт инструментов: ${err.message}`));
}

// --- пакеты Debian ------------------------------------------------------------------------

const restoring = new Map(); // id записи -> id задачи восстановления

export const restoringJob = (id) => restoring.get(id) ?? null;

/**
 * Пакеты записи, которые можно снять: поставленные стендом (owned — не запечённые в образ и
 * не стоявшие до него) и не нужные ни одной другой записи.
 */
function exclusivePackages(entry) {
  const others = new Set(registry.all()
    .filter((e) => e.kind === 'apt' && e.id !== entry.id)
    .flatMap((e) => e.packages || []));
  return (entry.owned || []).filter((name) => !others.has(name));
}

/** После установки набора: заявка с пакетами, командами и файлами .deb из кэша. */
export async function recordSystem(parsed, { visibility, agent, debs, preinstalled = [] }) {
  const bins = [...new Set([...parsed.bins, ...(await apt.binsOf(parsed.packages))])];
  const before = registry.get(parsed.id);
  const owned = [...new Set([
    ...(before?.owned || []),
    ...parsed.packages.filter((name) => !preinstalled.includes(name)),
  ])];
  registry.claim(parsed.id, {
    visibility: visibility ?? 'once',
    agent,
    meta: {
      kind: 'apt', packages: parsed.packages, owned, bins,
      debs: [...new Set([...(before?.debs || []), ...debs])],
      ...(parsed.about ? { about: parsed.about } : {}),
    },
  });
}

/** Задача установки наборов; учёт — по её завершении. preinstalled — стояло до неё. */
export function startSystemInstall(parsedList, { visibility, agent, label, preinstalled = [] }) {
  const packages = [...new Set(parsedList.flatMap((p) => p.packages))];
  const before = new Set(apt.archives());
  const job = apt.installJob(packages);
  return {
    job,
    packages,
    label: label ?? `apt install ${parsedList.map((p) => p.id).join(' ')}`,
    async finalize(jobId) {
      await jobs.done(jobId);
      const rep = jobs.report(jobId);
      if (rep.exitCode !== 0) return false;
      const debs = apt.archives().filter((name) => !before.has(name));
      for (const parsed of parsedList) await recordSystem(parsed, { visibility, agent, debs, preinstalled });
      return true;
    },
  };
}

/** Снимает набор: пакеты, которые больше никому не нужны, и их .deb в кэше. */
export async function removeSystem(entry, cwd) {
  const packages = exclusivePackages(entry);
  let rep = null;
  if (packages.length) {
    const job = apt.removeJob(packages);
    const id = jobs.start({ ...job, cwd, timeoutMs: 0, kind: 'install', label: `apt purge ${entry.id}` });
    await jobs.done(id);
    rep = jobs.report(id);
    if (rep.exitCode !== 0) return { ok: false, report: rep };
  }
  const keep = new Set(registry.all().filter((e) => e.kind === 'apt' && e.id !== entry.id).flatMap((e) => e.debs || []));
  apt.dropArchives(entry.debs, keep);
  registry.remove(entry.id);
  return { ok: true, packages, report: rep };
}

/**
 * После пересоздания контейнера системные пакеты пропали, а реестр и кэш .deb в томе
 * остались: живые наборы ставятся заново, в фоне. Пока идёт — env_list показывает restoring.
 */
export async function restoreSystem(cwd) {
  for (const entry of registry.all()) {
    if (entry.kind !== 'apt' || restoring.has(entry.id) || !entry.packages?.length) continue;
    if (await apt.installed(entry.packages)) continue;
    const job = apt.installJob(entry.packages);
    const id = jobs.start({ ...job, cwd, timeoutMs: 0, kind: 'install', label: `восстановление ${entry.id}` });
    restoring.set(entry.id, id);
    jobs.done(id).then(() => restoring.delete(entry.id));
    console.log(`[toolkit] восстанавливаю ${entry.id} из кэша тома: задача ${id}`);
  }
}

const summaries = new Map(); // агент -> { at, text }

/**
 * Одной строкой, что уже стоит: «php 8.2.35, 8.3.35; python 3.12.15; kit:office». Её агент
 * видит в инструкциях при подключении — до того, как решит поднять контейнер с php.
 */
export async function summary(agent = null) {
  const cached = summaries.get(agent);
  if (cached && Date.now() - cached.at < 60_000) return cached.text;
  let text = '';
  try {
    const parts = [];
    for (const [tool, versions] of Object.entries(await mise.installed())) {
      const shown = versions.filter((v) => {
        const entry = registry.get(`mise:${tool}@${v.version}`);
        return !entry || registry.visibleTo(entry, agent);
      });
      if (shown.length) parts.push(`${tool} ${shown.map((v) => v.version).join(', ')}`);
    }
    for (const entry of registry.all()) {
      if (entry.kind === 'apt' && registry.visibleTo(entry, agent)) parts.push(entry.id);
    }
    text = parts.join('; ');
  } catch { /* mise не ответил — строки не будет, инструкции и без неё верны */ }
  summaries.set(agent, { at: Date.now(), text });
  return text;
}

/** Размер каталога установки — для env_list и решения, что чистить. */
export async function sizeOf(dir) {
  try {
    const { stdout } = await pexec('du', ['-sb', dir], { timeout: 120_000 });
    return Number(stdout.split('\t')[0]) || null;
  } catch {
    return null;
  }
}
