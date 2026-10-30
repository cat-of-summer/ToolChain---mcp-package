import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config.js';
import { DIRS } from '../paths.js';

// Реестр поставленного: кто, как и когда последний раз пользовался версией mise или набором
// пакетов. На нём держатся видимость (кому показывать) и срок жизни (когда убрать).
//
// Запись — одна установка: «mise:php@8.3.35», «kit:office», «apt:jq». У записи — заявки
// (claims): публичная, разовая и приватные по агентам. Запись живёт, пока жива хоть одна
// заявка; срок каждой считается от последнего использования:
//   - once — TK_TOOL_TTL_ONCE (12 ч): работа с инструментом его продлевает, и посреди дела
//     он не исчезнет;
//   - public, private — база плюс TK_TOOL_TTL_PER_DAY за каждые сутки с использованием, не
//     дольше TK_TOOL_TTL_MAX. Считаются сутки, а не вызовы: цикл из тысячи exec за вечер
//     не должен продлевать срок на годы.
// Приватность — видимость в списках и защита от удаления чужим агентом, не изоляция: код
// всех агентов выполняется в одном контейнере.

export const VISIBILITY = ['public', 'once', 'private'];

const file = () => path.join(DIRS.tools, '.tk', 'registry.json');
let state = null;

function load() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    state = null;
  }
  if (!state || typeof state.entries !== 'object') state = { migrated: false, entries: {} };
  return state;
}

function save() {
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, target);
}

/** Забыть прочитанное: тесты подменяют каталог. */
export function reset() {
  state = null;
}

const iso = (ms) => new Date(ms).toISOString();
const dayOf = (ms) => iso(ms).slice(0, 10);
const keyOf = (visibility, agent) => (visibility === 'private' ? `private:${agent}` : visibility);

export function claimExpires(claim) {
  const last = Date.parse(claim.lastUsedAt);
  if (claim.visibility === 'once') return last + cfg.toolTtl.once;
  const bonus = cfg.toolTtl.perDay * Math.max(0, (claim.activeDays || 1) - 1);
  return last + Math.min(cfg.toolTtl[claim.visibility] + bonus, cfg.toolTtl.max);
}

/** Когда запись уйдёт: по самой долгой заявке. Закреплённая глобально — никогда (null). */
export function expiresAt(entry) {
  if (entry.pinned) return null;
  if (!entry.claims.length) return 0;
  return Math.max(...entry.claims.map(claimExpires));
}

const visibleClaim = (claim, agent) => claim.visibility !== 'private' || (agent && claim.agent === agent);

export const visibleTo = (entry, agent) => entry.claims.some((claim) => visibleClaim(claim, agent));

/** Убрать запись можно, если на ней нет чужих приватных заявок. */
export const canRemove = (entry, agent) => !entry.claims.some((c) => c.visibility === 'private' && c.agent !== agent);

export const get = (id) => load().entries[id] ?? null;
export const all = () => Object.values(load().entries);

function touchClaim(claim, now) {
  if (claim.lastDay !== dayOf(now)) {
    claim.activeDays = (claim.activeDays || 0) + 1;
    claim.lastDay = dayOf(now);
  }
  claim.lastUsedAt = iso(now);
}

function entryOf(id, meta = {}, now = Date.now()) {
  const entries = load().entries;
  entries[id] ??= { id, installedAt: iso(now), claims: [] };
  Object.assign(entries[id], meta);
  return entries[id];
}

/** Заявка агента на запись: создаёт запись, если её нет; та же заявка — продлевается. */
export function claim(id, { visibility, agent = null, meta, now = Date.now() }) {
  if (!VISIBILITY.includes(visibility)) throw new Error(`видимость «${visibility}» не понята: есть ${VISIBILITY.join(', ')}`);
  if (visibility === 'private' && !agent) {
    throw new Error('«приватно» нужно имя агента: заголовок X-Toolkit-Agent или MCP roots у клиента');
  }
  const entry = entryOf(id, meta, now);
  const key = keyOf(visibility, agent);
  const found = entry.claims.find((c) => c.key === key);
  if (found) touchClaim(found, now);
  else {
    entry.claims.push({
      key, visibility, agent: visibility === 'private' ? agent : null, by: agent,
      claimedAt: iso(now), lastUsedAt: iso(now), lastDay: dayOf(now), activeDays: 1,
    });
  }
  save();
  return entry;
}

/**
 * Агент воспользовался записью: продлевается его самая сильная видимая заявка — своя
 * приватная, иначе публичная, иначе разовая. Видимой нет (чужая приватная) — появляется
 * разовая: ставить ничего не пришлось, а пропасть из-под работы версия не должна.
 */
export function touch(id, agent = null, now = Date.now()) {
  const entry = get(id);
  if (!entry) return null;
  const pick = entry.claims.find((c) => c.visibility === 'private' && agent && c.agent === agent)
    ?? entry.claims.find((c) => c.visibility === 'public')
    ?? entry.claims.find((c) => c.visibility === 'once');
  if (!pick) return claim(id, { visibility: 'once', agent, now });
  touchClaim(pick, now);
  save();
  return entry;
}

export function update(id, meta) {
  const entry = get(id);
  if (!entry) return null;
  Object.assign(entry, meta);
  save();
  return entry;
}

export function remove(id) {
  delete load().entries[id];
  save();
}

/** Записи, срок которых вышел. */
export const expired = (now = Date.now()) => all().filter((entry) => {
  const until = expiresAt(entry);
  return until !== null && until <= now;
});

/**
 * Сверка с тем, что лежит на диске (только kind, которые переданы: mise или apt).
 * present — Map id → meta. Нового без записи при первой сверке — публичное (стояло до
 * реестра); потом — разовое: его поставили в обход вопроса, например mise install в exec.
 * Записи, которых на диске больше нет, убираются. addNew: false — пока идёт установка: её
 * версия уже на диске, но заявку с выбранной видимостью она запишет сама по завершении.
 */
export function reconcile(kind, present, now = Date.now(), { addNew = true } = {}) {
  const st = load();
  const added = [];
  const dropped = [];
  for (const [id, meta] of present) {
    if (st.entries[id] || (!addNew && st.migrated)) continue;
    const visibility = st.migrated ? 'once' : 'public';
    entryOf(id, { kind, ...meta }, now).claims.push({
      key: visibility, visibility, agent: null, by: null,
      claimedAt: iso(now), lastUsedAt: iso(now), lastDay: dayOf(now), activeDays: 1,
    });
    added.push(id);
  }
  for (const entry of Object.values(st.entries)) {
    if (entry.kind === kind && !present.has(entry.id)) {
      delete st.entries[entry.id];
      dropped.push(entry.id);
    }
  }
  st.migrated = true;
  save();
  return { added, dropped };
}

/** Что видит агент: самая сильная видимая ему заявка, его ли она, сроки. */
export function view(entry, agent) {
  const mine = entry.claims.filter((c) => visibleClaim(c, agent));
  const visibility = mine.some((c) => c.visibility === 'private') ? 'private'
    : mine.some((c) => c.visibility === 'public') ? 'public' : 'once';
  const until = expiresAt(entry);
  return {
    visibility,
    ...(visibility === 'private' ? { yours: true } : {}),
    lastUsedAt: mine.map((c) => c.lastUsedAt).sort().at(-1) ?? null,
    expiresAt: until === null ? null : iso(until),
    ...(entry.pinned ? { pinned: 'закреплено глобально (env_use global) — уборщик не трогает' } : {}),
    ...(entry.sizeBytes ? { sizeMB: Math.round(entry.sizeBytes / 1024 / 1024) } : {}),
  };
}
