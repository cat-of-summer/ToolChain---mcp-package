import { tools as service } from './help.js';
import { tools as env } from './env.js';
import { tools as run } from './run.js';
import { tools as workspace } from './ws.js';
import { tools as shell } from './shell.js';
import { tools as files } from './files.js';
import { tools as docker } from './docker.js';
import { tools as database } from './db.js';
import { tools as audit } from './audit.js';

// Набор инструментов выбирается адресом подключения, а не настройкой сервера:
// одна поднятая копия обслуживает и того, кому нужна только рабочая среда, и того,
// кому нужны только серверы, и смена набора не требует перезапуска.

export const ALL = [...service, ...env, ...run, ...workspace, ...shell, ...files, ...docker, ...database, ...audit];

export const GROUPS = ALL.reduce((acc, tool) => {
  (acc[tool.group] ||= []).push(tool.name);
  return acc;
}, {});

// service есть на любом адресе: агент, не нашедший инструмента, иначе решил бы,
// что стенд неисправен, вместо того чтобы посмотреть toolkit_info.
const ALWAYS = ['service'];

export const ALIASES = {
  all: ['env', 'run', 'jobs', 'ws', 'ssh', 'files', 'docker', 'db', 'audit'],
  local: ['env', 'run', 'jobs', 'ws'],
  remote: ['ssh', 'files', 'docker', 'db', 'audit'],
  // files_get и files_put без рабочей области бесполезны: обмен идёт через неё.
  transfer: ['ssh', 'files', 'ws'],
};

/**
 * Разбирает хвост адреса: /mcp → всё, /mcp/local+db → названные группы.
 * Порядок не важен, «db+audit» и «audit+db» — одно и то же.
 */
export function select(spec) {
  const requested = String(spec || 'all')
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .flatMap((part) => ALIASES[part] || [part]);

  const unknown = requested.filter((name) => !GROUPS[name]);
  if (unknown.length) {
    const err = new Error(`неизвестные группы: ${unknown.join(', ')}. Есть: ${Object.keys(GROUPS).join(', ')}; `
      + `псевдонимы: ${Object.keys(ALIASES).join(', ')}`);
    err.code = 'unknown_group';
    throw err;
  }

  const groups = [...new Set([...ALWAYS, ...(requested.length ? requested : ALIASES.all)])];
  const tools = ALL.filter((tool) => groups.includes(tool.group));
  return { groups, tools };
}
