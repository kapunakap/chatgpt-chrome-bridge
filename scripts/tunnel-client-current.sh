#!/usr/bin/env bash
set -euo pipefail

EXPECTED_TUNNEL_CLIENT_VERSION="0.0.13"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

if [[ "${1:-}" == "--expected-version" ]]; then
  printf '%s\n' "$EXPECTED_TUNNEL_CLIENT_VERSION"
  exit 0
fi

command -v tunnel-client >/dev/null 2>&1 || fail "tunnel-client is not installed; run bash scripts/bootstrap-local.sh."
actual_version_full="$(tunnel-client --version | awk '{print $1}')"
actual_version="${actual_version_full%%+*}"
[[ "$actual_version" == "$EXPECTED_TUNNEL_CLIENT_VERSION" ]] || {
  fail "Unsupported tunnel-client version: $actual_version_full (expected $EXPECTED_TUNNEL_CLIENT_VERSION). Run bash scripts/bootstrap-local.sh."
}

# ChatGPT can omit notifications/initialized between independent hosted stdio
# commands. tunnel-client 0.0.13 completes that lifecycle and suppresses a later
# duplicate only when this compatibility mode is explicitly enabled.
export MCP_STDIO_SEND_INITIALIZED_NOTIFICATION=true

exec tunnel-client "$@"
