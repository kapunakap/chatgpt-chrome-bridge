#!/usr/bin/env bash
set -euo pipefail

ALIAS="${TUNNEL_ALIAS:-chatgpt-browser}"
BROWSERJACK_SHIM="$HOME/Library/Application Support/browserjack/bin/browserjack"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ -n "${CONTROL_PLANE_TUNNEL_ID:-}" ]] || fail "Set CONTROL_PLANE_TUNNEL_ID first."
[[ "$CONTROL_PLANE_TUNNEL_ID" =~ ^tunnel_[a-z0-9]{32}$ ]] || fail "CONTROL_PLANE_TUNNEL_ID does not look like a tunnel_... id."
[[ -n "${CONTROL_PLANE_API_KEY:-}" ]] || fail "Set CONTROL_PLANE_API_KEY to a runtime API key with Tunnels Read + Use."
command -v tunnel-client >/dev/null 2>&1 || fail "tunnel-client is not installed; run bash scripts/bootstrap-local.sh."
[[ -x "$BROWSERJACK_SHIM" ]] || fail "BrowserJack shim not found; run bash scripts/bootstrap-local.sh."

printf '== Revalidating BrowserJack browser handshake ==\n'
"$BROWSERJACK_SHIM" doctor --live --json

# tunnel-client parses this as argv for a local stdio MCP command. Quoting keeps
# the Application Support path as one executable token.
MCP_COMMAND="\"${BROWSERJACK_SHIM}\" run"

printf '\n== Connecting managed tunnel runtime (%s) ==\n' "$ALIAS"
set +e
connect_output="$({
  tunnel-client runtimes --json connect \
    --alias "$ALIAS" \
    --tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \
    --runtime-api-key env:CONTROL_PLANE_API_KEY \
    --mcp-command "$MCP_COMMAND"
} 2>&1)"
connect_rc=$?
set -e
printf '%s\n' "$connect_output"
[[ "$connect_rc" -eq 0 ]] || fail "tunnel-client runtimes connect failed (exit $connect_rc)."

printf '\n== Waiting for running + healthy + ready ==\n'
status_json=''
for _ in {1..30}; do
  set +e
  status_json="$(tunnel-client runtimes --json status "$ALIAS" 2>&1)"
  status_rc=$?
  set -e

  if [[ "$status_rc" -eq 0 ]] && STATUS_JSON="$status_json" node <<'NODE'
const s = JSON.parse(process.env.STATUS_JSON);
process.exit(s.process_running === true && s.healthy === true && s.ready === true ? 0 : 1);
NODE
  then
    printf '%s\n' "$status_json"
    printf '\nTUNNEL_READY=1\n'
    exit 0
  fi
  sleep 1
done

printf '%s\n' "$status_json"
fail "Managed runtime did not reach process_running=true, healthy=true, ready=true."
