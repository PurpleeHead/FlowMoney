#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${MOCK_DOCKER_FAIL:-0}" == "1" ]]; then
  echo "mock database connection failure" >&2
  exit 42
fi
command_text=''
for arg in "$@"; do
  case "$arg" in
    --command=*) command_text="${arg#--command=}" ;;
  esac
done
case "$command_text" in
  'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()')
    printf '%s\n' "${MOCK_TLS:-t}"
    ;;
  'SHOW server_version_num')
    printf '%s\n' "${MOCK_SERVER_VERSION_NUM:-160004}"
    ;;
  *)
    echo "Unexpected mocked docker command: $command_text" >&2
    exit 97
    ;;
esac
MOCK
chmod +x "$tmp/docker"

run_check() {
  PATH="$tmp:$PATH" DATABASE_URL='postgresql://example.invalid/db?sslmode=require' "$@"
}

actual="$(run_check bash "$repo_root/scripts/verify-backup-db-connection.sh")"
[[ "$actual" == "16" ]] || { echo "Expected PostgreSQL major 16, got '$actual'" >&2; exit 1; }
echo "PASS: TLS connection and PostgreSQL 16 are accepted"

if output="$(MOCK_TLS=f run_check bash "$repo_root/scripts/verify-backup-db-connection.sh" 2>&1)"; then
  echo "Expected a non-TLS connection to be rejected" >&2
  exit 1
fi
[[ "$output" == *"not using TLS"* ]] || { echo "Unexpected TLS rejection: $output" >&2; exit 1; }
echo "PASS: non-TLS connection is rejected"

if output="$(MOCK_SERVER_VERSION_NUM=130012 run_check bash "$repo_root/scripts/verify-backup-db-connection.sh" 2>&1)"; then
  echo "Expected PostgreSQL 13 to be rejected" >&2
  exit 1
fi
[[ "$output" == *"below the supported backup-client floor"* ]] || { echo "Unexpected old-version rejection: $output" >&2; exit 1; }
echo "PASS: unsupported PostgreSQL version is rejected"

if output="$(MOCK_SERVER_VERSION_NUM=unknown run_check bash "$repo_root/scripts/verify-backup-db-connection.sh" 2>&1)"; then
  echo "Expected an invalid server version to be rejected" >&2
  exit 1
fi
[[ "$output" == *"Could not determine PostgreSQL server version"* ]] || { echo "Unexpected malformed-version rejection: $output" >&2; exit 1; }
echo "PASS: malformed PostgreSQL version is rejected"

if output="$(env -u DATABASE_URL PATH="$tmp:$PATH" bash "$repo_root/scripts/verify-backup-db-connection.sh" 2>&1)"; then
  echo "Expected a missing DATABASE_URL to be rejected" >&2
  exit 1
fi
[[ "$output" == *"DATABASE_URL must be configured"* ]] || { echo "Unexpected missing-URL rejection: $output" >&2; exit 1; }
echo "PASS: missing database URL is rejected"

if output="$(MOCK_DOCKER_FAIL=1 run_check bash "$repo_root/scripts/verify-backup-db-connection.sh" 2>&1)"; then
  echo "Expected a failed database connection probe to be rejected" >&2
  exit 1
fi
[[ "$output" == *"mock database connection failure"* ]] || { echo "Unexpected database-probe failure: $output" >&2; exit 1; }
echo "PASS: database connection failures stop the backup gate"
