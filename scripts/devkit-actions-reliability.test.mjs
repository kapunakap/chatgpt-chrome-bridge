import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import test from "node:test";
import { browserActionResult, createDevKitActionHandler, fixedBrowserActionRequest } from "./devkit-actions.mjs";
import { consumeInternalResponse, invokeInternalRequest } from "./browserjack-internal-rpc.mjs";

const message = value => ({ result: { content: [{ type: "text", text: JSON.stringify(value) }] } });
const tick = () => new Promise(resolve => setImmediate(resolve));
class Client extends EventEmitter {
  constructor(handler, action) {
    super();
    this.response = new Promise(resolve => { this.resolveResponse = resolve; });
    handler(this);
    this.emit("data", Buffer.from(JSON.stringify(action)));
    this.emit("end");
  }
  end(value) { this.resolveResponse(JSON.parse(value)); this.emit("close"); }
  destroy() { this.emit("close"); }
}

test("an expired queued navigation never reaches the browser", async () => {
  let release;
  let calls = 0;
  const handler = createDevKitActionHandler({ actionTimeoutMs: 30, invoke: async () => {
    calls++;
    await new Promise(resolve => { release = resolve; });
    return message({ tabs: [] });
  }});
  const reading = new Client(handler, { op: "tabs_list", origins: ["https://example.com"] });
  await tick();
  const writing = new Client(handler, { op: "navigate", requestId: "expired", url: "https://example.com/" });
  assert.deepEqual(await reading.response, { error: "ACTION_DEADLINE_EXCEEDED" });
  assert.deepEqual(await writing.response, { error: "ACTION_DEADLINE_EXCEEDED" });
  release();
  await tick();
  assert.equal(calls, 1);
});

test("a disconnected queued navigation never reaches the browser", async () => {
  let release;
  let calls = 0;
  const handler = createDevKitActionHandler({ actionTimeoutMs: 200, invoke: async () => {
    calls++;
    await new Promise(resolve => { release = resolve; });
    return message({ tabs: [] });
  }});
  const reading = new Client(handler, { op: "tabs_list", origins: ["https://example.com"] });
  await tick();
  const writing = new Client(handler, { op: "navigate", requestId: "closed", url: "https://example.com/" });
  writing.destroy();
  release();
  await reading.response;
  await tick();
  assert.equal(calls, 1);
});

test("a failed navigation is not executed again with the same request ID", async () => {
  let calls = 0;
  const handler = createDevKitActionHandler({ invoke: async () => { calls++; throw Error("response lost"); } });
  const action = { op: "navigate", requestId: "lost-response", url: "https://example.com/" };
  assert.deepEqual(await new Client(handler, action).response, { error: "NAVIGATION_OUTCOME_UNKNOWN" });
  assert.deepEqual(await new Client(handler, action).response, { error: "NAVIGATION_OUTCOME_UNKNOWN" });
  assert.deepEqual(await new Client(handler, { ...action, url: "https://other.example/" }).response, { error: "REQUEST_CONFLICT" });
  assert.equal(calls, 1);
});

test("an in-flight navigation returns an unknown outcome at its total deadline", async () => {
  let release;
  const handler = createDevKitActionHandler({ actionTimeoutMs: 25, invoke: async () => {
    await new Promise(resolve => { release = resolve; });
    return message({ tabId: "opened", origin: "https://example.com", title: "Example" });
  }});
  const action = { op: "navigate", requestId: "late-success", url: "https://example.com/" };
  const client = new Client(handler, action);
  assert.deepEqual(await client.response, { error: "NAVIGATION_OUTCOME_UNKNOWN" });
  release();
  await tick();
  // A later verified receipt can be read, but this does not repeat navigation.
  assert.equal((await new Client(handler, action).response).tabId, "opened");
});

