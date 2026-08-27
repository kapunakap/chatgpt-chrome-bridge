#!/usr/bin/env bash
set -euo pipefail

UPSTREAM_REPO="https://github.com/stickerdaniel/browserjack.git"
UPSTREAM_COMMIT="8ee11377e18289149a1bf660a49ec4b1513b4e72"
EXPECTED_VERSION="26.820.60940"
EXPECTED_BUILD="7119"
EXPECTED_BUNDLE_ID="com.openai.codex"
EXPECTED_TEAM_ID="2DC432GLL2"
EXPECTED_CLIENT_SHA256="2158647076eed887c7591cca0957da78747ab9155819d64409d6b895e84ed99b"
EXPECTED_HOST_NAME="com.openai.codexextension"
PREFERRED_EXTENSION_ID="hehggadaopoacecdllhhajmbjkdcmajg"

APP="${CHATGPT_APP_PATH:-/Applications/ChatGPT.app}"
PLUGIN="$APP/Contents/Resources/plugins/openai-bundled/plugins/chrome"
CLIENT="$PLUGIN/scripts/browser-client.mjs"
SERVICE="$PLUGIN/scripts/browser-service.mjs"
MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json"
TARGET="${BROWSERJACK_PATCHED_ROOT:-$HOME/Library/Application Support/chatgpt-browser-bridge/browserjack/$EXPECTED_VERSION}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "$(uname -s)" == "Darwin" ]] || fail "This bridge requires macOS."
[[ "$(uname -m)" == "arm64" ]] || fail "This bridge currently requires Apple Silicon (arm64)."
for cmd in git node npm python3; do
  command -v "$cmd" >/dev/null 2>&1 || fail "$cmd is required."
done
[[ -d "$APP" ]] || fail "OpenAI desktop app is missing: $APP"
[[ -f "$CLIENT" ]] || fail "OpenAI browser client is missing: $CLIENT"
[[ -f "$SERVICE" ]] || fail "OpenAI browser service is missing: $SERVICE"
[[ -f "$MANIFEST" ]] || fail "Chrome native-host manifest is missing: $MANIFEST. Set up the official ChatGPT/Codex Chrome integration first."

app_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
app_build="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist")"
bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")"
[[ "$app_version" == "$EXPECTED_VERSION" ]] || fail "Unsupported ChatGPT/Codex app version: $app_version (expected $EXPECTED_VERSION)."
[[ "$app_build" == "$EXPECTED_BUILD" ]] || fail "Unsupported ChatGPT/Codex app build: $app_build (expected $EXPECTED_BUILD)."
[[ "$bundle_id" == "$EXPECTED_BUNDLE_ID" ]] || fail "Unexpected ChatGPT/Codex bundle ID: $bundle_id"

signature_details="$(/usr/bin/codesign -dv --verbose=4 "$APP" 2>&1 || true)"
team_id="$(printf '%s\n' "$signature_details" | sed -n 's/^TeamIdentifier=//p' | head -n 1)"
[[ "$team_id" == "$EXPECTED_TEAM_ID" ]] || fail "Unexpected OpenAI TeamIdentifier."

client_sha256="$(/usr/bin/shasum -a 256 "$CLIENT" | awk '{print $1}')"
[[ "$client_sha256" == "$EXPECTED_CLIENT_SHA256" ]] || fail "Unexpected browser-client SHA-256."

native_metadata="$(python3 - "$MANIFEST" "$EXPECTED_HOST_NAME" "$PREFERRED_EXTENSION_ID" <<'PY'
import json
import re
import sys

manifest_path, expected_host, preferred_id = sys.argv[1:]
with open(manifest_path, encoding="utf-8") as handle:
    value = json.load(handle)

if value.get("name") != expected_host:
    raise SystemExit("unexpected native-host name")

ids = []
for origin in value.get("allowed_origins") or []:
    match = re.fullmatch(r"chrome-extension://([a-z]{32})/", origin)
    if match:
        ids.append(match.group(1))

if preferred_id not in ids:
    raise SystemExit("preferred Chrome extension ID is not allowed by the native host")

print(expected_host)
print(preferred_id)
PY
)" || fail "Could not verify Chrome native-host metadata."

printf 'Verified OpenAI desktop build %s (%s), TeamIdentifier, browser-client hash, native host, and extension identity.\n' "$app_version" "$app_build"

mkdir -p "$(dirname "$TARGET")"
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/chatgpt-browser-bridge-browserjack.XXXXXX")"
SRC_ROOT="$WORK_ROOT/browserjack"
cleanup() {
  rm -rf "$WORK_ROOT"
}
trap cleanup EXIT

git clone --quiet "$UPSTREAM_REPO" "$SRC_ROOT"
git -C "$SRC_ROOT" checkout --quiet --detach "$UPSTREAM_COMMIT"

