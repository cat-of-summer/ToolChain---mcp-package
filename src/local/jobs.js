import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cfg } from '../config.js';
import { DIRS, ensureDirs } from '../paths.js';
import { newId } from '../audit/log.js';
import { scrub } from '../secrets.js';
import { fallbackEnv, versionsHost, markDown, FAILED_ON_HOST } from './reach.js';

// Всё, что стенд запускает у себя — команда агента, его код, установка тулчейна, —
// идёт задачей. Короткая задача отвечает сразу, как обычный вызов. Долгая (сборка php,
// npm install, dev-сервер) через TK_FOREGROUND_TIMEOUT уходит в фон: вызов возвращает её
// id, а результат забирается job_status. Клиенты MCP обрывают долгие вызовы, и ждать
// сборку в одном вызове значило бы потерять её результат.
//
// Потоки пишутся в файлы задачи целиком (state/jobs/<id>/), в ответ уходит хвост с
// потолком. Задача — группа процессов: job_kill гасит и всё, что она породила.

const jobs = new Map(); // id -> задача
const META = 'job.json';

const now = () => new Date().toISOString();

// Окружение стенда в дочерний процесс не передаётся целиком: в нём токен сервиса
// секретов и настройки сервера, коду агента до них дела нет.
const HIDDEN = /^(TK_|MCP_|NODE_MODE$|PUBLIC_BASE_URL$|HTTP_LOGIN$|HTTP_PASSWORD$|BUNDLE_IMAGE$)/;

export function childEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!HIDDEN.test(key)) env[key] = value;

  // Шимы mise — первыми в PATH: python, php, node в каталоге с mise.toml берутся нужных
  // версий. Ставится здесь, а не только в образе: в бандле окружение задаёт supervisord.
  Object.assign(env, fallbackEnv(env));

  if (env.MISE_DATA_DIR) {
    const shims = `${env.MISE_DATA_DIR}/shims`;
    const parts = (env.PATH || '').split(':').filter((part) => part && part !== shims);
    env.PATH = [shims, ...parts].join(':');
  }
  return { ...env, ...extra };
}

function dirOf(id) {
  return path.join(DIRS.jobs, id);
}

function persist(job) {
  try {
    fs.writeFileSync(path.join(dirOf(job.id), META), JSON.stringify(publicView(job), null, 2));
  } catch { /* каталог задачи уже убран */ }
}

/** Что видно агенту и журналу: без буферов и дескрипторов. */
function publicView(job) {
  return {
    id: job.id,
    label: job.label,
    kind: job.kind,
    cwd: job.cwd,
    status: job.status,
    exitCode: job.exitCode,
    signal: job.signal,
    timedOut: job.timedOut,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: job.finishedAt ? Date.parse(job.finishedAt) - Date.parse(job.startedAt) : Date.now() - Date.parse(job.startedAt),
  };
}

/** Хвост файла потока: последние maxBytes байт, по границе строки. */
export function tail(file, maxBytes = cfg.maxTextBytes / 2) {
  if (!fs.existsSync(file)) return { text: '', bytes: 0, truncated: false };
  const size = fs.statSync(file).size;
  const take = Math.min(size, maxBytes);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(take);
  fs.readSync(fd, buf, 0, take, size - take);
  fs.closeSync(fd);
  let text = buf.toString('utf8');
  if (take < size) text = text.slice(text.indexOf('\n') + 1);
  return { text, bytes: size, truncated: take < size };
}

function prune() {
  const done = [...jobs.values()].filter((job) => job.status !== 'running');
  for (const job of done.slice(0, Math.max(0, done.length - cfg.jobsKeep))) {
    jobs.delete(job.id);
    fs.rmSync(dirOf(job.id), { recursive: true, force: true });
  }
}

/**
 * Запускает задачу.
 *   argv     — [команда, ...аргументы]; шелл агент зовёт сам, если он ему нужен
 *   cwd, env — каталог и переменные (поверх очищенного окружения стенда)
 *   stdin    — текст на вход
 *   timeoutMs — потолок жизни задачи; 0 — без потолка (dev-сервер)
 *   secrets  — значения, которые вычищаются из ответа
 */
