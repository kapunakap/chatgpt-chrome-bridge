#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FINGERPRINT_HELPER="$REPO_ROOT/scripts/browserjack-fingerprint.mjs"
RUNTIME_HELPER="$REPO_ROOT/scripts/browserjack-runtime.mjs"
SUPERVISOR="$REPO_ROOT/scripts/browserjack-supervisor.mjs"
ADAPTER_ID="$(node "$FINGERPRINT_HELPER" config adapterId)"
EXPECTED_HOST_NAME="$(node "$FINGERPRINT_HELPER" config nativeHostName)"
VERIFIED_BUILDS_FILE="$(node "$FINGERPRINT_HELPER" config verifiedBuildsFile)"
export BROWSERJACK_VERIFIED_BUILDS_FILE="$VERIFIED_BUILDS_FILE"

PATCHED_ROOT="${BROWSERJACK_PATCHED_ROOT:-${CODEX_HOME:-$HOME/.codex}/chatgpt-browser-bridge/browserjack/$ADAPTER_ID}"
APP="${CHATGPT_APP_PATH:-/Applications/ChatGPT.app}"
PLUGIN="$APP/Contents/Resources/plugins/openai-bundled/plugins/chrome"
SERVICE="$PLUGIN/scripts/browser-service.mjs"
CLIENT="$PLUGIN/scripts/browser-client.mjs"
MANIFEST="${BROWSERJACK_MANIFEST_PATH:-$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json}"
APPROVAL_FILE="${BROWSERJACK_APPROVAL_FILE:-$HOME/.config/chatgpt-browser-bridge/browser-runtime-approvals.json}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

has_flag() {
  local wanted="$1"
  shift
  local value
  for value in "$@"; do
    [[ "$value" == "$wanted" ]] && return 0
  done
  return 1
}

[[ -f "$SERVICE" ]] || fail "Trusted browser service is missing: $SERVICE"
[[ -f "$CLIENT" ]] || fail "Browser client is missing: $CLIENT"
[[ -f "$MANIFEST" ]] || fail "Chrome native-host manifest is missing: $MANIFEST"

snapshot_json="$(node "$FINGERPRINT_HELPER" inspect \
  --app "$APP" \
  --manifest "$MANIFEST" \
  --approvals-file "$APPROVAL_FILE")"
fingerprint="$(printf '%s' "$snapshot_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).fingerprint))')"
approved="$(printf '%s' "$snapshot_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).approved)))')"

candidate=false
candidate_env=0
if [[ "$approved" != "true" ]]; then
  if [[ "${1:-}" == "run" ]] || { [[ "${1:-}" == "doctor" ]] && has_flag --live "$@"; }; then
    candidate=true
    candidate_env=1
  else
    fail "Unapproved browser runtime fingerprint: $fingerprint. Run bash scripts/review-browserjack-update.sh or request a live compatibility test."
  fi
fi

if [[ ! -f "$PATCHED_ROOT/dist/cli.js" ]]; then
  if [[ "$candidate" == true ]]; then
    BROWSERJACK_ALLOW_UNAPPROVED_CANDIDATE=1 bash "$REPO_ROOT/scripts/prepare-browserjack.sh"
  else
    fail "Prepared BrowserJack runtime is missing: $PATCHED_ROOT/dist/cli.js. Run bash scripts/bootstrap-local.sh."
  fi
fi

validated_runtime="$(BROWSERJACK_ALLOW_UNAPPROVED_CANDIDATE="$candidate_env" \
  BROWSERJACK_APPROVAL_FILE="$APPROVAL_FILE" \
  node "$RUNTIME_HELPER" resolve --app "$APP" --manifest "$MANIFEST")"
extension_id="$(printf '%s' "$validated_runtime" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).extensionId))')"
native_host_name="$(printf '%s' "$validated_runtime" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).nativeHostName))')"
[[ "$native_host_name" == "$EXPECTED_HOST_NAME" ]] || fail "Signed native-host name does not match the approved bridge identity"

trusted_services="$(node -e 'console.log(JSON.stringify({browser:process.argv[1]}))' "$SERVICE")"
export BROWSERJACK_APPROVAL_FILE="$APPROVAL_FILE"
export BROWSERJACK_MANIFEST_PATH="$MANIFEST"
export BROWSERJACK_VALIDATED_RUNTIME_JSON="$validated_runtime"
export BROWSERJACK_RUNTIME_FINGERPRINT="$fingerprint"
export BROWSERJACK_EXPERIMENT_NATIVE_HOST_NAME="$native_host_name"
export BROWSERJACK_EXPERIMENT_EXTENSION_ID="$extension_id"
export BROWSERJACK_REQUIRE_PER_BUILD_SELF_TEST=1
export NODE_REPL_TRUSTED_SERVICES="$trusted_services"
export BROWSER_USE_CODEX_APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
export BROWSER_USE_CODEX_APP_BUILD_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist")"
export BROWSER_USE_CODEX_APP_BUILD_FLAVOR="prod"
export NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS="1000"
export BROWSER_USE_AVAILABLE_BACKENDS="chrome"

if [[ "$candidate" == true && "${1:-}" == "doctor" ]]; then
  probe_root="$(mktemp -d "${TMPDIR:-/tmp}/chatgpt-browser-bridge-candidate.XXXXXX")"
  probe_output="$probe_root/doctor.out"
  probe_error="$probe_root/doctor.err"
  cleanup_probe() {
    rm -rf "$probe_root"
  }
  trap cleanup_probe EXIT

  set +e
  node "$PATCHED_ROOT/dist/cli.js" doctor --live --json >"$probe_output" 2>"$probe_error"
  probe_rc=$?
  set -e
  if [[ "$probe_rc" -ne 0 ]]; then
    sed -n '1,120p' "$probe_error" >&2 || true
    sed -n '1,80p' "$probe_output" >&2 || true
    fail "Browser runtime candidate failed the real live compatibility test; no local approval was written."
  fi

  node "$FINGERPRINT_HELPER" approve \
    --app "$APP" \
    --manifest "$MANIFEST" \
    --approvals-file "$APPROVAL_FILE" \
    --expected "$fingerprint" >/dev/null
  candidate=false
  unset BROWSERJACK_ALLOW_UNAPPROVED_CANDIDATE

  if [[ "${1:-}" == "doctor" ]]; then
    cat "$probe_output"
    exit 0
  fi
fi

if [[ "${1:-}" == "run" ]]; then
  shift
  exec node "$SUPERVISOR" -- "$PATCHED_ROOT/dist/cli.js" run "$@"
fi

exec node "$PATCHED_ROOT/dist/cli.js" "$@"
