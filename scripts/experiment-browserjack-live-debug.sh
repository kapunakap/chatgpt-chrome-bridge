#!/usr/bin/env bash
set -euo pipefail

UPSTREAM_REPO="https://github.com/stickerdaniel/browserjack.git"
UPSTREAM_COMMIT="8ee11377e18289149a1bf660a49ec4b1513b4e72"
APP="/Applications/ChatGPT.app"
CHROME_MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK_ROOT="$REPO_ROOT/.tmp/browserjack-live-debug"
SRC_ROOT="$WORK_ROOT/browserjack"
STATE_ROOT="$WORK_ROOT/browserjack-home"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

for cmd in git node npm python3; do
  command -v "$cmd" >/dev/null 2>&1 || fail "$cmd is required"
done

[[ -d "$APP" ]] || fail "$APP is missing"
[[ -f "$CHROME_MANIFEST" ]] || fail "Chrome OpenAI native-host manifest is missing: $CHROME_MANIFEST"

NATIVE_HOST_NAME="$(python3 - "$CHROME_MANIFEST" <<'PY'
import json, sys
v = json.load(open(sys.argv[1]))
name = v.get("name")
if not isinstance(name, str) or not name:
    raise SystemExit(2)
print(name)
PY
)" || fail "could not read native-host name"

EXTENSION_ID="$(python3 - "$CHROME_MANIFEST" <<'PY'
import json, re, sys
v = json.load(open(sys.argv[1]))
for origin in v.get("allowed_origins", []) or []:
    m = re.fullmatch(r"chrome-extension://([a-z]{32})/", origin)
    if m:
        print(m.group(1))
        raise SystemExit(0)
raise SystemExit(2)
PY
)" || fail "could not derive a Chrome extension id"

printf '== disposable BrowserJack live DEBUG experiment ==\n'
printf 'upstream_commit=%s\n' "$UPSTREAM_COMMIT"
printf 'chatgpt_app=%s\n' "$APP"
printf 'native_host_name=%s\n' "$NATIVE_HOST_NAME"
printf 'extension_id=%s\n' "$EXTENSION_ID"
printf 'work_root=%s\n' "$WORK_ROOT"
printf '\n'

rm -rf "$WORK_ROOT"
mkdir -p "$WORK_ROOT" "$STATE_ROOT"

git clone --quiet "$UPSTREAM_REPO" "$SRC_ROOT"
git -C "$SRC_ROOT" checkout --quiet --detach "$UPSTREAM_COMMIT"

python3 - \
  "$SRC_ROOT/src/discovery/app.ts" \
  "$SRC_ROOT/src/discovery/native-host.ts" \
  "$SRC_ROOT/src/doctor/live.ts" <<'PY'
from pathlib import Path
import sys

app_path = Path(sys.argv[1])
native_path = Path(sys.argv[2])
live_path = Path(sys.argv[3])

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
    raise SystemExit("app.ts signature block no longer matches pinned upstream")
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
      `Missing ${extensionMetadataPath} and no experiment extension/native-host metadata was provided`,
    );
  }'''
if old not in app:
    raise SystemExit("app.ts extension metadata block no longer matches pinned upstream")
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
    raise SystemExit("native-host.ts signature block no longer matches pinned upstream")
native = native.replace(old, new, 1)
native_path.write_text(native)

live = live_path.read_text()
old = '''  const timer = setTimeout(() => {
    if (child.pid) {'''
new = '''  let childStderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    childStderr += chunk;
    if (childStderr.length > 65536) {
      childStderr = childStderr.slice(-65536);
    }
  });

  const timer = setTimeout(() => {
    if (child.pid) {'''
if old not in live:
    raise SystemExit("live.ts timer block no longer matches pinned upstream")
live = live.replace(old, new, 1)

old = '''        if (record.error !== undefined || result?.isError === true) {
          throw new Error("OpenAI browser runtime handshake failed");
        }'''
new = '''        if (record.error !== undefined || result?.isError === true) {
          throw new Error(
            `OpenAI browser runtime handshake failed\\n` +
              `rpc_record=${JSON.stringify(record, null, 2)}\\n` +
              `child_stderr=${childStderr || "<empty>"}`,
          );
        }'''
if old not in live:
    raise SystemExit("live.ts handshake error block no longer matches pinned upstream")
live = live.replace(old, new, 1)

old = '''    if (!initialized || !toolsListed || !browserConnected) {
      throw new Error("Cold-start probe did not initialize the OpenAI browser runtime");
    }'''
new = '''    if (!initialized || !toolsListed || !browserConnected) {
      throw new Error(
        `Cold-start probe did not initialize the OpenAI browser runtime\\n` +
          `initialized=${initialized} toolsListed=${toolsListed} browserConnected=${browserConnected}\\n` +
          `child_stderr=${childStderr || "<empty>"}`,
      );
    }'''
if old not in live:
    raise SystemExit("live.ts cold-start error block no longer matches pinned upstream")
live = live.replace(old, new, 1)
live_path.write_text(live)
PY

printf 'patch_scope=BrowserJack temp checkout only; ChatGPT.app untouched\n'
printf 'debug_capture=failed tools/call JSON-RPC record + child stderr tail\n'
printf 'remaining_checks=OpenAI TeamIdentifier + app/cache browser-client byte identity + actual runtime behavior\n\n'

(
  cd "$SRC_ROOT"
  npm ci --quiet
  npm run build --silent
)

set +e
OUTPUT="$(
  cd "$SRC_ROOT"
  BROWSERJACK_HOME="$STATE_ROOT" \
  BROWSERJACK_EXPERIMENT_ALLOW_BROKEN_OPENAI_SIGNATURE=1 \
  BROWSERJACK_EXPERIMENT_EXTENSION_ID="$EXTENSION_ID" \
  BROWSERJACK_EXPERIMENT_NATIVE_HOST_NAME="$NATIVE_HOST_NAME" \
  node dist/cli.js doctor --live --json 2>&1
)"
STATUS=$?
set -e

printf '%s\n' "$OUTPUT"
printf '\ndebug_experiment_exit=%s\n' "$STATUS"
if [[ "$STATUS" -eq 0 ]]; then
  echo 'DEBUG_EXPERIMENT_BROWSERJACK_LIVE_OK=1'
else
  echo 'DEBUG_EXPERIMENT_BROWSERJACK_LIVE_OK=0'
fi

exit "$STATUS"
