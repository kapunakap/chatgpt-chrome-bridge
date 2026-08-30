#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-status}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ALIAS="${TUNNEL_ALIAS:-local-chrome}"
LABEL="${LOCAL_CHROME_LAUNCH_AGENT_LABEL:-com.kapunakap.chatgpt-chrome-bridge.local-chrome}"
PROFILE_DIR="${TUNNEL_CLIENT_PROFILE_DIR:-$HOME/.config/tunnel-client}"
PROFILE_PATH="$PROFILE_DIR/$ALIAS.yaml"
RUNTIME_API_KEY_FILE="${CONTROL_PLANE_RUNTIME_API_KEY_FILE:-$HOME/.config/chatgpt-browser-bridge/runtime-api-key}"
LAUNCH_AGENT_DIR="${LOCAL_CHROME_LAUNCH_AGENT_DIR:-$HOME/Library/LaunchAgents}"
PLIST_PATH="${LOCAL_CHROME_LAUNCH_AGENT_PLIST:-$LAUNCH_AGENT_DIR/$LABEL.plist}"
LOG_DIR="${LOCAL_CHROME_LAUNCH_AGENT_LOG_DIR:-$HOME/Library/Application Support/chatgpt-browser-bridge/launchd}"
STDOUT_LOG="$LOG_DIR/local-chrome.stdout.log"
STDERR_LOG="$LOG_DIR/local-chrome.stderr.log"
SERVICE_PATH="${LOCAL_CHROME_SERVICE_PATH:-$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"
GUI_DOMAIN="gui/$(id -u)"
SERVICE_TARGET="$GUI_DOMAIN/$LABEL"
TUNNEL_CLIENT_SHIM="$REPO_ROOT/scripts/tunnel-client-current.sh"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: bash scripts/service.sh <install|start|stop|restart|status|uninstall>

Manages the user-level launchd service that owns the Local Chrome tunnel.
The tunnel profile and runtime API key remain outside this repository.
EOF
}

require_macos() {
  [[ "$(uname -s)" == "Darwin" ]] || fail "The persistent Local Chrome service requires macOS."
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required."
}

validate_private_file() {
  local path="$1"
  local label="$2"

  [[ -f "$path" && -s "$path" ]] || fail "$label is missing or empty: $path"
  [[ "$(stat -f '%Su' "$path")" == "$(id -un)" ]] || fail "$label must be owned by the current user."
  [[ "$(stat -f '%Lp' "$path")" == "600" ]] || fail "$label permissions must be 600."
}

validate_inputs() {
  require_macos
  require_command launchctl
  require_command plutil
  require_command python3
  require_command tunnel-client
  [[ -x "$TUNNEL_CLIENT_SHIM" ]] || fail "Tunnel-client launcher not found or not executable: $TUNNEL_CLIENT_SHIM"
  "$TUNNEL_CLIENT_SHIM" --version >/dev/null
  [[ "$ALIAS" =~ ^[A-Za-z0-9._-]+$ ]] || fail "Invalid tunnel alias: $ALIAS"
  [[ "$LABEL" =~ ^[A-Za-z0-9.-]+$ ]] || fail "Invalid launch-agent label: $LABEL"
  validate_private_file "$PROFILE_PATH" "Tunnel profile"
  validate_private_file "$RUNTIME_API_KEY_FILE" "Runtime API key file"
}

service_loaded() {
  launchctl print "$SERVICE_TARGET" >/dev/null 2>&1
}

runtime_running() {
  local status_json=''

  status_json="$(tunnel-client runtimes --json status "$ALIAS" 2>/dev/null)" || return 1
  STATUS_JSON="$status_json" python3 - <<'PY'
import json
import os

try:
    value = json.loads(os.environ["STATUS_JSON"])
except (KeyError, json.JSONDecodeError):
    raise SystemExit(1)
raise SystemExit(0 if value.get("process_running") is True else 1)
PY
}

