#!/usr/bin/env bash
set -euo pipefail

ALIAS="${TUNNEL_ALIAS:-local-chrome}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BROWSERJACK_SHIM="${BROWSERJACK_COMMAND:-$REPO_ROOT/scripts/browserjack-current.sh}"
TUNNEL_CLIENT_SHIM="$REPO_ROOT/scripts/tunnel-client-current.sh"
SERVICE_LABEL="${LOCAL_CHROME_LAUNCH_AGENT_LABEL:-com.kapunakap.chatgpt-chrome-bridge.local-chrome}"
SERVICE_PLIST="${LOCAL_CHROME_LAUNCH_AGENT_PLIST:-$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist}"
SERVICE_TARGET="gui/$(id -u)/$SERVICE_LABEL"
launch_agent_running=false
browser_ready=false

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ -x "$BROWSERJACK_SHIM" ]] || fail "BrowserJack launcher not found or not executable: $BROWSERJACK_SHIM"
[[ -x "$TUNNEL_CLIENT_SHIM" ]] || fail "Tunnel-client launcher not found or not executable: $TUNNEL_CLIENT_SHIM"

printf '== tunnel-client compatibility ==\n'
printf 'tunnel_client_expected_version=%s\n' "$("$TUNNEL_CLIENT_SHIM" --expected-version)"
printf 'tunnel_client_version=%s\n' "$("$TUNNEL_CLIENT_SHIM" --version | awk '{print $1}')"
printf 'stdio_send_initialized_notification=true\n'

printf '\n== Persistent service ==\n'
if [[ -f "$SERVICE_PLIST" ]]; then
  printf 'launch_agent_installed=true\n'
  launch_output="$(launchctl print "$SERVICE_TARGET" 2>/dev/null)" || fail "LaunchAgent is installed but not loaded. Run: bash scripts/service.sh start"
  [[ "$launch_output" == *"$TUNNEL_CLIENT_SHIM"* ]] || fail "LaunchAgent is not using the checked-in tunnel-client launcher. Run: bash scripts/service.sh install"
  launch_compat="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:MCP_STDIO_SEND_INITIALIZED_NOTIFICATION' "$SERVICE_PLIST" 2>/dev/null || true)"
  [[ "$launch_compat" == "true" ]] || fail "LaunchAgent is missing the stdio initialized-notification compatibility mode. Run: bash scripts/service.sh install"
  launch_state="$(printf '%s\n' "$launch_output" | sed -n 's/^[[:space:]]*state = //p' | head -n 1)"
  launch_pid="$(printf '%s\n' "$launch_output" | sed -n 's/^[[:space:]]*pid = //p' | head -n 1)"
  launch_umask="$(printf '%s\n' "$launch_output" | sed -n 's/^[[:space:]]*umask = //p' | head -n 1)"
  [[ "$launch_state" == "running" && -n "$launch_pid" ]] || fail "LaunchAgent is loaded but not running."
  launch_agent_running=true
  printf 'launch_agent_loaded=true\n'
  printf 'launch_agent_running=true\n'
  printf 'launch_agent_pid=%s\n' "$launch_pid"
  [[ -n "$launch_umask" ]] && printf 'launch_agent_umask=%s\n' "$launch_umask"
else
  printf 'launch_agent_installed=false\n'
  printf 'launch_agent_loaded=false\n'
  printf 'launch_agent_running=false\n'
  printf 'WARNING: Local Chrome is not persistent. Run: bash scripts/service.sh install\n'
fi

printf '\n== BrowserJack status ==\n'
set +e
"$BROWSERJACK_SHIM" status --json
browser_status_rc=$?
set -e
printf 'browserjack_status_exit=%s\n' "$browser_status_rc"

printf '\n== BrowserJack live doctor ==\n'
if "$BROWSERJACK_SHIM" doctor --live --json; then
  browser_ready=true
  printf 'browser_ready=true\n'
else
  printf 'browser_ready=false\n'
fi

printf '\n== Tunnel runtime status (%s) ==\n' "$ALIAS"
status_json="$("$TUNNEL_CLIENT_SHIM" runtimes --json status "$ALIAS")"
printf '%s\n' "$status_json"

STATUS_JSON="$status_json" LAUNCH_AGENT_RUNNING="$launch_agent_running" BROWSER_READY="$browser_ready" node <<'NODE'
const s = JSON.parse(process.env.STATUS_JSON);
const launchAgentOwnsProcess = process.env.LAUNCH_AGENT_RUNNING === "true";
const checks = {
  process_running: s.process_running === true || launchAgentOwnsProcess,
  healthy: s.healthy === true,
  ready: s.ready === true,
  browser_ready: process.env.BROWSER_READY === "true",
};
console.log(`tunnel_process_running=${s.process_running === true ? 'true' : 'false'}`);
console.log(`launch_agent_owns_process=${launchAgentOwnsProcess ? 'true' : 'false'}`);
for (const [name, ok] of Object.entries(checks)) {
  console.log(`${name}=${ok ? 'true' : 'false'}`);
}
if (!Object.values(checks).every(Boolean)) process.exit(2);
NODE

printf '\nBRIDGE_LOCAL_READY=1\n'
