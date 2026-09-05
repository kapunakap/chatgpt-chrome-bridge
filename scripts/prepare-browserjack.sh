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
TARGET="${BROWSERJACK_PATCHED_ROOT:-${CODEX_HOME:-$HOME/.codex}/chatgpt-browser-bridge/browserjack/$ADAPTER_ID}"

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
if [[ "${BROWSERJACK_ALLOW_UNAPPROVED_CANDIDATE:-0}" == "1" ]]; then
  node "$FINGERPRINT_HELPER" inspect --app "$APP" --manifest "$MANIFEST" >/dev/null
else
  node "$FINGERPRINT_HELPER" assert --app "$APP" --manifest "$MANIFEST" >/dev/null
fi

if [[ "${BROWSERJACK_ALLOW_UNAPPROVED_CANDIDATE:-0}" == "1" ]]; then
  printf 'Verified OpenAI desktop build %s (%s) as a signed runtime candidate; live approval is still required.\n' "$app_version" "$app_build"
else
  printf 'Verified OpenAI desktop build %s (%s) against an approved browser-runtime fingerprint.\n' "$app_version" "$app_build"
fi

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
  "$SRC_ROOT/src/discovery/types.ts" \
  "$SRC_ROOT/src/runtime/launch.ts" \
  "$SRC_ROOT/test/launch.test.mjs" \
  "$SRC_ROOT/test/compat.test.mjs" <<'PY'
from pathlib import Path
import sys

app_path = Path(sys.argv[1])
native_path = Path(sys.argv[2])
live_path = Path(sys.argv[3])
server_path = Path(sys.argv[4])
ensure_path = Path(sys.argv[5])
verified_path = Path(sys.argv[6])
types_path = Path(sys.argv[7])
launch_path = Path(sys.argv[8])
launch_test_path = Path(sys.argv[9])
compat_test_path = Path(sys.argv[10])

app = app_path.read_text()
old = '''  const browserClientPath = join(chromePluginPath, "scripts", "browser-client.mjs");'''
if old not in app:
    raise SystemExit("BrowserJack app discovery block no longer matches the pinned upstream commit")

old = '''  const browserClientPath = join(chromePluginPath, "scripts", "browser-client.mjs");
  const codexHome = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));'''
new = '''  const validatedRuntime = process.env.BROWSERJACK_VALIDATED_RUNTIME_JSON
    ? JSON.parse(process.env.BROWSERJACK_VALIDATED_RUNTIME_JSON)
    : null;
  const browserClientPath = validatedRuntime?.browserClientPath
    ?? join(chromePluginPath, "scripts", "browser-client.mjs");
  const browserServicePath = validatedRuntime?.browserServicePath
    ?? join(chromePluginPath, "scripts", "browser-service.mjs");
  const codexHome = resolve(validatedRuntime?.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  const appNativeHostPath = await findNativeHost(chromePluginPath);'''
if old not in app:
    raise SystemExit("BrowserJack runtime path block no longer matches the pinned upstream commit")
app = app.replace(old, new, 1)

old = '''    codexPath: await realpath(join(resourcesRoot, "codex")),
    nodePath: await realpath(join(cuaRoot, cuaManifest.nodePath)),
    nodeReplPath: await realpath(join(cuaRoot, cuaManifest.nodeReplPath)),
    nodeModulesPath: await realpath(join(cuaRoot, cuaManifest.nodeModules)),
    chromePluginPath: await realpath(chromePluginPath),
    pluginVersion: pluginMetadata.version,
    extensionId: extensionMetadata.extensionId,
    nativeHostName: extensionMetadata.extensionHostName,
    nativeHostPath: await findNativeHost(chromePluginPath),
    browserClientPath: await realpath(browserClientPath),
    browserClientSha256: await sha256File(browserClientPath),'''
