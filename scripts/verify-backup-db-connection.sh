#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be configured}"
pg_url="$(bash "$(dirname "${BASH_SOURCE[0]}")/normalize-backup-db-url.sh")"

tls_status="$(docker run --rm \
  -e DATABASE_URL="$pg_url" \
  postgres:18 \
  psql --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
    "$pg_url" --command='SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()')"
if [[ "$tls_status" != "t" ]]; then
  echo "::error::Backup database connection is not using TLS; refusing to export data." >&2
  exit 1
fi

server_version_num="$(docker run --rm \
  -e DATABASE_URL="$pg_url" \
  postgres:18 \
  psql --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
    "$pg_url" --command='SHOW server_version_num')"
if [[ ! "$server_version_num" =~ ^[0-9]+$ ]]; then
  echo "::error::Could not determine PostgreSQL server version." >&2
  exit 1
fi

pg_major="$((server_version_num / 10000))"
if (( pg_major < 14 )); then
  echo "::error::PostgreSQL $pg_major is below the supported backup-client floor (14)." >&2
  exit 1
fi

printf '%s\n' "$pg_major"
