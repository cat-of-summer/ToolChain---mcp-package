#!/usr/bin/with-contenv bash
# Сокеты баз на мишени, как у базы, что слушает localhost: socat отдаёт их в TCP баз за сервером.
# Права на localhost так не проверить — сокет проксируется в TCP, — но путь db.socket от стенда
# до базы, туннелем и клиентом на сервере, проходит целиком.
mkdir -p /run/mysqld /var/run/postgresql
socat UNIX-LISTEN:/run/mysqld/mysqld.sock,fork,mode=777,unlink-early TCP:mysql_test:3306 &
exec socat UNIX-LISTEN:/var/run/postgresql/.s.PGSQL.5432,fork,mode=777,unlink-early TCP:postgres_test:5432
