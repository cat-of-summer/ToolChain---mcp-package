import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { childEnv } from './jobs.js';

// Тулчейны ставит mise: python, node, php, go, ruby, java и всё, что есть в его реестре
// (`mise registry`). Поставленное лежит в MISE_DATA_DIR — это том, и он переживает
// перезапуск и обновление образа: сборка php из исходников делается один раз.
//
// Версии выбираются тремя способами:
//   - tools в вызове exec/run_code — `mise exec <tools> -- …`, ничего не меняя на диске;
//   - mise.toml в каталоге рабочей области (env_use) — его подхватывают шимы, когда
//     команда выполняется в этом каталоге;
//   - глобально (env_use с global) — для всего, что запускается без своего mise.toml.

const pexec = promisify(execFile);

export const MISE = process.env.TK_MISE_BIN || 'mise';

/** Спецификация «имя@версия»: имя и версия без пробелов и шелл-символов. */
export const SPEC = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*(@[A-Za-z0-9._+-]+)?$/;

export function checkSpecs(specs) {
  for (const spec of specs) {
    if (!SPEC.test(spec)) throw new Error(`«${spec}» не похоже на инструмент mise: ожидается имя@версия, например python@3.11`);
  }
  return specs;
}

export const toolName = (spec) => spec.replace(/@.*$/, '').split(':').pop().split('/').pop();

async function mise(args, { cwd, timeoutMs = 60_000 } = {}) {
  const { stdout } = await pexec(MISE, args, {
    cwd,
    env: childEnv(),
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/** Поставленные версии: { python: [{version, active, source}], … }. */
export async function installed() {
  const raw = JSON.parse(await mise(['ls', '--installed', '--json']));
  return Object.fromEntries(Object.entries(raw).map(([tool, versions]) => [
    tool,
    versions.map((v) => ({
      version: v.version,
      active: Boolean(v.active),
      ...(v.source?.path ? { source: v.source.path } : {}),
    })),
  ]));
}

/** Доступные к установке версии, свежие в конце; prefix сужает (3.11 → 3.11.*). */
export async function available(tool, prefix, limit = 40) {
  const args = ['ls-remote', tool];
  if (prefix) args.push(prefix);
  const lines = (await mise(args, { timeoutMs: 120_000 })).split('\n').map((s) => s.trim()).filter(Boolean);
  return { total: lines.length, versions: lines.slice(-limit) };
}

/** Что активно в каталоге: какие версии подхватят шимы при запуске оттуда. */
export async function current(cwd) {
  const raw = JSON.parse(await mise(['ls', '--current', '--json'], { cwd }));
  return Object.fromEntries(Object.entries(raw).map(([tool, versions]) => [
    tool, versions.map((v) => ({ version: v.version, installed: Boolean(v.installed), source: v.source?.path ?? null })),
  ]));
}

export async function version() {
  try {
    return (await mise(['--version'], { timeoutMs: 10_000 })).trim();
  } catch (err) {
    return `недоступен: ${err.message}`;
  }
}

/*
 * php 5 и 7 не собираются с OpenSSL 3, который стоит в системе (ext/openssl падает на
 * RSA_SSLV23_PADDING). Для них в образе собран OpenSSL 1.1 в /opt/openssl-1.1: сборка
 * находит его через pkg-config, а rpath привязывает к нему готовый php. php 8 собирается
 * с системным. Окружение подставляется во всё, что может запустить сборку: установку,
 * закрепление версий и exec с tools (mise exec ставит недостающее сам).
 */
export const LEGACY_OPENSSL = process.env.TK_LEGACY_OPENSSL || '/opt/openssl-1.1';

const legacyPhp = (spec) => toolName(spec) === 'php' && /@[57](\.|$)/.test(spec);

export function buildEnv(specs = []) {
  if (!specs.some(legacyPhp)) return {};
  return {
    PKG_CONFIG_PATH: [`${LEGACY_OPENSSL}/lib/pkgconfig`, process.env.PKG_CONFIG_PATH].filter(Boolean).join(':'),
    LDFLAGS: [`-Wl,-rpath,${LEGACY_OPENSSL}/lib`, process.env.LDFLAGS].filter(Boolean).join(' '),
  };
}

/** argv установки — запускается задачей: сборка из исходников длится минуты. */
export const installArgv = (specs) => [MISE, 'install', ...checkSpecs(specs)];

/** argv закрепления версий за каталогом (или глобально) — заодно ставит недостающее. */
export const useArgv = (specs, { global = false } = {}) => [MISE, 'use', ...(global ? ['--global'] : []), ...checkSpecs(specs)];

export const uninstallArgv = (specs) => [MISE, 'uninstall', ...checkSpecs(specs)];

/** argv запуска команды с явными версиями: без tools — как есть, версии решают шимы. */
export function execArgv(tools, argv) {
  if (!tools?.length) return argv;
  return [MISE, 'exec', ...checkSpecs(tools), '--', ...argv];
}
