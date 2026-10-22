#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be configured}"

# Prisma accepts connection parameters that libpq tools such as psql and
# pg_dump do not. Remove those parameters while preserving PostgreSQL options
# (including sslmode) so the same effective connection can be checked and dumped.
url="${DATABASE_URL}"
if [[ "$url" == *\?* ]]; then
  base="${url%%\?*}"
  query="${url#*\?}"
  fragment=""
  if [[ "$query" == *#* ]]; then
    fragment="#${query#*#}"
    query="${query%%#*}"
  fi

  kept=()
  IFS='&' read -r -a params <<< "$query"
  for param in "${params[@]}"; do
    [[ -n "$param" ]] || continue
    key="${param%%=*}"
    case "$key" in
      schema|connection_limit|pool_timeout|pgbouncer|sslaccept)
        continue
        ;;
    esac
    kept+=("$param")
  done

  url="$base"
  if (( ${#kept[@]} > 0 )); then
    local_ifs="$IFS"
    IFS='&'
    joined="${kept[*]}"
    IFS="$local_ifs"
    url+="?$joined"
  fi
  url+="$fragment"
fi

printf '%s\n' "$url"
