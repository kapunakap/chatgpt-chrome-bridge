import assert from "node:assert/strict";
import { mkdtemp, lstat, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { browserActionResult, createDevKitActionServer, fixedBrowserActionRequest,
  publicOrigin, validateDevKitAction } from "./devkit-actions.mjs";

async function fixture(check) {
  const dir = await mkdtemp(join(tmpdir(), "devkit-browser-actions-"));
  const path = join(dir, "actions.sock");
  let calls = 0;
  const instance = await createDevKitActionServer({ socketPath: path, invoke: async request => {
    calls++;
    const encoded = /const request = ([^;]+);/.exec(request.params.arguments.code)?.[1];
    assert.ok(encoded);
    const action = JSON.parse(encoded);
    const result = action.op === "tabs_list"
      ? { tabs: [{ id: "a1", origin: "https://example.com", title: "Example" }] }
      : action.op === "read"
        ? { tabId: action.tabId, origin: action.origin, title: "Example", text: "Untrusted page text" }
        : { tabId: "a2", origin: publicOrigin(action.url), title: "Example" };
    return { result: { content: [{ type: "text", text: JSON.stringify(result) }] } };
  }});
  const call = value => new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = "";
    socket.on("connect", () => socket.end(JSON.stringify(value)));
    socket.on("data", chunk => buffer += chunk.toString());
    socket.on("end", () => { try { resolve(JSON.parse(buffer)); } catch (error) { reject(error); } });
    socket.on("error", reject);
  });
  try { await check({ call, path, calls: () => calls }); }
  finally { await instance.close(); await rm(dir, { force: true, recursive: true }); }
}

test("socket is private, reports only allowed operations and does not forward caller JavaScript", async () => {
  await fixture(async ({ call, path }) => {
    assert.equal((await lstat(path)).mode & 0o077, 0);
    const result = await call({ op: "tabs_list" });
    assert.deepEqual(result, { tabs: [{ id: "a1", origin: "https://example.com", title: "Example" }] });
    assert.deepEqual(await call({ op: "js", code: "process.exit(1)" }), { error: "INVALID_REQUEST" });
    assert.deepEqual(await call({ op: "navigate", requestId: "test", url: "file:///etc/passwd" }), { error: "URL_NOT_ALLOWED" });
    assert.deepEqual(await call({ op: "navigate", requestId: "test", url: "https://example.com/?key=abc" }), { error: "URL_NOT_ALLOWED" });
  });
});

test("reads scoped origin and creates a new tab, deduplicates requestId", async () => {
  await fixture(async ({ call, calls }) => {
    assert.equal((await call({ op: "read", tabId: "a1", origin: "https://example.com" })).text, "Untrusted page text");
    assert.deepEqual(await call({ op: "read", tabId: "a1", origin: "http://example.com" }), { error: "URL_NOT_ALLOWED" });
    const input = { op: "navigate", requestId: "req1", url: "https://example.com/" };
    const one = await call(input);
    assert.deepEqual(one, { tabId: "a2", origin: "https://example.com", title: "Example" });
    assert.deepEqual(await call(input), one);
    assert.equal(calls(), 2);
    assert.deepEqual(await call({ ...input, url: "https://other.example/" }), { error: "REQUEST_CONFLICT" });
  });
});

test("fixed tool code has no caller-supplied JavaScript path", () => {
  assert.throws(() => validateDevKitAction({ op: "tabs_list", js: "bad" }), /INVALID_REQUEST/);
  const req = fixedBrowserActionRequest("uuid", { op: "navigate", requestId: "abc", url: "https://example.com/foo" });
  assert.equal(req.method, "tools/call");
  assert.equal(req.params.name, "js");
  assert.match(req.params.arguments.code, /tabs.new/);
  assert.throws(() => browserActionResult({ result: { content: [{ type: "text", text: "x" }] } }, "read"), /INVALID_BROWSER_RESULT/);
});