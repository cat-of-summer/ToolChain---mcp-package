import { connect, exec, quote } from './ssh.js';
import { cfg } from '../config.js';

// docker вызывается своим же CLI на сервере по SSH: ни сокета наружу, ни второго
// набора кредов. Контейнер по умолчанию — docker.container цели, поэтому агенту
// хватает имени подключения — «перезапусти shop-queue».

function prefix(resolved) {
  return resolved.config.sudo ? 'sudo docker' : 'docker';
}

export function container(resolved, override) {
  const name = override || resolved.config.container;
  if (!name) {
    throw new Error(`у «${resolved.alias}» не задан docker.container — передайте container явно`);
  }
  return name;
}

export async function run(resolved, argv, { approveHostKey, timeoutMs } = {}) {
  const client = await connect(resolved.host, { approveHostKey });
  const command = `${prefix(resolved)} ${argv.join(' ')}`;
  return exec(client, command, { cwd: resolved.config.workdir, timeoutMs: timeoutMs || cfg.execTimeoutMs });
}

export async function compose(resolved, argv, { approveHostKey, timeoutMs } = {}) {
  const file = resolved.config.composeFile;
  const head = file ? `${prefix(resolved)} compose -f ${quote(file)}` : `${prefix(resolved)} compose`;
  const client = await connect(resolved.host, { approveHostKey });
  return exec(client, `${head} ${argv.join(' ')}`, {
    cwd: resolved.config.workdir,
    timeoutMs: timeoutMs || cfg.execTimeoutMs,
  });
}

export { quote };