test("response bounds measure UTF-8 bytes and valid long URL requests are accepted", async () => {
  let seen;
  const handler = createDevKitActionHandler({ invoke: async request => {
    seen = request;
    return message({ tabId: "t1", origin: "https://example.com", title: "Example", text: "字".repeat(5000) });
  }});
  const response = await new Client(handler, { op: "read", tabId: "t1", origin: "https://example.com" }).response;
  assert.deepEqual(response, { error: "RESPONSE_TOO_LARGE" });
  const longHandler = createDevKitActionHandler({ invoke: async request => {
    seen = request;
    return message({ tabId: "t2", origin: "https://example.com", title: "Example" });
  }});
  const url = "https://example.com/" + "a".repeat(1500);
  assert.equal((await new Client(longHandler, { op: "navigate", requestId: "long", url }).response).tabId, "t2");
  assert.ok(seen.params.arguments.code.includes(url));
});

test("result parsing ignores unrelated diagnostics, rejects corruption and policy errors", () => {
  const good = { tabId: "t1", origin: "https://example.com", title: "Example", text: "- paragraph: Error: is a valid documentation topic" };
  const response = message(good);
  response.result.content.unshift({ type: "text", text: '{"diagnostic":"ready"}' });
  assert.equal(browserActionResult(response, "read").text, good.text);
  assert.throws(() => browserActionResult(message({ tabs: [{ id: 1, origin: "https://example.com", title: "Bad ID" }] }), "tabs_list"), /INVALID_BROWSER_RESULT/);
  assert.throws(() => browserActionResult(message({ ...good, text: "Error: Browser Use rejected this action due to browser security policy" }), "read"), /INVALID_BROWSER_RESULT/);
  response.result.content.push({ type: "text", text: '{"error":"denied"}' });
  assert.throws(() => browserActionResult(response, "read"), /INVALID_BROWSER_RESULT/);
  const mixed = message(good);
  mixed.result.content.push({ type: "text", text: "Error: Browser Use rejected this action due to browser security policy" });
  assert.throws(() => browserActionResult(mixed, "read"), /BROWSER_ACTION_FAILED/);
  const structured = message(good);
  structured.result.structuredContent = { error: "denied" };
  assert.throws(() => browserActionResult(structured, "read"), /BROWSER_ACTION_FAILED/);
});

function browserFixture({ snapshot = "- heading: Example Domain", candidates } = {}) {
  const selected = { id: "user-tab", url: "https://example.com/", title: "Example Domain" };
  const calls = { selections: 0, claims: [], navigate: 0, marked: 0, closed: 0 };
  const tab = {
    id: "opened-tab", url: async () => "https://example.com/", title: async () => "Example Domain",
    playwright: { domSnapshot: async () => snapshot },
    goto: async () => { calls.navigate++; }, markDeliverable: async () => { calls.marked++; },
    close: async () => { calls.closed++; },
  };
  const browser = {
    user: { openTabs: async () => [selected, { id: "ungranted", url: "https://private.example/", title: "Private" }], claimTab: async value => { calls.claims.push(value); return tab; } },
    tabs: { new: async () => tab, get: async () => tab, list: async () => [selected, ...(calls.marked ? [{ id: tab.id, url: "https://example.com/", title: "Example Domain" }] : [])] },
  };
  const context = vm.createContext({
    URL, Map, Date, agent: { browsers: {
      list: async () => candidates ?? [{ id: "chosen-chrome", family: "chrome" }],
      get: async id => { assert.equal(id, "chosen-chrome"); calls.selections++; return browser; },
    } },
    nodeRepl: { write: value => { context.output = JSON.parse(value); } },
  });
  return { selected, calls, tab, browser, context,
    async run(action, deadlineAt) {
      const request = fixedBrowserActionRequest("test", action, deadlineAt ? { deadlineAt } : undefined);
      await vm.runInContext("(async () => {" + request.params.arguments.code + "})()", context);
      return context.output;
    },
  };
}

