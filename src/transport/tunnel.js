import net from 'node:net';
import { connect, forwardOut, forwardOutSocket } from './ssh.js';

// База на сервере обычно слушает только 127.0.0.1 — и правильно делает. Поэтому
// подключение к ней идёт через SSH: здесь поднимается локальный порт, каждое
// соединение с которым уезжает на удалённый хост по уже открытому SSH-каналу.
// Локальный порт, а не голый поток, потому что им пользуются и драйверы, и
// pg_dump с mysqldump, которым нужен именно адрес.
//
// Канал ведёт либо на адрес и порт, либо на Unix-сокет базы (config.socket): пользователь,
// заведённый на localhost, по TCP с 127.0.0.1 не войдёт, а через сокет — войдёт.

export async function open(resolved, { approveHostKey } = {}) {
  const socket = resolved.config.socket || null;
  const target = { address: resolved.config.address || '127.0.0.1', port: resolved.port };

  if (!resolved.host) {
    // Прямой доступ: адрес виден из контейнера, туннель не нужен.
    return { host: target.address, port: target.port, direct: true, async close() {} };
  }

  const client = await connect(resolved.host, { approveHostKey });
  const where = socket || `${target.address}:${target.port}`;
  const channel = () => (socket ? forwardOutSocket(client, socket) : forwardOut(client, target.address, target.port));

  // Пробный проброс до того, как за порт возьмётся драйвер: иначе запрет на стороне
  // sshd (AllowTcpForwarding no) выглядит как «соединение неожиданно закрыто».
  try {
    const probe = await channel();
    probe.end();
  } catch (err) {
    const reason = !/administratively prohibited/i.test(err.message)
      ? `хост «${resolved.host.alias}» не открыл канал до ${where}: ${err.message}`
      : socket
        ? `хост «${resolved.host.alias}» запрещает проброс сокетов — в sshd_config стоит AllowStreamLocalForwarding no`
        : `хост «${resolved.host.alias}» запрещает проброс портов — в sshd_config стоит AllowTcpForwarding no`;
    throw new Error(`${reason}. Без проброса до базы за SSH не добраться — откройте цель с db.via: "exec"`);
  }

  const sockets = new Set();

  const server = net.createServer((local) => {
    sockets.add(local);
    local.on('close', () => sockets.delete(local));
    local.on('error', () => local.destroy());

    channel()
      .then((stream) => {
        stream.on('error', () => local.destroy());
        local.pipe(stream).pipe(local);
      })
      .catch(() => local.destroy());
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    host: '127.0.0.1',
    port: server.address().port,
    direct: false,
    via: `${resolved.host.alias} → ${where}`,
    async close() {
      for (const local of sockets) local.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
