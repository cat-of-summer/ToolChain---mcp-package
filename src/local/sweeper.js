import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config.js';
import { DIRS } from '../paths.js';
import * as audit from '../audit/log.js';
import * as ws from '../workspace.js';
import * as registry from './registry.js';
import * as lifecycle from './lifecycle.js';
import * as mise from './mise.js';
import * as jobs from './jobs.js';

// Уборщик тома tools: раз в TK_TOOLS_SWEEP сверяет реестр с диском и снимает то, чей срок
// вышел, — версии mise и наборы пакетов. Заодно убирает недособранное: каталог версии,
// которой mise не знает (сборка php упала посреди), лежит в томе и занимает сотни мегабайт.
// Каждое удаление — отдельная запись журнала с tool: "sweep".

const DAY = 86_400_000;
let running = null;

const installsDir = () => path.join(DIRS.tools, 'installs');

function logged(args, outcome) {
  const entry = audit.start({ tool: 'sweep', args, kind: 'env' });
  audit.finish(entry, { ok: outcome.ok, exitCode: outcome.exitCode ?? null, command: outcome.command ?? null, stdout: outcome.stdout ?? '', stderr: outcome.stderr ?? '' });
}

const installRunning = () => lifecycle.installing()
  || jobs.list().some((job) => job.status === 'running' && job.kind === 'install');

/** Реестр ← диск: новые установки, пропавшие, закреплённые глобально, размеры. */
export async function reconcile(now = Date.now()) {
  const index = await lifecycle.miseIndex();
  const present = new Map([...index.values()].map(({ id, tool, version, path: p }) => [id, { tool, version, path: p }]));
  registry.reconcile('mise', present, now, { addNew: !lifecycle.installing() });

  let pinned = new Set();
  try {
    pinned = new Set((await mise.installPaths('--global')).map((p) => index.get(p)?.id).filter(Boolean));
  } catch { /* глобального конфига нет */ }

  for (const entry of registry.all()) {
    if (entry.kind !== 'mise') continue;
    const meta = {};
    if (Boolean(entry.pinned) !== pinned.has(entry.id)) meta.pinned = pinned.has(entry.id);
    if (entry.path && (!entry.sizedAt || now - Date.parse(entry.sizedAt) > DAY)) {
      meta.sizeBytes = await lifecycle.sizeOf(entry.path);
      meta.sizedAt = new Date(now).toISOString();
    }
    if (Object.keys(meta).length) registry.update(entry.id, meta);
  }
  return index;
}

/** Каталоги версий, которых mise не знает и которые не трогали сутки, — остатки упавших сборок. */
export function orphans(index, now = Date.now()) {
  const known = new Set(index.keys());
  const found = [];
  let tools = [];
  try { tools = fs.readdirSync(installsDir(), { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return found; }
  for (const tool of tools) {
    const dir = path.join(installsDir(), tool.name);
    for (const version of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!version.isDirectory() || version.name.startsWith('.')) continue; // симлинки 8.3 → 8.3.35 — не версии
      const full = path.join(dir, version.name);
      if (known.has(full)) continue;
      if (now - fs.statSync(full).mtimeMs < DAY) continue;
      found.push(full);
    }
  }
  return found;
}

async function uninstallMise(entry) {
  const id = jobs.start({
    argv: mise.uninstallArgv([`${entry.tool}@${entry.version}`]),
    cwd: ws.ensure(),
    timeoutMs: 600_000,
    kind: 'install',
    label: `mise uninstall ${entry.tool}@${entry.version} (срок вышел)`,
  });
  await jobs.done(id);
  const rep = jobs.report(id);
  // mise не справился (версию ставили в обход него) — каталог убирается сам.
  if (rep.exitCode !== 0 && entry.path && entry.path.startsWith(installsDir())) {
    fs.rmSync(entry.path, { recursive: true, force: true });
    return { ...rep, exitCode: 0, stderr: `${rep.stderr}\nmise uninstall не прошёл — каталог ${entry.path} удалён напрямую` };
  }
  return rep;
}

/** Один проход: сверка, сироты, истёкшее. Возвращает, что убрано. */
export async function sweep(now = Date.now()) {
  if (running) return running;
  running = (async () => {
    const removed = [];
    const index = await reconcile(now);

    if (!installRunning()) {
      for (const dir of orphans(index, now)) {
        fs.rmSync(dir, { recursive: true, force: true });
        logged({ id: dir, reason: 'каталог версии, которой mise не знает: недособранная установка' }, { ok: true, command: `rm -rf ${dir}` });
        removed.push(dir);
      }
    }

    for (const entry of registry.expired(now)) {
      if (lifecycle.inUse(entry.id) || lifecycle.restoringJob(entry.id)) continue;
      const reason = `срок вышел ${new Date(registry.expiresAt(entry)).toISOString()}`;
      if (entry.kind === 'mise') {
        const rep = await uninstallMise(entry);
        if (rep.exitCode === 0) registry.remove(entry.id);
        logged({ id: entry.id, reason }, { ok: rep.exitCode === 0, exitCode: rep.exitCode, command: rep.label, stdout: rep.stdout, stderr: rep.stderr });
        if (rep.exitCode === 0) removed.push(entry.id);
      } else if (entry.kind === 'apt') {
        const res = await lifecycle.removeSystem(entry, ws.ensure());
        logged({ id: entry.id, reason, packages: res.packages }, {
          ok: res.ok, exitCode: res.report?.exitCode ?? 0, command: res.report?.label ?? null,
          stdout: res.report?.stdout ?? '', stderr: res.report?.stderr ?? '',
        });
        if (res.ok) removed.push(entry.id);
      }
    }

    if (removed.length) {
      try { await jobs.done(jobs.start({ argv: [mise.MISE, 'cache', 'prune'], cwd: ws.ensure(), kind: 'install', label: 'mise cache prune' })); } catch { /* не критично */ }
    }
    return removed;
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}

/** Старт процесса: пакеты Debian — сразу назад из кэша, уборка — через минуту и дальше по таймеру. */
export function start() {
  const quiet = (what) => (err) => console.error(`[toolkit] ${what}: ${err.message}`);
  lifecycle.restoreSystem(ws.ensure()).catch(quiet('восстановление пакетов'));
  const first = setTimeout(() => sweep().catch(quiet('уборка тулчейнов')), 60_000);
  const every = setInterval(() => sweep().catch(quiet('уборка тулчейнов')), cfg.toolsSweepMs);
  first.unref?.();
  every.unref?.();
}
