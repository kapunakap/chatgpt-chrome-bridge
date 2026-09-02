#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FINGERPRINT_HELPER="$REPO_ROOT/scripts/browserjack-fingerprint.mjs"
BROWSERJACK_SHIM="$REPO_ROOT/scripts/browserjack-current.sh"
PREPARE_SH="$REPO_ROOT/scripts/prepare-browserjack.sh"
SMOKE_TEST="$REPO_ROOT/scripts/browserjack-mcp-smoke.mjs"
SERVICE_SH="$REPO_ROOT/scripts/service.sh"
SERVICE_TARGET="gui/$(id -u)/${LOCAL_CHROME_LAUNCH_AGENT_LABEL:-com.kapunakap.chatgpt-chrome-bridge.local-chrome}"
APPROVAL_FILE="$(node "$FINGERPRINT_HELPER" config approvalsFile)"
VERIFIED_BUILDS_FILE="$(node "$FINGERPRINT_HELPER" config verifiedBuildsFile)"
ADAPTER_ID="$(node "$FINGERPRINT_HELPER" config adapterId)"
PATCHED_ROOT="${BROWSERJACK_PATCHED_ROOT:-${CODEX_HOME:-$HOME/.codex}/chatgpt-browser-bridge/browserjack/$ADAPTER_ID}"
APP="${CHATGPT_APP_PATH:-/Applications/ChatGPT.app}"
MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

snapshot_file() {
  local source_path="$1"
  local backup_path="$2"
  if [[ -f "$source_path" ]]; then
    cp -p "$source_path" "$backup_path"
    printf 'present\n' >"$backup_path.state"
  else
    printf 'absent\n' >"$backup_path.state"
  fi
}

restore_file() {
  local target_path="$1"
  local backup_path="$2"
  local state=''
  state="$(<"$backup_path.state")"
  if [[ "$state" == "present" ]]; then
    mkdir -p "$(dirname "$target_path")"
    install -m 600 "$backup_path" "$target_path"
  elif [[ "$state" == "absent" ]]; then
    rm -f "$target_path"
  else
    fail "Invalid rollback state for $target_path"
  fi
}

main() {
  [[ -t 0 ]] || fail "Run this review command interactively."
  [[ -x "$BROWSERJACK_SHIM" ]] || fail "BrowserJack launcher is missing: $BROWSERJACK_SHIM"

  local candidate_json=''
  local fingerprint=''
  local app_version=''
  local build_version=''
  local was_running=false
  local work_root=''
  local staged_approvals=''
  local approval_backup=''
  local verified_backup=''
  local succeeded=false

  candidate_json="$(node "$FINGERPRINT_HELPER" inspect --app "$APP" --manifest "$MANIFEST")"
  fingerprint="$(printf '%s' "$candidate_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).fingerprint))')"
  app_version="$(printf '%s' "$candidate_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).appVersion))')"
  build_version="$(printf '%s' "$candidate_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).buildVersion))')"

  printf 'ChatGPT.app version=%s build=%s\n' "$app_version" "$build_version"
  printf 'candidate_fingerprint=%s\n' "$fingerprint"
  printf '%s\n' "$candidate_json" | node -e '
    let s="";
    process.stdin.on("data",d=>s+=d).on("end",()=>{
      const v=JSON.parse(s);
      for (const key of ["browserClientSha256","browserServiceSha256","nativeHostSha256"]) {
        process.stdout.write(`${key}=${v[key]}\n`);
      }
      process.stdout.write(`currently_approved=${v.approved}\n`);
    });
  '
  if [[ "$(printf '%s' "$candidate_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).approved)))')" == "true" ]]; then
    printf 'This browser-runtime fingerprint is already approved.\n'
    exit 0
  fi

  printf 'Approve this exact browser-runtime fingerprint for this Mac? [y/N] '
  local answer=''
  IFS= read -r answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] || fail "Review declined; no state was changed."

  if launchctl print "$SERVICE_TARGET" >/dev/null 2>&1; then
    was_running=true
  fi

  work_root="$(mktemp -d "${TMPDIR:-/tmp}/chatgpt-browser-review.XXXXXX")"
  staged_approvals="$work_root/approvals.json"
  approval_backup="$work_root/approval.backup"
  verified_backup="$work_root/verified-builds.backup"
  snapshot_file "$APPROVAL_FILE" "$approval_backup"
  snapshot_file "$VERIFIED_BUILDS_FILE" "$verified_backup"
  if [[ -f "$APPROVAL_FILE" ]]; then
    cp -p "$APPROVAL_FILE" "$staged_approvals"
  fi
  node "$FINGERPRINT_HELPER" approve \
    --app "$APP" \
    --manifest "$MANIFEST" \
    --approvals-file "$staged_approvals" \
    --expected "$fingerprint" >/dev/null

  rollback() {
    local exit_code=$?
    if [[ "$succeeded" != true ]]; then
      restore_file "$APPROVAL_FILE" "$approval_backup"
      restore_file "$VERIFIED_BUILDS_FILE" "$verified_backup"
      if [[ "$was_running" == true ]]; then
        bash "$SERVICE_SH" stop >/dev/null 2>&1 || true
      fi
      printf 'Browser-runtime approval was rolled back; Local Chrome remains stopped.\n' >&2
    fi
    rm -rf "$work_root"
    return "$exit_code"
  }
  trap rollback EXIT

  if [[ "$was_running" == true ]]; then
    bash "$SERVICE_SH" stop
  fi

  if [[ ! -f "$PATCHED_ROOT/dist/cli.js" ]]; then
    BROWSERJACK_APPROVAL_FILE="$staged_approvals" bash "$PREPARE_SH"
  fi
  BROWSERJACK_APPROVAL_FILE="$staged_approvals" "$BROWSERJACK_SHIM" doctor --live --json
  BROWSERJACK_APPROVAL_FILE="$staged_approvals" node "$SMOKE_TEST"

  node "$FINGERPRINT_HELPER" approve \
    --app "$APP" \
    --manifest "$MANIFEST" \
    --expected "$fingerprint" >/dev/null
  if [[ "$was_running" == true ]]; then
    bash "$SERVICE_SH" start
    bash "$REPO_ROOT/scripts/status.sh"
  fi

  succeeded=true
  printf 'BROWSER_FINGERPRINT_APPROVED=1\n'
  printf 'fingerprint=%s\n' "$fingerprint"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