runtime_ready() {
  local status_json=''

  status_json="$("$TUNNEL_CLIENT_SHIM" runtimes --json status "$ALIAS" 2>/dev/null)" || return 1
  STATUS_JSON="$status_json" python3 - <<'PY'
import json
import os

try:
    value = json.loads(os.environ["STATUS_JSON"])
except (KeyError, json.JSONDecodeError):
    raise SystemExit(1)
ready = all(value.get(name) is True for name in ("healthy", "ready"))
raise SystemExit(0 if ready else 1)
PY
}

wait_for_runtime_stop() {
  for _ in {1..20}; do
    runtime_running || return 0
    sleep 1
  done
  fail "Tunnel runtime did not stop within 20 seconds."
}

wait_for_runtime_ready() {
  for _ in {1..30}; do
    if service_loaded && runtime_ready; then
      printf 'launch_agent_loaded=true\n'
      printf 'process_running=true\n'
      printf 'healthy=true\n'
      printf 'ready=true\n'
      return 0
    fi
    sleep 1
  done
  fail "LaunchAgent did not reach running + healthy + ready within 30 seconds."
}

stop_runtime_if_running() {
  if runtime_running; then
    tunnel-client runtimes --json stop "$ALIAS" >/dev/null
    wait_for_runtime_stop
  fi
}

render_plist() {
  local output_path="$1"
  local tunnel_client_bin="$2"

  python3 - \
    "$output_path" \
    "$LABEL" \
    "$tunnel_client_bin" \
    "$PROFILE_DIR" \
    "$ALIAS" \
    "$HOME" \
    "$SERVICE_PATH" \
    "$STDOUT_LOG" \
    "$STDERR_LOG" <<'PY'
import plistlib
import sys

(
    output_path,
    label,
    tunnel_client_bin,
    profile_dir,
    alias,
    home,
    service_path,
    stdout_log,
    stderr_log,
) = sys.argv[1:]

value = {
    "Label": label,
    "ProgramArguments": [
        tunnel_client_bin,
        "run",
        "--profile-dir",
        profile_dir,
        "--profile",
        alias,
    ],
    "RunAtLoad": True,
    "KeepAlive": True,
    "ProcessType": "Background",
    "ThrottleInterval": 10,
    "Umask": 0o077,
    "WorkingDirectory": "/",
    "EnvironmentVariables": {
        "HOME": home,
        "PATH": service_path,
        "MCP_STDIO_SEND_INITIALIZED_NOTIFICATION": "true",
    },
    "StandardOutPath": stdout_log,
    "StandardErrorPath": stderr_log,
}

with open(output_path, "wb") as handle:
    plistlib.dump(value, handle, fmt=plistlib.FMT_XML, sort_keys=False)
PY
}

bootstrap_service() {
  launchctl enable "$SERVICE_TARGET"
  if service_loaded; then
    launchctl kickstart -k "$SERVICE_TARGET"
    return
  fi

  if ! launchctl bootstrap "$GUI_DOMAIN" "$PLIST_PATH"; then
    launchctl bootout "$SERVICE_TARGET" >/dev/null 2>&1 || true
    sleep 1
    launchctl bootstrap "$GUI_DOMAIN" "$PLIST_PATH"
  fi
}

install_service() {
  local tunnel_client_bin=''
  local service_tmp_dir=''
  local rendered_plist=''

  validate_inputs
  tunnel_client_bin="$TUNNEL_CLIENT_SHIM"
  service_tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/chatgpt-chrome-bridge-service.XXXXXX")"
  rendered_plist="$service_tmp_dir/$LABEL.plist"
  trap 'rm -f "$rendered_plist"; rmdir "$service_tmp_dir" 2>/dev/null || true' EXIT

  mkdir -p "$LAUNCH_AGENT_DIR" "$LOG_DIR"
  chmod 700 "$LOG_DIR"
  touch "$STDOUT_LOG" "$STDERR_LOG"
  chmod 600 "$STDOUT_LOG" "$STDERR_LOG"
  render_plist "$rendered_plist" "$tunnel_client_bin"
  plutil -lint "$rendered_plist" >/dev/null

  if service_loaded; then
    launchctl bootout "$SERVICE_TARGET"
    wait_for_runtime_stop
  fi
  stop_runtime_if_running

  install -m 600 "$rendered_plist" "$PLIST_PATH"
  bootstrap_service
  wait_for_runtime_ready
  rm -f "$rendered_plist"
  rmdir "$service_tmp_dir"
  trap - EXIT
  printf 'SERVICE_INSTALLED=1\n'
  printf 'SERVICE_READY=1\n'
}

