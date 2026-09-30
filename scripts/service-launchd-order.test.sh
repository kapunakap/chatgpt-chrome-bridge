#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_ROOT="$(mktemp -d "$REPO_ROOT/.local-chrome-staging.service-test.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

FAKE_BIN="$TEST_ROOT/bin"
STATE_DIR="$TEST_ROOT/state"
LOG_PATH="$TEST_ROOT/launchctl.log"
NODE_ARGS_LOG="$TEST_ROOT/node-args.log"
MAIN_LABEL="com.kapunakap.chatgpt-chrome-bridge.local-chrome"
HEALTH_LABEL="$MAIN_LABEL.health"
MAIN_PLIST="$TEST_ROOT/$MAIN_LABEL.plist"
HEALTH_PLIST="$TEST_ROOT/$HEALTH_LABEL.plist"
mkdir -p "$FAKE_BIN" "$STATE_DIR" "$TEST_ROOT/profile"

cat > "$FAKE_BIN/launchctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

state_dir="${FAKE_LAUNCHCTL_STATE_DIR:?}"
log_path="${FAKE_LAUNCHCTL_LOG:?}"
command="${1:-}"
target="${2:-}"
label="${target##*/}"
state_path="$state_dir/$label"
printf '%s\n' "$*" >>"$log_path"

case "$command" in
  print)
    [[ -f "$state_path" ]] || exit 113
    if [[ "$label" == "${FAKE_MAIN_LABEL:-}" && -n "${FAKE_LAUNCHCTL_MAIN_SEQUENCE:-}" ]]; then
      count_path="$state_dir/main-print-count"
      count=0
      if [[ -f "$count_path" ]]; then
        read -r count <"$count_path"
      fi
      count=$((count + 1))
      printf '%s\n' "$count" >"$count_path"
      check_number=$(((count + 1) / 2))
      outcome="${FAKE_LAUNCHCTL_MAIN_SEQUENCE:check_number - 1:1}"
      if [[ "$outcome" == "F" ]]; then
        printf 'state = exited\npid = %s\n' "${FAKE_LAUNCHCTL_PID:?}"
        exit 0
      fi
    fi
    printf 'state = running\npid = %s\n' "${FAKE_LAUNCHCTL_PID:?}"
    ;;
  enable)
    [[ -f "$state_path" ]] || exit 113
    ;;
  bootstrap)
    plist_path="${3:?}"
    plist_label="$(basename "$plist_path" .plist)"
    : >"$state_dir/$plist_label"
    ;;
  bootout)
    rm -f "$state_path"
    ;;
  kickstart)
    target="${@: -1}"
    label="${target##*/}"
    state_path="$state_dir/$label"
    [[ -f "$state_path" ]] || exit 113
    ;;
  *)
    printf 'unexpected launchctl command: %s\n' "$*" >&2
    exit 2
    ;;
esac
SH
chmod 700 "$FAKE_BIN/launchctl"

cat > "$FAKE_BIN/tunnel-client" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--version" ]]; then
  printf '0.0.14+test\n'
  exit 0
fi

if [[ "${1:-}" == "runtimes" && "${3:-}" == "status" ]]; then
  printf '{"process_running":false,"healthy":false,"ready":false}\n'
  exit 0
fi

printf 'unexpected tunnel-client command: %s\n' "$*" >&2
exit 2
SH
chmod 700 "$FAKE_BIN/tunnel-client"

cat > "$FAKE_BIN/node" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"${FAKE_NODE_ARGS_LOG:?}"

if [[ "${2:-}" == "probe" ]]; then
  if [[ "${FAKE_BROWSER_PROBE_SUCCESS:-true}" == "true" ]]; then
    printf '{"ok":true,"chromeDiscovered":true,"userBindingUsable":true,"tabsApiUsable":true}\n'
    exit 0
  fi
  printf 'BrowserJack health socket unavailable\n' >&2
  exit 2
fi

exit 0
SH
chmod 700 "$FAKE_BIN/node"

cat > "$FAKE_BIN/sleep" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod 700 "$FAKE_BIN/sleep"

cat > "$MAIN_PLIST" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>com.kapunakap.chatgpt-chrome-bridge.local-chrome</string></dict></plist>
PLIST
cat > "$HEALTH_PLIST" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>com.kapunakap.chatgpt-chrome-bridge.local-chrome.health</string></dict></plist>
PLIST
printf 'test-profile\n' >"$TEST_ROOT/profile/local-chrome.yaml"
printf 'test-key\n' >"$TEST_ROOT/runtime-api-key"
chmod 600 "$MAIN_PLIST" "$HEALTH_PLIST" "$TEST_ROOT/profile/local-chrome.yaml" "$TEST_ROOT/runtime-api-key"

