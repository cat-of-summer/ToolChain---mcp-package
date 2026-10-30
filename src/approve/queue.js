import { EventEmitter } from 'node:events';
import { newId } from '../audit/log.js';

// Очередь подтверждений для клиентов, которые не умеют спрашивать сами (elicitation).
// Живёт в памяти: ждущий вызов всё равно не переживает перезапуск процесса, а история
// решений лежит в журнале вместе с вызовом, которого она касалась.

const KEEP = 200;
const items = new Map(); // id -> заявка, в порядке создания
const waiting = new Map();
export const events = new EventEmitter();
events.setMaxListeners(0);

const now = () => new Date().toISOString();

function trim() {
  while (items.size > KEEP) {
    const oldest = [...items.values()].find((item) => item.status !== 'pending');
    if (!oldest) return;
    items.delete(oldest.id);
  }
}

// choices — варианты на выбор (уровни доступа read, write или свои с подписями titles):
// тогда решение — вариант, а approved значит первый из них, тот, о котором спросили.
export function create({ tool, target, summary, details, choices, titles, declineTitle }) {
  const id = newId();
  items.set(id, {
    id, ts: now(), tool, target: target ?? null, summary, details: details ?? null,
    choices: choices ?? null, titles: titles ?? null, declineTitle: declineTitle ?? null,
    status: 'pending', decidedAt: null, decidedVia: null,
  });
  trim();
  events.emit('change', { id, action: 'created' });
  return id;
}

function close(id, status, via) {
  const item = items.get(id);
  if (!item || item.status !== 'pending') return item;
  Object.assign(item, { status, decidedAt: now(), decidedVia: via });
  return item;
}

/** Закрывает заявку без ответа человека: timeout или cancelled (клиент бросил вызов). */
export function expire(id, status, via = status) {
  close(id, status, via);
  const resume = waiting.get(id);
  if (resume) resume({ status, via });
  events.emit('change', { id, action: status });
}

/** Ждёт решения до timeoutMs; signal — вызов, ради которого спрашивали, брошен клиентом. */
export function wait(id, timeoutMs, signal) {
  return new Promise((resolve) => {
    const onAbort = () => expire(id, 'cancelled', 'client');
    const timer = setTimeout(() => expire(id, 'timeout'), timeoutMs);

    waiting.set(id, (outcome) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      waiting.delete(id);
      resolve(outcome);
    });

    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function decide(id, status, via = 'web') {
  const item = items.get(id);
  if (!item) throw new Error(`заявка «${id}» не найдена`);
  if (!['approved', 'declined', ...(item.choices || [])].includes(status)) {
    throw new Error(`решение «${status}» не понято${item.choices ? `: есть approved, declined, ${item.choices.join(', ')}` : ''}`);
  }
  if (item.status !== 'pending') throw new Error(`заявка «${id}» уже закрыта: ${item.status}`);

  close(id, status, via);
  const resume = waiting.get(id);
  if (resume) resume({ status, via });
  events.emit('change', { id, action: status });
  return { id, status, via };
}

export const pending = () => [...items.values()].filter((item) => item.status === 'pending');
export const recent = (limit = 50) => [...items.values()].reverse().slice(0, limit);
export const get = (id) => items.get(id) ?? null;
export const pendingCount = () => pending().length;
