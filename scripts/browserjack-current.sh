#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FINGERPRINT_HELPER="$REPO_ROOT/scripts/browserjack-fingerprint.mjs"
ADAPTER_ID="$(node "$FINGERPRINT_HELPER" config adapterId)"
EXPECTED_HOST_NAME="$(node "$FINGERPRINT_HELPER" config nativeHostName)"
PREFERRED_EXTENSION_ID="$(node "$FINGERPRINT_HELPER" config preferredExtensionId)"

PATCHED_ROOT="${BROWSERJACK_PATCHED_ROOT:-$HOME/Library/Application Support/chatgpt-browser-bridge/browserjack/$ADAPTER_ID}"
APP="${CHATGPT_APP_PATH:-/Applications/ChatGPT.app}"
PLUGIN="$APP/Contents/Resources/plugins/openai-bundled/plugins/chrome"
SERVICE="$PLUGIN/scripts/browser-service.mjs"
CLIENT="$PLUGIN/scripts/browser-client.mjs"
MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ -f "$PATCHED_ROOT/dist/cli.js" ]] || fail "Prepared BrowserJack runtime is missing: $PATCHED_ROOT/dist/cli.js. Run bash scripts/bootstrap-local.sh."
[[ -f "$SERVICE" ]] || fail "Trusted browser service is missing: $SERVICE"
[[ -f "$CLIENT" ]] || fail "Browser client is missing: $CLIENT"
[[ -f "$MANIFEST" ]] || fail "Chrome native-host manifest is missing: $MANIFEST"

app_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
app_build="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist")"
node "$FINGERPRINT_HELPER" assert --app "$APP" --manifest "$MANIFEST" >/dev/null

native_metadata="$(
  python3 - "$MANIFEST" "$EXPECTED_HOST_NAME" "$PREFERRED_EXTENSION_ID" <<'PY'
import json
import re
import sys

manifest_path, expected_host, preferred_id = sys.argv[1:]
with open(manifest_path, encoding="utf-8") as handle:
    value = json.load(handle)

name = value.get("name")
if name != expected_host:
    raise SystemExit("unexpected native-host name")

ids = []
for origin in value.get("allowed_origins") or []:
    match = re.fullmatch(r"chrome-extension://([a-z]{32})/", origin)
    if match:
        ids.append(match.group(1))

if preferred_id not in ids:
    raise SystemExit("preferred Chrome extension ID is not allowed by the native host")

print(name)
print(preferred_id)
PY
)" || fail "Could not derive Chrome native-host metadata"
native_host_name="$(printf '%s\n' "$native_metadata" | sed -n '1p')"
extension_id="$(printf '%s\n' "$native_metadata" | sed -n '2p')"
[[ -n "$native_host_name" && -n "$extension_id" ]] || fail "Could not derive Chrome native-host metadata"

trusted_services="$(python3 - "$SERVICE" <<'PY'
import json
import sys

print(json.dumps({"browser": sys.argv[1]}, separators=(",", ":")))
PY
)"

export BROWSERJACK_EXPERIMENT_ALLOW_BROKEN_OPENAI_SIGNATURE=1
export BROWSERJACK_EXPERIMENT_NATIVE_HOST_NAME="$native_host_name"
export BROWSERJACK_EXPERIMENT_EXTENSION_ID="$extension_id"
export BROWSERJACK_REQUIRE_PER_BUILD_SELF_TEST=1
export NODE_REPL_TRUSTED_SERVICES="$trusted_services"
export BROWSER_USE_CODEX_APP_VERSION="$app_version"
export BROWSER_USE_CODEX_APP_BUILD_VERSION="$app_build"
export BROWSER_USE_CODEX_APP_BUILD_FLAVOR="prod"
export NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS="1000"
export BROWSER_USE_AVAILABLE_BACKENDS="chrome"

exec node "$PATCHED_ROOT/dist/cli.js" "$@"
