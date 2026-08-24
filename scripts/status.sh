#!/usr/bin/env bash
set -euo pipefail

ALIAS="${TUNNEL_ALIAS:-chatgpt-browser}"
BROWSERJACK_SHIM="$HOME/Library/Application Support/browserjack/bin/browserjack"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ -x "$BROWSERJACK_SHIM" ]] || fail "BrowserJack shim not found."
command -v tunnel-client >/dev/null 2>&1 || fail "tunnel-client not found."

printf '== BrowserJack status ==\n'
"$BROWSERJACK_SHIM" status --json

printf '\n== BrowserJack live doctor ==\n'
"$BROWSERJACK_SHIM" doctor --live --json

printf '\n== Tunnel runtime status (%s) ==\n' "$ALIAS"
status_json="$(tunnel-client runtimes --json status "$ALIAS")"
printf '%s\n' "$status_json"

STATUS_JSON="$status_json" node <<'NODE'
const s = JSON.parse(process.env.STATUS_JSON);
const checks = {
  process_running: s.process_running === true,
  healthy: s.healthy === true,
  ready: s.ready === true,
};
for (const [name, ok] of Object.entries(checks)) {
  console.log(`${name}=${ok ? 'true' : 'false'}`);
}
if (!Object.values(checks).every(Boolean)) process.exit(2);
NODE

printf '\nBRIDGE_LOCAL_READY=1\n'
