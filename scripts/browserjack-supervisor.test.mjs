import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applySuccessfulRevalidation,
  blockedResponse,
  canPollRuntime,
  generationChanged,
  isTransientBrowserFailure,
  initializationError,
  mcpMessageDisposition,
  pendingMcpMessageFits,
  replayInitialization,
  retryDelay,
  runtimeChangeStamp,
  runtimeGeneration,
  runtimeInspectionReason,
  shouldRevalidateRuntime,
} from "./browserjack-supervisor.mjs";

const runtime = {
  fingerprint: "a".repeat(64),
  appVersion: "26.831.21537",
  buildVersion: "7579",
  pluginVersion: "26.831.21537",
  extensionIds: ["chrome", "edge"],
};

test("runtime generation includes content and app build identity", () => {
  assert.equal(generationChanged(runtime, { ...runtime }), false);
  assert.equal(generationChanged(runtime, { ...runtime, buildVersion: "7580" }), true);
  assert.equal(generationChanged(runtime, { ...runtime, fingerprint: "b".repeat(64) }), true);
  assert.equal(generationChanged(runtime, { ...runtime, extensionIds: ["chrome"] }), true);
});

test("unchanged generation stays in the current supervisor process", () => {
  assert.equal(shouldRevalidateRuntime({
    activeSnapshot: runtime,
    currentSnapshot: { ...runtime },
  }), false);
});

test("idle polling skips expensive inspection until a change, retry, or safety interval", () => {
  const base = {
    previousStamp: "same",
    currentStamp: "same",
    lastInspectionAt: 10_000,
    fullInspectionMs: 300_000,
    now: 15_000,
  };
  assert.equal(runtimeInspectionReason(base), null);
  assert.equal(runtimeInspectionReason({ ...base, currentStamp: "changed" }), "change");
  assert.equal(runtimeInspectionReason({
    ...base,
    blockedRetryable: true,
    blockedRetryAt: 20_000,
  }), null);
  assert.equal(runtimeInspectionReason({
    ...base,
    blockedRetryable: true,
    blockedRetryAt: 15_000,
  }), "retry");
  assert.equal(runtimeInspectionReason({ ...base, now: 310_000 }), "periodic");
});

test("slow runtime inspections cannot overlap", () => {
  assert.equal(canPollRuntime({ inspectionInFlight: true }), false);
  assert.equal(canPollRuntime({ transitioning: true }), false);
  assert.equal(canPollRuntime({ stopping: true }), false);
  assert.equal(canPollRuntime({}), true);
});

test("runtime change stamp notices critical runtime file changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "browserjack-supervisor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appPath = join(root, "ChatGPT.app");
  const pluginPath = join(appPath, "Contents/Resources/plugins/openai-bundled/plugins/chrome");
  const bundledHostDir = join(pluginPath, "extension-host/macos", process.arch);
  await mkdir(join(appPath, "Contents/MacOS"), { recursive: true });
  await mkdir(join(appPath, "Contents/_CodeSignature"), { recursive: true });
  await mkdir(join(pluginPath, ".codex-plugin"), { recursive: true });
  await mkdir(join(pluginPath, "scripts"), { recursive: true });
  await mkdir(bundledHostDir, { recursive: true });

  const files = [
    [join(appPath, "Contents/Info.plist"), "plist"],
    [join(appPath, "Contents/MacOS/ChatGPT"), "app"],
    [join(appPath, "Contents/_CodeSignature/CodeResources"), "signature"],
    [join(pluginPath, ".codex-plugin/plugin.json"), "{}"],
    [join(pluginPath, "scripts/extension-ids.json"), "{}"],
    [join(pluginPath, "scripts/browser-client.mjs"), "client"],
    [join(pluginPath, "scripts/browser-service.mjs"), "service"],
    [join(bundledHostDir, "ChatGPT for Chrome"), "bundled-host"],
  ];
  for (const [path, content] of files) await writeFile(path, content);

  const nativeHostPath = join(root, "installed-native-host");
  const manifestPath = join(root, "manifest.json");
  await writeFile(nativeHostPath, "installed-host");
  await writeFile(manifestPath, JSON.stringify({ path: nativeHostPath }));

  const before = await runtimeChangeStamp({ appPath, manifestPath });
  const unchanged = await runtimeChangeStamp({ appPath, manifestPath });
  assert.equal(unchanged, before);

  await writeFile(join(pluginPath, "scripts/browser-client.mjs"), "client-changed-content");
  const after = await runtimeChangeStamp({ appPath, manifestPath });
  assert.notEqual(after, before);
});

