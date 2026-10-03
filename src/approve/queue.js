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

export function create({ tool, target, summary, details }) {
  const id = newId();
  items.set(id, {
    id, ts: now(), tool, target: target ?? null, summary, details: details ?? null,
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

export function wait(id, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      close(id, 'timeout', 'timeout');
      events.emit('change', { id, action: 'timeout' });
      resolve({ status: 'timeout', via: 'timeout' });
    }, timeoutMs);

    waiting.set(id, (outcome) => {
      clearTimeout(timer);
      waiting.delete(id);
      resolve(outcome);
    });
  });
}

export function decide(id, status, via = 'web') {
  if (!['approved', 'declined'].includes(status)) throw new Error(`решение «${status}» не понято`);
  const item = items.get(id);
  if (!item) throw new Error(`заявка «${id}» не найдена`);
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