python3 - \
  "$SRC_ROOT/src/discovery/app.ts" \
  "$SRC_ROOT/src/discovery/native-host.ts" \
  "$SRC_ROOT/src/doctor/live.ts" \
  "$SRC_ROOT/src/runtime/server.ts" <<'PY'
from pathlib import Path
import sys

app_path = Path(sys.argv[1])
native_path = Path(sys.argv[2])
live_path = Path(sys.argv[3])
server_path = Path(sys.argv[4])

app = app_path.read_text()
old = '''  await runCommand(CODESIGN, ["--verify", "--strict", appPath]);
  const signature = await runCommand(CODESIGN, ["-dv", "--verbose=4", appPath]);'''
new = '''  const strictVerification = await runCommand(CODESIGN, ["--verify", "--strict", appPath], {
    allowNonZero: true,
  });
  if (
    strictVerification.code !== 0 &&
    process.env.BROWSERJACK_EXPERIMENT_ALLOW_BROKEN_OPENAI_SIGNATURE !== "1"
  ) {
    throw new Error(`ChatGPT.app strict signature verification failed: ${strictVerification.stderr.trim()}`);
  }
  const signature = await runCommand(CODESIGN, ["-dv", "--verbose=4", appPath], {
    allowNonZero: true,
  });'''
if old not in app:
    raise SystemExit("BrowserJack app signature block no longer matches the pinned upstream commit")
app = app.replace(old, new, 1)

old = '''  const extensionMetadataPath = join(chromePluginPath, "scripts", "extension-id.json");
  const extensionMetadata = parseExtensionMetadata(
    await readJsonFile(extensionMetadataPath),
    extensionMetadataPath,
  );'''
new = '''  const extensionMetadataPath = join(chromePluginPath, "scripts", "extension-id.json");
  const extensionMetadata = (await exists(extensionMetadataPath))
    ? parseExtensionMetadata(await readJsonFile(extensionMetadataPath), extensionMetadataPath)
    : {
        extensionId: process.env.BROWSERJACK_EXPERIMENT_EXTENSION_ID ?? "",
        extensionHostName: process.env.BROWSERJACK_EXPERIMENT_NATIVE_HOST_NAME ?? "",
      };
  if (!extensionMetadata.extensionId || !extensionMetadata.extensionHostName) {
    throw new Error(
      `Missing ${extensionMetadataPath} and no compatibility extension/native-host metadata was provided`,
    );
  }'''
if old not in app:
    raise SystemExit("BrowserJack extension metadata block no longer matches the pinned upstream commit")
app = app.replace(old, new, 1)
app_path.write_text(app)

native = native_path.read_text()
old = '''  if (verification.code !== 0) {
    return null;
  }
  const details = await runCommand(CODESIGN, ["-dv", "--verbose=4", hostPath], {
    allowNonZero: true,
  });'''
new = '''  if (
    verification.code !== 0 &&
    process.env.BROWSERJACK_EXPERIMENT_ALLOW_BROKEN_OPENAI_SIGNATURE !== "1"
  ) {
    return null;
  }
  const details = await runCommand(CODESIGN, ["-dv", "--verbose=4", hostPath], {
    allowNonZero: true,
  });'''
if old not in native:
    raise SystemExit("BrowserJack native-host signature block no longer matches the pinned upstream commit")
native = native.replace(old, new, 1)
native_path.write_text(native)

live = live_path.read_text()
old = '''await bridgeDoctorClient.setupBrowserRuntime({ globals: globalThis })'''
new = '''globalThis.agent = await bridgeDoctorClient.setupBrowserRuntime()'''
if live.count(old) != 1:
    raise SystemExit("BrowserJack live runtime setup no longer matches the pinned upstream commit")
live = live.replace(old, new, 1)
live_path.write_text(live)

server = server_path.read_text()
old = '''    "Import that exact URL and call setupBrowserRuntime({ globals: globalThis }) before using agent.browsers.",'''
new = '''    "Import that exact URL and assign globalThis.agent = await setupBrowserRuntime() before using agent.browsers.",'''
if old not in server:
    raise SystemExit("BrowserJack runtime instructions no longer match the pinned upstream commit")
server = server.replace(old, new, 1)
server_path.write_text(server)
PY

(
  cd "$SRC_ROOT"
  npm ci --quiet
  npm run build --silent
)

[[ -f "$SRC_ROOT/dist/cli.js" ]] || fail "Pinned BrowserJack build did not produce dist/cli.js."

OLD_TARGET="${TARGET}.old.$$"
rm -rf "$OLD_TARGET"
if [[ -e "$TARGET" ]]; then
  mv "$TARGET" "$OLD_TARGET"
fi
if mv "$SRC_ROOT" "$TARGET"; then
  rm -rf "$OLD_TARGET"
else
  if [[ -e "$OLD_TARGET" ]]; then
    mv "$OLD_TARGET" "$TARGET"
  fi
  fail "Could not install the prepared BrowserJack runtime."
fi

printf 'Prepared BrowserJack compatibility runtime: %s\n' "$TARGET"