test("compatible generation change requests an outer restart without replacement or replay", async () => {
  let outerRestarts = 0;
  let replacements = 0;
  let replays = 0;
  const action = await applySuccessfulRevalidation(
    runtime,
    { ...runtime, buildVersion: "7580" },
    {
      requestOuterRestart: async () => { outerRestarts += 1; },
      restartChildInProcess: async () => {
        replacements += 1;
        replays += 1;
      },
    },
  );

  assert.equal(action, "restart-outer");
  assert.equal(outerRestarts, 1);
  assert.equal(replacements, 0);
  assert.equal(replays, 0);
});

test("incompatible generation remains blocked without an outer restart loop", () => {
  const changed = { ...runtime, buildVersion: "7580" };
  const changedGeneration = runtimeGeneration(changed);
  assert.equal(shouldRevalidateRuntime({
    activeSnapshot: runtime,
    currentSnapshot: changed,
  }), true);
  assert.equal(shouldRevalidateRuntime({
    activeSnapshot: runtime,
    currentSnapshot: changed,
    blockedGeneration: changedGeneration,
    blockedRetryable: false,
  }), false);
});

test("ordinary same-generation child crash retries and restarts in-process", async () => {
  const retryAt = 5_000;
  const generation = runtimeGeneration(runtime);
  assert.equal(shouldRevalidateRuntime({
    activeSnapshot: runtime,
    currentSnapshot: { ...runtime },
    blockedGeneration: generation,
    blockedRetryable: true,
    blockedRetryAt: retryAt,
    now: retryAt - 1,
  }), false);
  assert.equal(shouldRevalidateRuntime({
    activeSnapshot: runtime,
    currentSnapshot: { ...runtime },
    blockedGeneration: generation,
    blockedRetryable: true,
    blockedRetryAt: retryAt,
    now: retryAt,
  }), true);

  let outerRestarts = 0;
  let replacements = 0;
  const action = await applySuccessfulRevalidation(runtime, { ...runtime }, {
    requestOuterRestart: async () => { outerRestarts += 1; },
    restartChildInProcess: async () => { replacements += 1; },
  });
  assert.equal(action, "restart-child");
  assert.equal(outerRestarts, 0);
  assert.equal(replacements, 1);
});

test("blocked supervisor requests return JSON-RPC errors and ignore notifications", () => {
  const response = blockedResponse(
    JSON.stringify({ jsonrpc: "2.0", id: "request-1", method: "tools/list", params: {} }),
    "runtime is not approved",
  );
  assert.deepEqual(JSON.parse(response), {
    jsonrpc: "2.0",
    id: "request-1",
    error: { code: -32001, message: "Local Chrome is unavailable: runtime is not approved" },
  });
  assert.equal(blockedResponse(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), "blocked"), null);
  assert.equal(blockedResponse("not json", "blocked"), null);
});

test("pre-initialization calls are buffered and initialization is prioritized", () => {
  assert.equal(mcpMessageDisposition("awaiting-init", { method: "tools/call", id: 0 }), "buffer");
  assert.equal(mcpMessageDisposition("awaiting-init", { method: "initialize", id: 1 }), "initialize");
  assert.equal(mcpMessageDisposition("initializing", { method: "notifications/initialized" }), "initialized");
  assert.equal(mcpMessageDisposition("ready", { method: "tools/call", id: 0 }), "forward");
});

test("initialization queue bounds and replay preserve request parameters", () => {
  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test" } },
  });
  const replayed = JSON.parse(replayInitialization(initialize, "internal-1"));
  assert.equal(replayed.id, "internal-1");
  assert.equal(replayed.method, "initialize");
  assert.deepEqual(replayed.params, JSON.parse(initialize).params);
  assert.equal(pendingMcpMessageFits(31, 0, "{}"), true);
  assert.equal(pendingMcpMessageFits(32, 0, "{}"), false);
  assert.equal(pendingMcpMessageFits(0, 1_048_576, "{}"), false);
  assert.throws(() => replayInitialization('{"method":"tools/call"}', "internal-2"));
});

test("buffered requests receive bounded JSON-RPC initialization errors", () => {
  const response = initializationError(
    JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/call", params: {} }),
    "initialization timed out",
  );
  assert.deepEqual(JSON.parse(response), {
    jsonrpc: "2.0",
    id: 0,
    error: { code: -32002, message: "MCP initialization is pending: initialization timed out" },
  });
  assert.equal(initializationError('{"jsonrpc":"2.0","method":"notifications/initialized"}', "blocked"), null);
});

test("only browser availability failures are retryable", () => {
  assert.equal(isTransientBrowserFailure("Chrome backend unavailable"), true);
  assert.equal(isTransientBrowserFailure("No browser backends are connected"), true);
  assert.equal(isTransientBrowserFailure("sandbox-exec: sandbox_apply: Operation not permitted"), false);
  assert.equal(isTransientBrowserFailure("ChatGPT.app strict signature verification failed"), false);
  assert.equal(retryDelay(0), 2000);
  assert.equal(retryDelay(99), 60000);
});