new = '''    codexPath: await realpath(validatedRuntime?.codexCliPath ?? join(resourcesRoot, "codex")),
    nodePath: await realpath(validatedRuntime?.nodePath ?? join(cuaRoot, cuaManifest.nodePath)),
    nodeReplPath: await realpath(validatedRuntime?.nodeReplPath ?? join(cuaRoot, cuaManifest.nodeReplPath)),
    nodeModulesPath: validatedRuntime?.nodeModuleDirs?.join(":")
      ?? await realpath(join(cuaRoot, cuaManifest.nodeModules)),
    chromePluginPath: await realpath(validatedRuntime?.pluginRoots?.[0] ?? chromePluginPath),
    pluginVersion: pluginMetadata.version,
    extensionId: validatedRuntime?.extensionId ?? extensionMetadata.extensionId,
    extensionIds: validatedRuntime?.extensionIds ?? extensionMetadata.extensionIds,
    nativeHostName: validatedRuntime?.nativeHostName ?? extensionMetadata.extensionHostName,
    nativeHostPath: await realpath(validatedRuntime?.extensionHostPath ?? appNativeHostPath),
    browserClientPath: await realpath(browserClientPath),
    browserClientSha256: await sha256File(browserClientPath),
    browserServicePath: await realpath(browserServicePath),
    browserServiceSha256: await sha256File(browserServicePath),
    trustedCodePaths: validatedRuntime?.trustedCodePaths ?? [chromePluginPath],
    availableBackends: validatedRuntime?.availableBackends ?? "chrome",
    nativePipeConnectTimeoutMs: validatedRuntime?.nativePipeConnectTimeoutMs ?? "1000",
    buildFlavor: validatedRuntime?.buildFlavor ?? "prod",
    appServerProtocolVersion: validatedRuntime?.appServerProtocolVersion ?? null,
    nativeHostProtocolVersion: validatedRuntime?.nativeHostProtocolVersion ?? null,
    registryPath: validatedRuntime?.registryPath ?? null,'''
if old not in app:
    raise SystemExit("BrowserJack runtime return block no longer matches the pinned upstream commit")
app = app.replace(old, new, 1)
app_path.write_text(app)

old = '''interface ExtensionMetadata {
  extensionId: string;
  extensionHostName: string;
}'''
new = '''interface ExtensionMetadata {
  extensionId: string;
  extensionHostName: string;
  extensionIds: string[];
}'''
if old not in app:
    raise SystemExit("BrowserJack extension metadata type no longer matches the pinned upstream commit")
app = app.replace(old, new, 1)

old = '''  return {
    extensionId: requireString(value, "extensionId", source),
    extensionHostName: requireString(value, "extensionHostName", source),
  };'''
new = '''  if (Array.isArray(value.browserExtensions)) {
    const chromeEntries = value.browserExtensions.filter(
      (entry): entry is Record<string, unknown> =>
        isJsonObject(entry) && entry.browserFamily === "chrome",
    );
    if (chromeEntries.length !== 1) {
      throw new Error(`${source} must contain exactly one Chrome browser entry`);
    }
    const chrome = chromeEntries[0];
    if (chrome === undefined) {
      throw new Error(`${source} must contain a Chrome browser entry`);
    }
    const chromeIds = Array.isArray(chrome.extensionIds)
      ? chrome.extensionIds.map((id) => requireString({ extensionId: id }, "extensionId", source))
      : [];
    const extensionId = requireString(chrome, "storeExtensionId", source);
    if (!chromeIds.includes(extensionId)) {
      throw new Error(`${source} Chrome storeExtensionId is not one of the Chrome extension IDs`);
    }
    const extensionIds = Array.isArray(value.extensionIds)
      ? value.extensionIds.map((id) => requireString({ extensionId: id }, "extensionId", source))
      : chromeIds;
    if (!extensionIds.includes(extensionId)) {
      throw new Error(`${source} Chrome storeExtensionId is not included in extensionIds`);
    }
    return {
      extensionId,
      extensionHostName: requireString(value, "extensionHostName", source),
      extensionIds,
    };
  }
  const extensionId = requireString(value, "extensionId", source);
  return {
    extensionId,
    extensionHostName: requireString(value, "extensionHostName", source),
    extensionIds: [extensionId],
  };'''
if old not in app:
    raise SystemExit("BrowserJack extension metadata parser no longer matches the pinned upstream commit")
app = app.replace(old, new, 1)

old = '''  const extensionMetadataPath = join(chromePluginPath, "scripts", "extension-id.json");
  const extensionMetadata = parseExtensionMetadata(
    await readJsonFile(extensionMetadataPath),
    extensionMetadataPath,
  );'''
