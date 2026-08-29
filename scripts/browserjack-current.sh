#!/usr/bin/env bash
set -euo pipefail

EXPECTED_VERSION="26.825.32147"
EXPECTED_BUILD="7303"
EXPECTED_BUNDLE_ID="com.openai.codex"
EXPECTED_TEAM_ID="2DC432GLL2"
EXPECTED_CLIENT_SHA256="c52ba09202f0e82caa6f6d2a6463a8635c1b1316567975d9b91c1a05fb5af501"
EXPECTED_HOST_NAME="com.openai.codexextension"
PREFERRED_EXTENSION_ID="hehggadaopoacecdllhhajmbjkdcmajg"

PATCHED_ROOT="${BROWSERJACK_PATCHED_ROOT:-$HOME/Library/Application Support/chatgpt-browser-bridge/browserjack/$EXPECTED_VERSION}"
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
bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")"
[[ "$app_version" == "$EXPECTED_VERSION" ]] || fail "Unsupported ChatGPT/Codex app version: $app_version"
[[ "$app_build" == "$EXPECTED_BUILD" ]] || fail "Unsupported ChatGPT/Codex app build: $app_build"
[[ "$bundle_id" == "$EXPECTED_BUNDLE_ID" ]] || fail "Unexpected ChatGPT/Codex bundle ID: $bundle_id"

signature_details="$(/usr/bin/codesign -dv --verbose=4 "$APP" 2>&1 || true)"
team_id="$(printf '%s\n' "$signature_details" | sed -n 's/^TeamIdentifier=//p' | head -n 1)"
[[ "$team_id" == "$EXPECTED_TEAM_ID" ]] || fail "Unexpected OpenAI TeamIdentifier"

client_sha256="$(/usr/bin/shasum -a 256 "$CLIENT" | awk '{print $1}')"
[[ "$client_sha256" == "$EXPECTED_CLIENT_SHA256" ]] || fail "Unexpected browser-client SHA-256"

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
export NODE_REPL_TRUSTED_SERVICES="$trusted_services"
export BROWSER_USE_CODEX_APP_VERSION="$app_version"
export BROWSER_USE_CODEX_APP_BUILD_FLAVOR="prod"
export NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS="1000"
export BROWSER_USE_AVAILABLE_BACKENDS="chrome"

exec node "$PATCHED_ROOT/dist/cli.js" "$@"