start_service() {
  validate_inputs
  [[ -f "$PLIST_PATH" ]] || fail "LaunchAgent is not installed. Run: bash scripts/service.sh install"
  if service_loaded; then
    wait_for_runtime_ready
    printf 'SERVICE_STARTED=1\n'
    return
  fi
  stop_runtime_if_running
  bootstrap_service
  wait_for_runtime_ready
  printf 'SERVICE_STARTED=1\n'
}

stop_service() {
  require_macos
  require_command launchctl
  require_command tunnel-client

  if service_loaded; then
    launchctl bootout "$SERVICE_TARGET"
    wait_for_runtime_stop
  else
    stop_runtime_if_running
  fi
  printf 'launch_agent_loaded=false\n'
  printf 'SERVICE_STOPPED=1\n'
}

restart_service() {
  validate_inputs
  [[ -f "$PLIST_PATH" ]] || fail "LaunchAgent is not installed. Run: bash scripts/service.sh install"

  if service_loaded; then
    launchctl kickstart -k "$SERVICE_TARGET"
  else
    stop_runtime_if_running
    bootstrap_service
  fi
  wait_for_runtime_ready
  printf 'SERVICE_RESTARTED=1\n'
}

service_status() {
  local launch_output=''
  local state='not-loaded'
  local pid=''
  local umask_value=''
  local running=false

  require_macos
  require_command launchctl
  printf 'launch_agent_label=%s\n' "$LABEL"
  if [[ -f "$PLIST_PATH" ]]; then
    printf 'launch_agent_installed=true\n'
  else
    printf 'launch_agent_installed=false\n'
  fi

  if service_loaded; then
    launch_output="$(launchctl print "$SERVICE_TARGET")"
    state="$(printf '%s\n' "$launch_output" | sed -n 's/^[[:space:]]*state = //p' | head -n 1)"
    pid="$(printf '%s\n' "$launch_output" | sed -n 's/^[[:space:]]*pid = //p' | head -n 1)"
    umask_value="$(printf '%s\n' "$launch_output" | sed -n 's/^[[:space:]]*umask = //p' | head -n 1)"
    [[ "$state" == "running" && -n "$pid" ]] && running=true
    printf 'launch_agent_loaded=true\n'
  else
    printf 'launch_agent_loaded=false\n'
  fi

  printf 'launch_agent_state=%s\n' "$state"
  printf 'launch_agent_running=%s\n' "$running"
  [[ -n "$pid" ]] && printf 'launch_agent_pid=%s\n' "$pid"
  [[ -n "$umask_value" ]] && printf 'launch_agent_umask=%s\n' "$umask_value"
  [[ "$running" == true ]] || return 2
}

uninstall_service() {
  require_macos
  require_command launchctl
  require_command tunnel-client

  if service_loaded; then
    launchctl bootout "$SERVICE_TARGET"
    wait_for_runtime_stop
  else
    stop_runtime_if_running
  fi
  rm -f "$PLIST_PATH"
  launchctl enable "$SERVICE_TARGET"
  printf 'SERVICE_UNINSTALLED=1\n'
  printf 'Tunnel profile, runtime API key, and logs were preserved.\n'
}

case "$ACTION" in
  install)
    install_service
    ;;
  start)
    start_service
    ;;
  stop)
    stop_service
    ;;
  restart)
    restart_service
    ;;
  status)
    service_status
    ;;
  uninstall)
    uninstall_service
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    fail "Unknown service action: $ACTION"
    ;;
esac