new = '''  const pluralExtensionMetadataPath = join(chromePluginPath, "scripts", "extension-ids.json");
  const extensionMetadataPath = join(chromePluginPath, "scripts", "extension-id.json");
  const extensionMetadata = (await exists(pluralExtensionMetadataPath))
    ? parseExtensionMetadata(await readJsonFile(pluralExtensionMetadataPath), pluralExtensionMetadataPath)
    : (await exists(extensionMetadataPath))
      ? parseExtensionMetadata(await readJsonFile(extensionMetadataPath), extensionMetadataPath)
      : {
          extensionId: process.env.BROWSERJACK_EXPERIMENT_EXTENSION_ID ?? "",
          extensionHostName: process.env.BROWSERJACK_EXPERIMENT_NATIVE_HOST_NAME ?? "",
          extensionIds: process.env.BROWSERJACK_EXPERIMENT_EXTENSION_ID
            ? [process.env.BROWSERJACK_EXPERIMENT_EXTENSION_ID]
            : [],
        };
  if (!extensionMetadata.extensionId || !extensionMetadata.extensionHostName) {
    throw new Error(`Missing ${pluralExtensionMetadataPath} and ${extensionMetadataPath} and no compatibility extension/native-host metadata was provided`);
  }'''
if old not in app:
    raise SystemExit("BrowserJack extension metadata block no longer matches the pinned upstream commit")
app = app.replace(old, new, 1)

app_path.write_text(app)

live = live_path.read_text()
old = '''  const child = spawn(launch.command, launch.args, {
    cwd: launch.runtime.codexHome,
    env: launch.env,
    shell: false,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });'''
new = '''  const child = spawn(launch.command, launch.args, {
    cwd: launch.runtime.codexHome,
    env: launch.env,
    shell: false,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let childStderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    childStderr = `${childStderr}${chunk}`.slice(-4096);
  });'''
if live.count(old) != 1:
    raise SystemExit("BrowserJack live child spawn no longer matches the pinned upstream commit")
live = live.replace(old, new, 1)

old = '''await bridgeDoctorClient.setupBrowserRuntime({ globals: globalThis })'''
new = '''globalThis.agent = await bridgeDoctorClient.setupBrowserRuntime()'''
if live.count(old) != 1:
    raise SystemExit("BrowserJack live runtime setup no longer matches the pinned upstream commit")
live = live.replace(old, new, 1)

old = '''        if (record.error !== undefined || result?.isError === true) {
          throw new Error("OpenAI browser runtime handshake failed");
        }'''
new = '''        if (record.error !== undefined || result?.isError === true) {
          const detail = JSON.stringify(record.error ?? record.result ?? {}).slice(0, 2000);
          throw new Error(`OpenAI browser runtime handshake failed: ${detail}`);
        }'''
if live.count(old) != 1:
    raise SystemExit("BrowserJack live error block no longer matches the pinned upstream commit")
live = live.replace(old, new, 1)

old = '''    if (!initialized || !toolsListed || !browserConnected) {
      throw new Error("Cold-start probe did not initialize the OpenAI browser runtime");
    }'''
new = '''    if (!initialized || !toolsListed || !browserConnected) {
      const detail = childStderr.trim();
      throw new Error(`Cold-start probe did not initialize the OpenAI browser runtime${detail ? `: ${detail}` : ""}`);
    }'''
if live.count(old) != 1:
    raise SystemExit("BrowserJack live cold-start error block no longer matches the pinned upstream commit")
live = live.replace(old, new, 1)

old = '''var bridgeDoctorBackends = await agent.browsers.list(); bridgeDoctorBackends.length'''
new = '''var bridgeDoctorBackends = await agent.browsers.list(); if (!Array.isArray(bridgeDoctorBackends) || bridgeDoctorBackends.length === 0) { throw new Error("No browser backends are connected"); } if (!bridgeDoctorBackends.some((backend) => backend.family === "chrome")) { await new Promise((resolveRetry) => setTimeout(resolveRetry, 2000)); bridgeDoctorBackends = await agent.browsers.list(); } if (!Array.isArray(bridgeDoctorBackends) || bridgeDoctorBackends.length === 0) { throw new Error("No browser backends are connected"); } if (!bridgeDoctorBackends.some((backend) => backend.family === "chrome")) { throw new Error("Chrome backend unavailable"); } bridgeDoctorBackends.length'''
if live.count(old) != 1:
    raise SystemExit("BrowserJack live backend check no longer matches the pinned upstream commit")
live = live.replace(old, new, 1)
live_path.write_text(live)

server = server_path.read_text()
old = '''import { pathToFileURL } from "node:url";'''
new = '''import { join } from "node:path";
import { pathToFileURL } from "node:url";'''
if old not in server:
    raise SystemExit("BrowserJack runtime URL imports no longer match the pinned upstream commit")