export function start({ argv, cwd, env, stdin, timeoutMs = cfg.execTimeoutMs, label, kind = 'exec', secrets = [] }) {
  // Несуществующий cwd spawn называет «ENOENT» по имени команды — выглядит как «нет mise».
  if (cwd && !fs.existsSync(cwd)) throw new Error(`каталога «${path.basename(cwd)}» нет в рабочей области — создайте его или уберите cwd`);
  ensureDirs();
  prune();

  const id = newId();
  fs.mkdirSync(dirOf(id), { recursive: true });
  const outFile = path.join(dirOf(id), 'stdout.log');
  const errFile = path.join(dirOf(id), 'stderr.log');
  const out = fs.openSync(outFile, 'w');
  const err = fs.openSync(errFile, 'w');

  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env: childEnv(env),
    stdio: ['pipe', out, err],
    // Своя группа процессов: kill по -pid гасит и всё, что задача породила.
    detached: true,
  });

  const job = {
    id, label: label ?? argv.join(' '), kind, cwd, status: 'running', exitCode: null, signal: null, timedOut: false,
    startedAt: now(), finishedAt: null, child, outFile, errFile, secrets, waiters: [],
  };
  jobs.set(id, job);
  persist(job);

  let timer = null;
  if (timeoutMs > 0) {
    timer = setTimeout(() => { job.timedOut = true; kill(id); }, timeoutMs);
    timer.unref?.();
  }

  const finish = (code, signal, error) => {
    if (job.status !== 'running') return;
    clearTimeout(timer);
    fs.closeSync(out);
    fs.closeSync(err);
    if (error) fs.appendFileSync(errFile, `\n${error.message}\n`);
    job.status = error ? 'failed' : (job.killed ? 'killed' : 'done');
    job.exitCode = code ?? null;
    job.signal = signal ?? null;
    job.finishedAt = now();
    delete job.child;
    persist(job);
    for (const resolve of job.waiters.splice(0)) resolve();
  };

  child.on('error', (e) => finish(null, null, e));
  child.on('exit', (code, signal) => finish(code, signal));
  child.stdin.on('error', () => { /* процесс не читает stdin — не беда */ });
  if (stdin !== undefined && stdin !== null) child.stdin.end(stdin);
  else child.stdin.end();

  return id;
}

/** Ждёт завершения задачи не дольше ms. true — завершилась. */
export function wait(id, ms) {
  const job = jobs.get(id);
  if (!job) return Promise.resolve(true);
  if (job.status !== 'running') return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    job.waiters.push(() => { clearTimeout(timer); resolve(true); });
  });
}

export function kill(id) {
  const job = jobs.get(id);
  if (!job) throw new Error(`задачи «${id}» нет`);
  if (job.status !== 'running') return publicView(job);
  job.killed = true;
  try { process.kill(-job.child.pid, 'SIGTERM'); } catch { /* уже нет */ }
  const hard = setTimeout(() => { try { process.kill(-job.child.pid, 'SIGKILL'); } catch { /* уже нет */ } }, 5000);
  hard.unref?.();
  return publicView(job);
}

/** Состояние задачи с хвостами потоков, вычищенными от секретов вызова. */
export function report(id, { maxBytes } = {}) {
  const job = jobs.get(id) ?? load(id);
  if (!job) throw new Error(`задачи «${id}» нет — она могла устареть (хранится ${cfg.jobsKeep} последних)`);
  const half = Math.floor((maxBytes || cfg.maxTextBytes) / 2);
  const stdout = tail(job.outFile, half);
  const stderr = tail(job.errFile, half);
  const secrets = job.secrets || [];
  return {
    ...publicView(job),
    stdout: scrub(stdout.text, secrets),
    stderr: scrub(stderr.text, secrets),
    stdoutBytes: stdout.bytes,
    stderrBytes: stderr.bytes,
    truncated: stdout.truncated || stderr.truncated,
    logs: { stdout: path.relative(DIRS.jobs, job.outFile), stderr: path.relative(DIRS.jobs, job.errFile) },
  };
}

/** Задача из прошлой жизни процесса: читается с диска, бежавшая тогда считается потерянной. */
function load(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const file = path.join(dirOf(id), META);
  if (!fs.existsSync(file)) return null;
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    ...meta,
    status: meta.status === 'running' ? 'lost' : meta.status,
    outFile: path.join(dirOf(id), 'stdout.log'),
    errFile: path.join(dirOf(id), 'stderr.log'),
  };
}

/** stdout задачи целиком — в файл, с вычисткой секретов вызова. */
export function saveStdout(id, file) {
  const job = jobs.get(id) ?? load(id);
  if (!job) throw new Error(`задачи «${id}» нет`);
  const secrets = job.secrets || [];
  if (!secrets.length) return fs.copyFileSync(job.outFile, file);
  return fs.writeFileSync(file, scrub(fs.readFileSync(job.outFile, 'utf8'), secrets));
}

export function list() {
  return [...jobs.values()].reverse().map(publicView);
}

export const running = () => [...jobs.values()].filter((job) => job.status === 'running').length;

export function killAll() {
  for (const job of jobs.values()) {
    if (job.status === 'running') try { process.kill(-job.child.pid, 'SIGKILL'); } catch { /* уже нет */ }
  }
}

/**
 * Запускает и ждёт до TK_FOREGROUND_TIMEOUT (или background — не ждёт вовсе).
 * Успела — отчёт целиком, как у обычного вызова; нет — id задачи и подсказка.
 */
export async function runForeground(spec, options = {}) {
  const outcome = await once(spec, options);
  const rep = outcome.report;

  // Установка упала на хосте версий mise — он снова недоступен. Помечаем и повторяем один раз:
  // окружение повтора childEnv соберёт уже с переключением на первоисточники.
  if (outcome.finished && rep.exitCode !== 0 && versionsHost() !== false && FAILED_ON_HOST.test(rep.stderr)) {
    markDown();
    const retry = await once(spec, options);
    retry.report.retried = `первая попытка (${rep.id}) упала на mise-versions.jdx.dev — повторено через первоисточники`;
    return retry;
  }
  return outcome;
}

async function once(spec, { background = false, waitMs = cfg.foregroundMs } = {}) {
  const id = start(spec);
  const finished = background ? false : await wait(id, waitMs);
  if (finished) return { finished: true, report: report(id) };
  return { finished: false, id, report: report(id) };
}
