import assert from "node:assert/strict";
import test from "node:test";

import {
  blockedResponse,
  generationChanged,
  isTransientBrowserFailure,
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

test("only browser availability failures are retryable", () => {
  assert.equal(isTransientBrowserFailure("Chrome backend unavailable"), true);
  assert.equal(isTransientBrowserFailure("No browser backends are connected"), true);
  assert.equal(isTransientBrowserFailure("sandbox-exec: sandbox_apply: Operation not permitted"), false);
  assert.equal(isTransientBrowserFailure("ChatGPT.app strict signature verification failed"), false);
  assert.equal(retryDelay(0), 2000);
  assert.equal(retryDelay(99), 60000);
});
