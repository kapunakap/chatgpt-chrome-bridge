#!/usr/bin/env bash
set -euo pipefail

UPSTREAM_REPO="https://github.com/stickerdaniel/browserjack.git"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FINGERPRINT_HELPER="$REPO_ROOT/scripts/browserjack-fingerprint.mjs"
UPSTREAM_COMMIT="$(node "$FINGERPRINT_HELPER" config upstreamCommit)"
ADAPTER_ID="$(node "$FINGERPRINT_HELPER" config adapterId)"

APP="${CHATGPT_APP_PATH:-/Applications/ChatGPT.app}"
PLUGIN="$APP/Contents/Resources/plugins/openai-bundled/plugins/chrome"
CLIENT="$PLUGIN/scripts/browser-client.mjs"
SERVICE="$PLUGIN/scripts/browser-service.mjs"
MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json"
TARGET="${BROWSERJACK_PATCHED_ROOT:-$HOME/Library/Application Support/chatgpt-browser-bridge/browserjack/$ADAPTER_ID}"

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
node "$FINGERPRINT_HELPER" assert --app "$APP" --manifest "$MANIFEST" >/dev/null

printf 'Verified OpenAI desktop build %s (%s) against an approved browser-runtime fingerprint.\n' "$app_version" "$app_build"

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
  "$SRC_ROOT/src/runtime/server.ts" \
  "$SRC_ROOT/src/compat/ensure.ts" \
  "$SRC_ROOT/src/compat/verified.ts" \
  "$SRC_ROOT/test/compat.test.mjs" <<'PY'
from pathlib import Path
import sys

app_path = Path(sys.argv[1])
native_path = Path(sys.argv[2])
live_path = Path(sys.argv[3])
server_path = Path(sys.argv[4])
ensure_path = Path(sys.argv[5])
verified_path = Path(sys.argv[6])
compat_test_path = Path(sys.argv[7])

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

old = '''var bridgeDoctorBackends = await agent.browsers.list(); bridgeDoctorBackends.length'''
new = '''var bridgeDoctorBackends = await agent.browsers.list(); if (!bridgeDoctorBackends.some((backend) => backend.family === "chrome")) { await new Promise((resolveRetry) => setTimeout(resolveRetry, 2000)); bridgeDoctorBackends = await agent.browsers.list(); } if (!bridgeDoctorBackends.some((backend) => backend.family === "chrome")) { throw new Error("Chrome backend unavailable"); } bridgeDoctorBackends.length'''
if live.count(old) != 1:
    raise SystemExit("BrowserJack live backend check no longer matches the pinned upstream commit")
live = live.replace(old, new, 1)
live_path.write_text(live)

server = server_path.read_text()
old = '''    "Import that exact URL and call setupBrowserRuntime({ globals: globalThis }) before using agent.browsers.",'''
new = '''    "Import that exact URL and assign globalThis.agent = await setupBrowserRuntime() before using agent.browsers.",'''
if old not in server:
    raise SystemExit("BrowserJack runtime instructions no longer match the pinned upstream commit")
server = server.replace(old, new, 1)
server_path.write_text(server)

ensure = ensure_path.read_text()
old = '''  if (await findCompatibilityEntry(runtime)) {
    return { source: "manifest" };
  }'''
new = '''  if (
    process.env.BROWSERJACK_REQUIRE_PER_BUILD_SELF_TEST !== "1" &&
    (await findCompatibilityEntry(runtime))
  ) {
    return { source: "manifest" };
  }'''
if old not in ensure:
    raise SystemExit("BrowserJack compatibility manifest gate no longer matches the pinned upstream commit")
ensure = ensure.replace(old, new, 1)
ensure_path.write_text(ensure)

verified = verified_path.read_text()
verified = verified.replace(
    '''  appVersion: string;\n  pluginVersion: string;''',
    '''  appVersion: string;\n  buildVersion: string;\n  pluginVersion: string;''',
    1,
)
verified = verified.replace(
    '''  "appVersion" | "pluginVersion" | "architecture" | "browserClientSha256"''',
    '''  "appVersion" | "buildVersion" | "pluginVersion" | "architecture" | "browserClientSha256"''',
    1,
)
verified = verified.replace(
    '''    build.appVersion === runtime.appVersion &&\n    build.pluginVersion === runtime.pluginVersion &&''',
    '''    build.appVersion === runtime.appVersion &&\n    build.buildVersion === runtime.buildVersion &&\n    build.pluginVersion === runtime.pluginVersion &&''',
    1,
)
verified = verified.replace(
    '''      typeof build.appVersion === "string" &&\n      typeof build.pluginVersion === "string" &&''',
    '''      typeof build.appVersion === "string" &&\n      typeof build.buildVersion === "string" &&\n      typeof build.pluginVersion === "string" &&''',
    1,
)
verified = verified.replace(
    '''    appVersion: runtime.appVersion,\n    pluginVersion: runtime.pluginVersion,''',
    '''    appVersion: runtime.appVersion,\n    buildVersion: runtime.buildVersion,\n    pluginVersion: runtime.pluginVersion,''',
    1,
)
for required in ["buildVersion: string", "build.buildVersion === runtime.buildVersion"]:
    if required not in verified:
        raise SystemExit("BrowserJack verified-build key patch did not apply")
verified_path.write_text(verified)

compat_test = compat_test_path.read_text()
old = '''    appVersion: entry.appVersion,\n    pluginVersion: entry.pluginVersion,'''
new = '''    appVersion: entry.appVersion,\n    buildVersion: "test-build-1",\n    pluginVersion: entry.pluginVersion,'''
if old not in compat_test:
    raise SystemExit("BrowserJack compatibility test runtime no longer matches the pinned upstream commit")
compat_test = compat_test.replace(old, new, 1)
marker = '''test("manifest-covered builds skip the self-test entirely", async (t) => {'''
addition = '''test("a new build version runs a separate self-test", async (t) => {
  await withTemporaryHome(t);
  const first = { ...(await supportedRuntime()), appVersion: "99.1.2", buildVersion: "1" };
  const second = { ...first, buildVersion: "2" };
  let selfTests = 0;
  await ensureBuildCompatible(first, async () => { selfTests += 1; });
  await ensureBuildCompatible(second, async () => { selfTests += 1; });
  assert.equal(selfTests, 2);
});

'''
if marker not in compat_test:
    raise SystemExit("BrowserJack compatibility test insertion point no longer matches")
compat_test = compat_test.replace(marker, addition + marker, 1)
compat_test_path.write_text(compat_test)
PY

(
  cd "$SRC_ROOT"
  npm ci --quiet
  npm run check --silent
  npm test --silent
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
