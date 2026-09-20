#!/usr/bin/env bash
set -euo pipefail

until pg_isready -h primary -U routepg -d demo >/dev/null 2>&1; do
  sleep 1
done

rm -rf /var/lib/postgresql/data/*
export PGPASSWORD=routepg
pg_basebackup \
  -h primary \
  -U routepg \
  -D /var/lib/postgresql/data \
  -Fp -Xs -P -R

chown -R postgres:postgres /var/lib/postgresql/data
chmod 700 /var/lib/postgresql/data

exec gosu postgres postgres -c hot_standby=on -c listen_addresses='*'
