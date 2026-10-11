#!/bin/bash
# Образ linuxserver/openssh-server закрывает проброс портов по умолчанию.
# Стенду он нужен: база за SSH достижима только через туннель.
sed -i 's/^AllowTcpForwarding no/AllowTcpForwarding yes/' /config/sshd/sshd_config
# Проброс Unix-сокета (db.socket в режиме tunnel) — тоже явно, не полагаясь на умолчание образа.
if grep -q '^#\?AllowStreamLocalForwarding' /config/sshd/sshd_config; then
  sed -i 's/^#\?AllowStreamLocalForwarding.*/AllowStreamLocalForwarding yes/' /config/sshd/sshd_config
else
  echo 'AllowStreamLocalForwarding yes' >> /config/sshd/sshd_config
fi
