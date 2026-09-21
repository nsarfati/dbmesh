#!/usr/bin/env bash

# Physical replication needs its own HBA rule; "all" only matches databases.
# Restrict this demo rule to the configured role on directly connected networks.
if ! grep -q '^host replication dbmesh samenet scram-sha-256$' "$PGDATA/pg_hba.conf"; then
  printf '\nhost replication dbmesh samenet scram-sha-256\n' >> "$PGDATA/pg_hba.conf"
fi