test("fixed actions pin one browser, list granted user tabs and claim the exact selected tab", async () => {
  const fixture = browserFixture();
  const listed = await fixture.run({ op: "tabs_list", origins: ["https://example.com"] });
  assert.deepEqual(JSON.parse(JSON.stringify(listed)), { tabs: [{ id: "user-tab", origin: "https://example.com", title: "Example Domain" }] });
  const read = await fixture.run({ op: "read", tabId: "user-tab", origin: "https://example.com" });
  assert.equal(read.text, "- heading: Example Domain");
  assert.equal(fixture.calls.selections, 1);
  assert.equal(fixture.calls.claims[0], fixture.selected);
  await assert.rejects(fixture.run({ op: "read", tabId: "ungranted", origin: "https://example.com" }), /TAB_ORIGIN_DENIED/);
  assert.equal(fixture.calls.claims.length, 1);
  fixture.browser.tabs.list = async () => [{ id: "existing-controlled", url: "https://example.com/", title: "Example Domain" }];
  const controlledRead = await fixture.run({ op: "read", tabId: "existing-controlled", origin: "https://example.com" });
  assert.equal(controlledRead.tabId, "existing-controlled");
  assert.equal(fixture.calls.claims.length, 1);
});

test("fixed actions reject ambiguous browsers and non-DOM policy result text", async () => {
  const ambiguous = browserFixture({ candidates: [{ id: "one", family: "chrome" }, { id: "two", family: "chrome" }] });
  await assert.rejects(ambiguous.run({ op: "tabs_list", origins: ["https://example.com"] }), /BROWSER_SELECTION_REQUIRED/);
  assert.equal(ambiguous.calls.selections, 0);
  for (const snapshot of [{ error: "denied" }, "Error: Browser Use rejected this action due to browser security policy"]) {
    const fixture = browserFixture({ snapshot });
    await assert.rejects(fixture.run({ op: "read", tabId: "user-tab", origin: "https://example.com" }), /INVALID_BROWSER_SNAPSHOT/);
  }
});

test("fixed navigation checks its deadline before side effects and preserves a completed page", async () => {
  const fixture = browserFixture();
  await assert.rejects(fixture.run({ op: "navigate", requestId: "old", url: "https://example.com/" }, Date.now() - 1), /ACTION_DEADLINE_EXCEEDED/);
  assert.equal(fixture.calls.selections, 0);
  await fixture.run({ op: "navigate", requestId: "new", url: "https://example.com/" });
  assert.equal(fixture.calls.navigate, 1);
  assert.equal(fixture.calls.marked, 1);
  const listed = await fixture.run({ op: "tabs_list", origins: ["https://example.com"] });
  assert.deepEqual(Array.from(listed.tabs, tab => tab.id), ["user-tab", "opened-tab"]);
});

test("deadline expiring after tab creation prevents navigation and closes that new tab", async () => {
  const fixture = browserFixture();
  let now = 100;
  fixture.context.Date = { now: () => now };
  fixture.browser.tabs.new = async () => { now = 201; return fixture.tab; };
  await assert.rejects(fixture.run({ op: "navigate", requestId: "deadline", url: "https://example.com/" }, 200), /ACTION_DEADLINE_EXCEEDED/);
  assert.equal(fixture.calls.navigate, 0);
  assert.equal(fixture.calls.closed, 1);
});

test("late private responses are swallowed after timeout and never forwarded to hosted stdout", async () => {
  const pending = new Map(), reservedIds = new Set();
  const request = { jsonrpc: "2.0", id: 123456789, method: "tools/call", params: { name: "js", arguments: { code: "fixed" } } };
  const written = [];
  const child = { stdin: { write: (line, callback) => { written.push(JSON.parse(line)); callback(); } } };
  await assert.rejects(invokeInternalRequest({ child, request, pending, reservedIds, timeoutMs: 10 }), /timed out/);
  assert.equal(pending.size, 0);
  assert.equal(reservedIds.has(request.id), true);
  assert.equal(Object.hasOwn(written[0].params, "_meta"), false);
  assert.equal(consumeInternalResponse({ jsonrpc: "2.0", id: request.id, result: { secret: "must stay local" } }, pending, reservedIds), true);
  assert.equal(reservedIds.size, 0);
  assert.equal(consumeInternalResponse({ jsonrpc: "2.0", id: "hosted", result: {} }, pending, reservedIds), false);
});