export PATH="$FAKE_BIN:$PATH"
export FAKE_LAUNCHCTL_STATE_DIR="$STATE_DIR"
export FAKE_LAUNCHCTL_LOG="$LOG_PATH"
export FAKE_NODE_ARGS_LOG="$NODE_ARGS_LOG"
export FAKE_LAUNCHCTL_PID="$$"
export FAKE_LAUNCHCTL_MAIN_SEQUENCE="PFPPP"
export FAKE_BROWSER_PROBE_SUCCESS=false
export FAKE_MAIN_LABEL="$MAIN_LABEL"
export LOCAL_CHROME_LAUNCH_AGENT_LABEL="$MAIN_LABEL"
export LOCAL_CHROME_HEALTH_LAUNCH_AGENT_LABEL="$HEALTH_LABEL"
export LOCAL_CHROME_LAUNCH_AGENT_PLIST="$MAIN_PLIST"
export LOCAL_CHROME_HEALTH_LAUNCH_AGENT_PLIST="$HEALTH_PLIST"
export TUNNEL_CLIENT_PROFILE_DIR="$TEST_ROOT/profile"
export CONTROL_PLANE_RUNTIME_API_KEY_FILE="$TEST_ROOT/runtime-api-key"

assert_startup_output() {
  local output_path="$1"
  rg -q '^Starting Local Chrome service; waiting for the launchd-owned main service ' "$output_path"
  rg -q '^launch_agent_loaded=true$' "$output_path"
  rg -q '^launch_agent_pid_alive=true$' "$output_path"
  rg -q '^runtime_process_owner=launchd$' "$output_path"
  rg -q '^process_running=true$' "$output_path"
  rg -q '^browser_readiness=pending-hosted-initialize$' "$output_path"
  rg -q '^tunnel_readiness=pending-hosted-initialize$' "$output_path"
  rg -q '^startup_ready=true$' "$output_path"
  if rg -q '^(ready|browser_ready|tunnel_healthy|tunnel_ready)=true$' "$output_path"; then
    printf 'startup output reported readiness before hosted initialize: %s\n' "$output_path" >&2
    exit 1
  fi
}

success_output="$TEST_ROOT/start.out"
bash "$REPO_ROOT/scripts/service.sh" start >"$success_output"
assert_startup_output "$success_output"
rg -q '^Stability check 2/10 failed; consecutive counter reset: LaunchAgent is loaded but its process is not running\.$' "$success_output"
rg -q '^LaunchAgent is loaded with an alive running PID\. Stability check 5/10 passed \(3/3 consecutive\)\.$' "$success_output"
if [[ -s "$NODE_ARGS_LOG" ]]; then
  printf 'service start unexpectedly invoked the BrowserJack health probe:\n' >&2
  sed -n '1,20p' "$NODE_ARGS_LOG" >&2
  exit 1
fi

rm -f "$STATE_DIR/main-print-count"
export FAKE_LAUNCHCTL_MAIN_SEQUENCE="PPP"
restart_output="$TEST_ROOT/restart.out"
bash "$REPO_ROOT/scripts/service.sh" restart >"$restart_output"
assert_startup_output "$restart_output"
if [[ -s "$NODE_ARGS_LOG" ]]; then
  printf 'service restart unexpectedly invoked the BrowserJack health probe:\n' >&2
  sed -n '1,20p' "$NODE_ARGS_LOG" >&2
  exit 1
fi

assert_bootstrap_precedes_enable() {
  local label="$1"
  local bootstrap_line=''
  local enable_line=''

  bootstrap_line="$(rg -n "^bootstrap .*${label}\.plist$" "$LOG_PATH" | head -n 1 | cut -d: -f1)"
  enable_line="$(rg -n "^enable .*/${label}$" "$LOG_PATH" | head -n 1 | cut -d: -f1)"
  [[ -n "$bootstrap_line" && -n "$enable_line" ]] || {
    printf 'missing bootstrap/enable trace for %s\n' "$label" >&2
    exit 1
  }
  (( bootstrap_line < enable_line ))
}

assert_bootstrap_precedes_enable "$MAIN_LABEL"
assert_bootstrap_precedes_enable "$HEALTH_LABEL"
printf 'service launchd readiness and bootstrap ordering passed\n'
