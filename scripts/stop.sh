#!/usr/bin/env bash
set -euo pipefail

ALIAS="${TUNNEL_ALIAS:-chatgpt-browser}"

command -v tunnel-client >/dev/null 2>&1 || {
  printf 'ERROR: tunnel-client not found.\n' >&2
  exit 1
}

tunnel-client runtimes --json stop "$ALIAS"
