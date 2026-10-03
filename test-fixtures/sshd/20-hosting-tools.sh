#!/bin/bash
# Консольные mysql и psql на мишени — «как на хостинге»: для db с via: exec, где запросы
# выполняет клиент на самом сервере, потому что SSH-проброс закрыт.
# Имена пакетов зависят от версии Alpine в образе, поэтому берётся первый доступный.
apk add --no-cache mariadb-client mariadb-connector-c >/dev/null 2>&1 || true
for pkg in postgresql17-client postgresql16-client postgresql-client; do
  apk add --no-cache "$pkg" >/dev/null 2>&1 && break
done
