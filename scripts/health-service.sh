#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-status}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAIN_LABEL="${LOCAL_CHROME_LAUNCH_AGENT_LABEL:-com.kapunakap.chatgpt-chrome-bridge.local-chrome}"
LABEL="${LOCAL_CHROME_HEALTH_LAUNCH_AGENT_LABEL:-$MAIN_LABEL.health}"
LAUNCH_AGENT_DIR="${LOCAL_CHROME_LAUNCH_AGENT_DIR:-$HOME/Library/LaunchAgents}"
PLIST_PATH="${LOCAL_CHROME_HEALTH_LAUNCH_AGENT_PLIST:-$LAUNCH_AGENT_DIR/$LABEL.plist}"
LOG_DIR="${LOCAL_CHROME_LAUNCH_AGENT_LOG_DIR:-$HOME/Library/Application Support/chatgpt-browser-bridge/launchd}"
STDOUT_LOG="$LOG_DIR/local-chrome-health.stdout.log"
STDERR_LOG="$LOG_DIR/local-chrome-health.stderr.log"
SERVICE_PATH="${LOCAL_CHROME_SERVICE_PATH:-$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"
GUI_DOMAIN="gui/$(id -u)"
SERVICE_TARGET="$GUI_DOMAIN/$LABEL"
HEALTH_SCRIPT="$REPO_ROOT/scripts/browserjack-health.mjs"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_macos() {
  [[ "$(uname -s)" == "Darwin" ]] || fail "The Local Chrome health watcher requires macOS."
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required."
}

service_loaded() {
  launchctl print "$SERVICE_TARGET" >/dev/null 2>&1
}

render_plist() {
  local output_path="$1"
  local node_bin="$2"

  python3 - \
    "$output_path" \
    "$LABEL" \
    "$node_bin" \
    "$HEALTH_SCRIPT" \
    "$HOME" \
    "$SERVICE_PATH" \
    "$STDOUT_LOG" \
    "$STDERR_LOG" \
    "${TUNNEL_ALIAS:-local-chrome}" \
    "$MAIN_LABEL" <<'PY'
import plistlib
import sys

(
    output_path,
    label,
    node_bin,
    health_script,
    home,
    service_path,
    stdout_log,
    stderr_log,
    alias,
    main_label,
) = sys.argv[1:]

value = {
    "Label": label,
    "ProgramArguments": [node_bin, health_script, "watch-once"],
    "RunAtLoad": True,
    "KeepAlive": False,
    "StartInterval": 30,
    "ProcessType": "Background",
    "ThrottleInterval": 30,
    "Umask": 0o077,
    "WorkingDirectory": "/",
    "EnvironmentVariables": {
        "HOME": home,
        "PATH": service_path,
        "TUNNEL_ALIAS": alias,
        "LOCAL_CHROME_LAUNCH_AGENT_LABEL": main_label,
    },
    "StandardOutPath": stdout_log,
    "StandardErrorPath": stderr_log,
}

with open(output_path, "wb") as handle:
    plistlib.dump(value, handle, fmt=plistlib.FMT_XML, sort_keys=False)
PY
}

install_service() {
  local node_bin=''
  local tmp_dir=''
  local rendered=''

  require_macos
  require_command launchctl
  require_command plutil
  require_command python3
  require_command node
  [[ -f "$HEALTH_SCRIPT" ]] || fail "Health watcher not found: $HEALTH_SCRIPT"
  node_bin="$(command -v node)"

  mkdir -p "$LAUNCH_AGENT_DIR" "$LOG_DIR"
  chmod 700 "$LOG_DIR"
  touch "$STDOUT_LOG" "$STDERR_LOG"
  chmod 600 "$STDOUT_LOG" "$STDERR_LOG"

  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/chatgpt-chrome-health-service.XXXXXX")"
  rendered="$tmp_dir/$LABEL.plist"
  trap 'rm -f "$rendered"; rmdir "$tmp_dir" 2>/dev/null || true' EXIT
  render_plist "$rendered" "$node_bin"
  plutil -lint "$rendered" >/dev/null

  if service_loaded; then
    launchctl bootout "$SERVICE_TARGET"
  fi
  install -m 600 "$rendered" "$PLIST_PATH"
  launchctl enable "$SERVICE_TARGET"
  launchctl bootstrap "$GUI_DOMAIN" "$PLIST_PATH"
  rm -f "$rendered"
  rmdir "$tmp_dir"
  trap - EXIT
  printf 'HEALTH_WATCH_INSTALLED=1\n'
}

start_service() {
  require_macos
  require_command launchctl
  [[ -f "$PLIST_PATH" ]] || fail "Health watcher is not installed. Run: bash scripts/health-service.sh install"
  if service_loaded; then
    launchctl kickstart "$SERVICE_TARGET" >/dev/null 2>&1 || true
  else
    launchctl enable "$SERVICE_TARGET"
    launchctl bootstrap "$GUI_DOMAIN" "$PLIST_PATH"
  fi
  printf 'HEALTH_WATCH_STARTED=1\n'
}

stop_service() {
  require_macos
  require_command launchctl
  if service_loaded; then
    launchctl bootout "$SERVICE_TARGET"
  fi
  printf 'HEALTH_WATCH_STOPPED=1\n'
}

status_service() {
  require_macos
  require_command launchctl
  printf 'health_watch_label=%s\n' "$LABEL"
  if [[ -f "$PLIST_PATH" ]]; then
    printf 'health_watch_installed=true\n'
  else
    printf 'health_watch_installed=false\n'
  fi
  if service_loaded; then
    printf 'health_watch_loaded=true\n'
    return 0
  fi
  printf 'health_watch_loaded=false\n'
  return 2
}

uninstall_service() {
  require_macos
  require_command launchctl
  if service_loaded; then
    launchctl bootout "$SERVICE_TARGET"
  fi
  rm -f "$PLIST_PATH"
  launchctl enable "$SERVICE_TARGET"
  printf 'HEALTH_WATCH_UNINSTALLED=1\n'
}

case "$ACTION" in
  install) install_service ;;
  start) start_service ;;
  stop) stop_service ;;
  status) status_service ;;
  uninstall) uninstall_service ;;
  *) fail "Unknown health-service action: $ACTION" ;;
esac