server = server.replace(old, new, 1)

old = '''    "Import that exact URL and call setupBrowserRuntime({ globals: globalThis }) before using agent.browsers.",'''
new = '''    "Import that exact URL and assign globalThis.agent = await setupBrowserRuntime() before using agent.browsers.",'''
if old not in server:
    raise SystemExit("BrowserJack runtime instructions no longer match the pinned upstream commit")
server = server.replace(old, new, 1)

old = '''  const browserClientUrl = pathToFileURL(launch.runtime.browserClientPath).href;'''
new = '''  const browserClientUrl = pathToFileURL(
    join(
      launch.runtime.appPath,
      "Contents",
      "Resources",
      "plugins",
      "openai-bundled",
      "plugins",
      "chrome",
      "scripts",
      "browser-client.mjs",
    ),
  ).href;'''
if old not in server:
    raise SystemExit("BrowserJack browser-client instruction URL no longer matches the pinned upstream commit")
server = server.replace(old, new, 1)
server_path.write_text(server)

types = types_path.read_text()
old = '''  browserClientSha256: string;
  cachedPluginPath?: string;'''
new = '''  browserClientSha256: string;
  browserServicePath: string;
  browserServiceSha256: string;
  extensionIds: string[];
  trustedCodePaths: string[];
  availableBackends: string;
  nativePipeConnectTimeoutMs: string;
  buildFlavor: string;
  appServerProtocolVersion: number | null;
  nativeHostProtocolVersion: number | null;
  registryPath: string | null;
  cachedPluginPath?: string;'''
if old not in types:
    raise SystemExit("BrowserJack runtime type block no longer matches the pinned upstream commit")
types_path.write_text(types.replace(old, new, 1))

launch = launch_path.read_text()
old = '''  return `permissions.claude_browser_node_repl.filesystem={${entries.join(",")}}`;'''
new = '''  return `permissions.claude_browser_node_repl={filesystem={${entries.join(",")}},network={enabled=true}}`;'''
if old not in launch:
    raise SystemExit("BrowserJack sandbox permission profile no longer matches the pinned upstream commit")
launch = launch.replace(old, new, 1)
old = '''      NODE_REPL_NODE_MODULE_DIRS: runtime.nodeModulesPath,
      NODE_REPL_NODE_PATH: runtime.nodePath,
      NODE_REPL_TRUSTED_CODE_PATHS: runtime.chromePluginPath,
      NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S: runtime.browserClientSha256,
      BROWSER_USE_AVAILABLE_BACKENDS: process.env.BROWSER_USE_AVAILABLE_BACKENDS ?? "chrome",
      CODEX_HOME: runtime.codexHome,
      CODEX_CLI_PATH: runtime.codexPath,'''
new = '''      NODE_REPL_NODE_MODULE_DIRS: runtime.nodeModulesPath,
      NODE_REPL_NODE_PATH: runtime.nodePath,
      NODE_REPL_TRUSTED_CODE_PATHS: runtime.trustedCodePaths.join(process.platform === "win32" ? ";" : ":"),
      NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S: runtime.browserClientSha256,
      NODE_REPL_TRUSTED_RPC_ENABLED: "1",
      NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ browser: runtime.browserServicePath }),
      NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: runtime.nativePipeConnectTimeoutMs,
      BROWSER_USE_AVAILABLE_BACKENDS: runtime.availableBackends,
      BROWSER_USE_TINYSKY_ENABLED: process.env.BROWSER_USE_TINYSKY_ENABLED ?? "0",
      BROWSER_USE_CODEX_APP_VERSION: runtime.appVersion,
      BROWSER_USE_CODEX_APP_BUILD_VERSION: runtime.buildVersion,
      BROWSER_USE_CODEX_APP_BUILD_FLAVOR: runtime.buildFlavor,
      CODEX_HOME: runtime.codexHome,
      CODEX_CLI_PATH: runtime.codexPath,'''
if old not in launch:
    raise SystemExit("BrowserJack launch environment block no longer matches the pinned upstream commit")
launch_path.write_text(launch.replace(old, new, 1))

