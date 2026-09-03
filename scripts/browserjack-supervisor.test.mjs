import assert from "node:assert/strict";
import test from "node:test";

import {
  blockedResponse,
  generationChanged,
  isTransientBrowserFailure,
  initializationError,
  mcpMessageDisposition,
  pendingMcpMessageFits,
  replayInitialization,
  retryDelay,
  runtimeGeneration,
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
