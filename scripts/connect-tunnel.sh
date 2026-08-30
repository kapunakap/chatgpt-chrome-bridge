#!/usr/bin/env bash
set -euo pipefail

ALIAS="${TUNNEL_ALIAS:-local-chrome}"
TUNNEL_ID="${CONTROL_PLANE_TUNNEL_ID:-}"
RUNTIME_API_KEY_FILE="${CONTROL_PLANE_RUNTIME_API_KEY_FILE:-$HOME/.config/chatgpt-browser-bridge/runtime-api-key}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BROWSERJACK_SHIM="${BROWSERJACK_COMMAND:-$REPO_ROOT/scripts/browserjack-current.sh}"
TUNNEL_CLIENT_SHIM="$REPO_ROOT/scripts/tunnel-client-current.sh"
SERVICE_LABEL="${LOCAL_CHROME_LAUNCH_AGENT_LABEL:-com.kapunakap.chatgpt-chrome-bridge.local-chrome}"
SERVICE_PLIST="${LOCAL_CHROME_LAUNCH_AGENT_PLIST:-$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist}"
SERVICE_TARGET="gui/$(id -u)/$SERVICE_LABEL"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

if [[ -f "$SERVICE_PLIST" ]] || launchctl print "$SERVICE_TARGET" >/dev/null 2>&1; then
  fail "Persistent Local Chrome service owns this tunnel. Use: bash scripts/service.sh start|restart|status"
fi

[[ -n "$TUNNEL_ID" ]] || fail "Set CONTROL_PLANE_TUNNEL_ID to your own tunnel_... ID."
[[ "$TUNNEL_ID" =~ ^tunnel_[a-z0-9]{32}$ ]] || fail "Tunnel ID does not look like a tunnel_... id."
[[ -f "$RUNTIME_API_KEY_FILE" && -s "$RUNTIME_API_KEY_FILE" ]] || fail "Runtime API key file is missing or empty: $RUNTIME_API_KEY_FILE"
[[ "$(stat -f '%Su' "$RUNTIME_API_KEY_FILE")" == "$(id -un)" ]] || fail "Runtime API key file must be owned by the current user."
[[ "$(stat -f '%Lp' "$RUNTIME_API_KEY_FILE")" == "600" ]] || fail "Runtime API key file permissions must be 600."
[[ -x "$TUNNEL_CLIENT_SHIM" ]] || fail "Tunnel-client launcher not found or not executable: $TUNNEL_CLIENT_SHIM"
"$TUNNEL_CLIENT_SHIM" --version >/dev/null
[[ -x "$BROWSERJACK_SHIM" ]] || fail "BrowserJack launcher not found or not executable: $BROWSERJACK_SHIM"

printf '== Revalidating BrowserJack browser handshake ==\n'
"$BROWSERJACK_SHIM" doctor --live --json

# tunnel-client parses this as argv for a local stdio MCP command. Quoting keeps
# the Application Support path as one executable token.
MCP_COMMAND="\"${BROWSERJACK_SHIM}\" run"

printf '\n== Connecting managed tunnel runtime (%s) ==\n' "$ALIAS"
set +e
connect_output="$({
  "$TUNNEL_CLIENT_SHIM" runtimes --json connect \
    --alias "$ALIAS" \
    --tunnel-id "$TUNNEL_ID" \
    --runtime-api-key "file:$RUNTIME_API_KEY_FILE" \
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
  status_json="$("$TUNNEL_CLIENT_SHIM" runtimes --json status "$ALIAS" 2>&1)"
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
