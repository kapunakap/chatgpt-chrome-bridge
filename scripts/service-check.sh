#!/usr/bin/env bash
set -euo pipefail

# Run checks in the service's own launchd environment. A Codex terminal carries
# chat-scoped browser-access settings that do not belong to a standalone tunnel.
# Do not copy, unset, persist, or replay those settings: launchd owns the context.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

run_check() {
  case "$1" in
    doctor) bash "$REPO_ROOT/scripts/browserjack-current.sh" doctor --live --json ;;
    smoke) node "$REPO_ROOT/scripts/browserjack-mcp-smoke.mjs" ;;
    status) bash "$REPO_ROOT/scripts/status.sh" ;;
    *) printf 'Usage: bash scripts/service-check.sh <doctor|smoke|status>\n' >&2; return 2 ;;
  esac
}

if [[ "${1:-}" == "--worker" ]]; then
  set +e
  run_check "$2" >"$3/output" 2>&1
  check_exit=$?
  printf '%s\n' "$check_exit" >"$3/result.tmp"
  mv "$3/result.tmp" "$3/result"
  exit 0
fi

action="${1:-}"
case "$action" in doctor|smoke|status) ;; *) run_check "$action"; exit 2 ;; esac
[[ "$(uname -s)" == Darwin ]] || { printf 'This check requires macOS.\n' >&2; exit 1; }
label="${LOCAL_CHROME_LAUNCH_AGENT_LABEL:-com.kapunakap.chatgpt-chrome-bridge.local-chrome}"
service_plist="${LOCAL_CHROME_LAUNCH_AGENT_PLIST:-$HOME/Library/LaunchAgents/$label.plist}"
[[ -f "$service_plist" ]] || { printf 'service_check_failure_code=service_not_installed\n' >&2; exit 1; }
umask 077
check_root="$(mktemp -d "${TMPDIR:-/tmp}/local-chrome-service-check.XXXXXX")"
check_label="$label.check.$$"
domain="gui/$(id -u)"
cleanup() {
  launchctl bootout "$domain/$check_label" >/dev/null 2>&1 || true
  rm -rf "$check_root"
}
trap cleanup EXIT

python3 - "$service_plist" "$check_root" "$check_label" "$REPO_ROOT" "$action" <<'PY'
import pathlib, plistlib, sys
source, root, label, repo, action = sys.argv[1:]
with open(source, 'rb') as f:
    service = plistlib.load(f)
job = {
    'Label': label,
    'ProgramArguments': ['/bin/bash', repo + '/scripts/service-check.sh', '--worker', action, root],
    'EnvironmentVariables': service.get('EnvironmentVariables', {}),
    'WorkingDirectory': repo, 'RunAtLoad': True, 'KeepAlive': False, 'Umask': 0o077,
    'StandardOutPath': root + '/worker.stdout', 'StandardErrorPath': root + '/worker.stderr',
}
with open(pathlib.Path(root) / 'check.plist', 'wb') as f:
    plistlib.dump(job, f)
PY
if ! launchctl bootstrap "$domain" "$check_root/check.plist" >"$check_root/bootstrap.output" 2>&1; then
  printf 'service_check_failure_code=bootstrap_failed\n' >&2
  exit 1
fi
for ((attempt=0; attempt<90; attempt++)); do
  [[ ! -f "$check_root/result" ]] || break
  sleep 1
done
[[ -f "$check_root/result" ]] || { printf 'service_check_timed_out=true\n' >&2; exit 1; }
check_exit="$(cat "$check_root/result")"

# status.sh includes tunnel bookkeeping and logs. Emit only fixed readiness
# fields; raw diagnostic output remains private and is removed on exit.
python3 "$REPO_ROOT/scripts/service-check-report.py" "$action" "$check_root/output" "$check_exit"
exit "$check_exit"
