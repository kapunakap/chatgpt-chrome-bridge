#!/usr/bin/env bash
set -euo pipefail

ALIAS="${TUNNEL_ALIAS:-local-chrome}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BROWSERJACK_SHIM="${BROWSERJACK_COMMAND:-$REPO_ROOT/scripts/browserjack-discovery-compat.mjs}"
HEALTH_PROBE="$REPO_ROOT/scripts/browserjack-health.mjs"
TUNNEL_CLIENT_SHIM="$REPO_ROOT/scripts/tunnel-client-current.sh"
SERVICE_LABEL="${LOCAL_CHROME_LAUNCH_AGENT_LABEL:-com.kapunakap.chatgpt-chrome-bridge.local-chrome}"
SERVICE_PLIST="${LOCAL_CHROME_LAUNCH_AGENT_PLIST:-$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist}"
SERVICE_TARGET="gui/$(id -u)/$SERVICE_LABEL"
HEALTH_LABEL="${LOCAL_CHROME_HEALTH_LAUNCH_AGENT_LABEL:-$SERVICE_LABEL.health}"
HEALTH_PLIST="${LOCAL_CHROME_HEALTH_LAUNCH_AGENT_PLIST:-$HOME/Library/LaunchAgents/$HEALTH_LABEL.plist}"
HEALTH_TARGET="gui/$(id -u)/$HEALTH_LABEL"
launch_agent_running=false
health_watch_ready=true
browser_ready=false
chrome_discovered=false
user_binding_ready=false
tabs_api_ready=false

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ -x "$BROWSERJACK_SHIM" ]] || fail "BrowserJack launcher not found or not executable: $BROWSERJACK_SHIM"
[[ -x "$TUNNEL_CLIENT_SHIM" ]] || fail "Tunnel-client launcher not found or not executable: $TUNNEL_CLIENT_SHIM"
[[ -f "$HEALTH_PROBE" ]] || fail "BrowserJack health probe not found: $HEALTH_PROBE"

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
  kill -0 "$launch_pid" 2>/dev/null || fail "LaunchAgent PID is not alive."
  launch_agent_running=true
  printf 'launch_agent_loaded=true\n'
  printf 'launch_agent_running=true\n'
  printf 'launch_agent_pid_alive=true\n'
  printf 'launch_agent_pid=%s\n' "$launch_pid"
  [[ -n "$launch_umask" ]] && printf 'launch_agent_umask=%s\n' "$launch_umask"

  health_watch_ready=false
  if [[ -f "$HEALTH_PLIST" ]]; then
    printf 'health_watch_installed=true\n'
    if launchctl print "$HEALTH_TARGET" >/dev/null 2>&1; then
      health_watch_ready=true
      printf 'health_watch_loaded=true\n'
    else
      printf 'health_watch_loaded=false\n'
    fi
  else
    printf 'health_watch_installed=false\n'
    printf 'health_watch_loaded=false\n'
  fi
else
  printf 'launch_agent_installed=false\n'
  printf 'launch_agent_loaded=false\n'
  printf 'launch_agent_running=false\n'
  printf 'launch_agent_pid_alive=false\n'
  printf 'health_watch_installed=false\n'
  printf 'health_watch_loaded=false\n'
  printf 'WARNING: Local Chrome is not persistent. Run: bash scripts/service.sh install\n'
fi
printf 'health_watch_ready=%s\n' "$health_watch_ready"

printf '\n== BrowserJack status ==\n'
set +e
"$BROWSERJACK_SHIM" status --json
browser_status_rc=$?
set -e
printf 'browserjack_status_exit=%s\n' "$browser_status_rc"

printf '\n== BrowserJack live doctor (compatibility only) ==\n'
set +e
"$BROWSERJACK_SHIM" doctor --live --json
doctor_rc=$?
set -e
printf 'browserjack_live_doctor_exit=%s\n' "$doctor_rc"

printf '\n== User-scoped BrowserJack readiness ==\n'
set +e
probe_json="$(node "$HEALTH_PROBE" probe 2>&1)"
probe_rc=$?
set -e
printf '%s\n' "$probe_json"
printf 'browserjack_user_probe_exit=%s\n' "$probe_rc"
if [[ "$probe_rc" -eq 0 ]]; then
  probe_fields="$(PROBE_JSON="$probe_json" node <<'NODE'
const p = JSON.parse(process.env.PROBE_JSON);
for (const [name, key] of [
  ['chrome_discovered', 'chromeDiscovered'],
  ['user_binding_ready', 'userBindingUsable'],
  ['tabs_api_ready', 'tabsApiUsable'],
]) console.log(`${name}=${p[key] === true ? 'true' : 'false'}`);
NODE
)"
  while IFS= read -r line; do
    case "$line" in
      chrome_discovered=true) chrome_discovered=true ;;
      user_binding_ready=true) user_binding_ready=true ;;
      tabs_api_ready=true) tabs_api_ready=true ;;
    esac
  done <<<"$probe_fields"
fi
if [[ "$chrome_discovered" == true && "$user_binding_ready" == true && "$tabs_api_ready" == true ]]; then
  browser_ready=true
fi
printf 'chrome_discovered=%s\n' "$chrome_discovered"
printf 'user_binding_ready=%s\n' "$user_binding_ready"
printf 'tabs_api_ready=%s\n' "$tabs_api_ready"
printf 'browser_ready=%s\n' "$browser_ready"

printf '\n== Tunnel runtime status (%s) ==\n' "$ALIAS"
status_json="$("$TUNNEL_CLIENT_SHIM" runtimes --json status "$ALIAS")"
printf '%s\n' "$status_json"

STATUS_JSON="$status_json" \
LAUNCH_AGENT_RUNNING="$launch_agent_running" \
BROWSER_READY="$browser_ready" \
HEALTH_WATCH_READY="$health_watch_ready" node <<'NODE'
const s = JSON.parse(process.env.STATUS_JSON);
const launchAgentOwnsProcess = process.env.LAUNCH_AGENT_RUNNING === "true";
const processRunning = launchAgentOwnsProcess || s.process_running === true;
const checks = {
  process_running: processRunning,
  healthy: s.healthy === true,
  ready: s.ready === true,
  browser_ready: process.env.BROWSER_READY === "true",
  health_watch_ready: process.env.HEALTH_WATCH_READY === "true",
};
console.log(`runtime_process_owner=${launchAgentOwnsProcess ? 'launchd' : 'managed'}`);
console.log(`tunnel_managed_runtime_process_running=${s.process_running === true ? 'true' : 'false'}`);
console.log(`tunnel_process_running=${processRunning ? 'true' : 'false'}`);
console.log(`launch_agent_owns_process=${launchAgentOwnsProcess ? 'true' : 'false'}`);
for (const [name, ok] of Object.entries(checks)) {
  console.log(`${name}=${ok ? 'true' : 'false'}`);
}
if (!Object.values(checks).every(Boolean)) process.exit(2);
NODE

printf '\nBRIDGE_LOCAL_READY=1\n'
printf 'browser_operation_verified=user_binding+tabs_list\n'
printf 'NOTE: Ready means process + tunnel + Chrome discovery + user binding + tabs.list() are all usable.\n'
