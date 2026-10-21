#!/usr/bin/env bash
# Applies supabase/migrations/*.sql to the internal database, once each, in
# name order, each in its own transaction. Applied versions are recorded in
# supabase_migrations.schema_migrations, the table the Supabase CLI uses, so
# `supabase migration list --db-url ...` reads the same history.
set -euo pipefail

export PGCONNECT_TIMEOUT=10
until pg_isready -q; do
  echo "migrate: waiting for the database"
  sleep 2
done

psql -v ON_ERROR_STOP=1 -q <<'SQL'
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text
);
SQL

applied=0
for file in $(ls /migrations/*.sql | sort); do
  base="$(basename "$file")"
  version="${base%%_*}"
  name="${base#*_}"
  name="${name%.sql}"
  if [[ ! "$version" =~ ^[0-9]{14}$ ]]; then
    echo "migrate: skipping $base (the name must start with a 14-digit timestamp)"
    continue
  fi
  exists="$(psql -tAq -c "select 1 from supabase_migrations.schema_migrations where version = '$version'")"
  if [[ "$exists" == "1" ]]; then
    continue
  fi
  echo "migrate: applying $base"
  psql -v ON_ERROR_STOP=1 -q --single-transaction -f "$file"
  psql -v ON_ERROR_STOP=1 -q -c "insert into supabase_migrations.schema_migrations (version, name) values ('$version', '$name')"
  applied=$((applied + 1))
done
echo "migrate: done ($applied applied)"