launch_test = launch_test_path.read_text()
old = '''  browserClientSha256: "d".repeat(64),'''
new = '''  browserClientSha256: "d".repeat(64),
  browserServicePath: "/tmp/example/.codex/plugins/cache/openai-bundled/chrome/latest/scripts/browser-service.mjs",
  browserServiceSha256: "e".repeat(64),
  extensionIds: ["abcdefghijklmnop"],
  trustedCodePaths: ["/tmp/example/.codex/plugins/chrome", "/tmp/example/.codex/node_modules"],
  availableBackends: "chrome",
  nativePipeConnectTimeoutMs: "1000",
  buildFlavor: "prod",
  appServerProtocolVersion: 2,
  nativeHostProtocolVersion: 2,
  registryPath: "/tmp/example/registry.json",'''
if old not in launch_test:
    raise SystemExit("BrowserJack launch test runtime no longer matches the pinned upstream commit")
launch_test = launch_test.replace(old, new, 1)
old = '''  assert.equal(launch.env.NODE_REPL_TRUSTED_CODE_PATHS, runtime.chromePluginPath);'''
new = '''  assert.equal(launch.env.NODE_REPL_TRUSTED_CODE_PATHS, runtime.trustedCodePaths.join(":"));'''
if old not in launch_test:
    raise SystemExit("BrowserJack launch test trusted-code-path assertion no longer matches")
launch_test = launch_test.replace(old, new, 1)
marker = '''test("launches OpenAI's own binaries via codex sandbox", () => {'''
addition = '''test("enables the trusted browser RPC service from the validated runtime", () => {
  const launch = composeLaunch(runtime);
  assert.equal(launch.env.NODE_REPL_TRUSTED_RPC_ENABLED, "1");
  assert.deepEqual(JSON.parse(launch.env.NODE_REPL_TRUSTED_SERVICES), {
    browser: runtime.browserServicePath,
  });
  assert.equal(launch.env.NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S, runtime.browserClientSha256);
  assert.equal(launch.env.BROWSER_USE_AVAILABLE_BACKENDS, "chrome");
  const profile = launch.args[launch.args.indexOf("-c") + 1];
  assert.match(profile, /permissions\\.claude_browser_node_repl=\\{.*network=\\{enabled=true\\}/);
  assert.ok(launch.env.NODE_REPL_TRUSTED_CODE_PATHS.includes(runtime.trustedCodePaths[0]));
});

'''
if marker not in launch_test:
    raise SystemExit("BrowserJack launch test insertion point no longer matches")
launch_test_path.write_text(launch_test.replace(marker, addition + marker, 1))

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
    'import { join } from "node:path";',
    'import { dirname, isAbsolute, join } from "node:path";',
    1,
)
verified = verified.replace(
    '''function storePath(): string {
  return join(installationPaths().root, "verified-builds.json");
}''',
    '''function storePath(): string {
  const override = process.env.BROWSERJACK_VERIFIED_BUILDS_FILE;
  if (override !== undefined) {
    if (override.length === 0 || !isAbsolute(override)) {
      throw new Error("BROWSERJACK_VERIFIED_BUILDS_FILE must be a non-empty absolute path");
    }
    return override;
  }
  return join(installationPaths().root, "verified-builds.json");
}''',
    1,
)
verified = verified.replace(
    '  await mkdir(installationPaths().root, { recursive: true, mode: 0o700 });',
    '  await mkdir(dirname(path), { recursive: true, mode: 0o700 });',
    1,
)
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
marker = '''test("manifest-covered builds skip the self-test entirely", async (t) => {'''
addition = '''test("verified-build store honors an absolute override", async (t) => {
  await withTemporaryHome(t);
  const root = await mkdtemp(join(tmpdir(), "bj-verified-override-"));
  const path = join(root, "nested", "verified-builds.json");
  const previous = process.env.BROWSERJACK_VERIFIED_BUILDS_FILE;
  process.env.BROWSERJACK_VERIFIED_BUILDS_FILE = path;
  try {
    await recordVerifiedBuild({ ...(await supportedRuntime()), appVersion: "99.4.4" });
    assert.equal(JSON.parse(await readFile(path, "utf8")).schemaVersion, 1);
    for (const value of ["", "relative/verified-builds.json"]) {
      process.env.BROWSERJACK_VERIFIED_BUILDS_FILE = value;
      await assert.rejects(
        recordVerifiedBuild(await supportedRuntime()),
        /BROWSERJACK_VERIFIED_BUILDS_FILE must be a non-empty absolute path/,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.BROWSERJACK_VERIFIED_BUILDS_FILE;
    else process.env.BROWSERJACK_VERIFIED_BUILDS_FILE = previous;
  }
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
