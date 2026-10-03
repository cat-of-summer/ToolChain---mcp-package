import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ensureDirs } from './paths.js';
import { ensure as ensureWorkspace } from './workspace.js';
import { createServer } from './server.js';
import { start as startHttp } from './http.js';
import { closeAll } from './transport/ssh.js';
import { killAll } from './local/jobs.js';
import { watch as watchVersionsHost } from './local/reach.js';

const arg = (name, fallback) => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

async function main() {
  ensureDirs();
  ensureWorkspace();
  // Не ждём: до ответа mise работает как обычно, а проверка укладывается в секунды.
  watchVersionsHost();

  const transport = arg('transport', 'http');

  if (transport === 'stdio') {
    // В stdio адреса нет, и набор инструментов называют флагом.
    const { server } = await createServer({ spec: arg('tools', 'all') });
    await server.connect(new StdioServerTransport());
    return;
  }

  startHttp();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    closeAll();
    killAll();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(`[toolkit] не удалось запуститься: ${err.stack || err.message}`);
  process.exit(1);
});
