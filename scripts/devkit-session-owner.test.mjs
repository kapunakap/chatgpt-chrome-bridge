import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script, createContext } from "node:vm";
import test from "node:test";
import {
  claimBridgeSession, devkitReadinessResult, fixedDevKitReadinessRequest,
  initializeDevKitSession, rejectHostedRequest, rejectUnsupportedChildRequest,
  sessionOwnerMode,
} from "./devkit-session-owner.mjs";

const readiness = () => ({ result: { content: [{ type: "text", text: JSON.stringify({
  owner: "devkit", chromeDiscovered: true, userBindingUsable: true, tabsApiUsable: true,
}) }] } });
const initialized = () => ({ result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture" } } });

test("exclusive ownership is explicit and requires the existing actions opt-in", () => {
  assert.equal(sessionOwnerMode({}), "hosted");
  assert.equal(sessionOwnerMode({ BROWSERJACK_DEVKIT_ACTIONS_ENABLED: "true" }), "hosted");
  assert.equal(sessionOwnerMode({ BROWSERJACK_DEVKIT_ACTIONS_ENABLED: "true", BROWSERJACK_DEVKIT_SESSION_OWNER: "devkit" }), "devkit");
  assert.throws(() => sessionOwnerMode({ BROWSERJACK_DEVKIT_SESSION_OWNER: "devkit" }), /OPT_IN/);
  assert.throws(() => sessionOwnerMode({ BROWSERJACK_DEVKIT_SESSION_OWNER: "other" }), /INVALID/);
});

test("cold start uses one ordinary handshake before fixed browser readiness and never supplies host metadata", async () => {
  const calls = []; let id = 0;
  const value = await initializeDevKitSession({
    requestId: () => ++id,
    notify: async message => { calls.push({ message }); },
    invoke: async (message, timeoutMs) => {
      calls.push({ message, timeoutMs });
      if (message.method === "initialize") return initialized();
      if (message.method === "tools/list") return { result: { tools: [{ name: "js" }] } };
      return readiness();
    },
  });
  assert.deepEqual(calls.map(call => call.message.method), ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
  assert.equal(value.owner, "devkit");
  assert.deepEqual(calls[0].message.params.capabilities, {});
  assert.deepEqual(calls.filter(call => call.timeoutMs).map(call => call.timeoutMs), [20000, 5000, 30000]);
  for (const call of calls) {
    const encoded = JSON.stringify(call.message);
    assert.ok(!encoded.includes('"_meta"'));
    assert.ok(!/installation_id|session_id|thread_id|turn_id|authorization/i.test(encoded));
  }
});

test("initialization errors and unsupported protocol stop without a retry or browser call", async () => {
  for (const response of [{ error: { message: "denied" } }, { result: { ...initialized().result, protocolVersion: "unknown" } }]) {
    const calls = [];
    await assert.rejects(initializeDevKitSession({
      requestId: () => 1, notify: async () => { throw Error("Unexpected notification"); },
      invoke: async message => { calls.push(message); return response; },
    }), /INITIALIZE_FAILED/);
    assert.deepEqual(calls.map(call => call.method), ["initialize"]);
  }
});

test("missing js capability never starts a browser operation", async () => {
  const calls = [];
  await assert.rejects(initializeDevKitSession({
    requestId: () => calls.length + 1, notify: async () => undefined,
    invoke: async message => { calls.push(message); return message.method === "initialize" ? initialized() : { result: { tools: [] } }; },
  }), /JS_TOOL_UNAVAILABLE/);
  assert.deepEqual(calls.map(call => call.method), ["initialize", "tools/list"]);
});

test("policy denials and ambiguous readiness never become a healthy owner", () => {
  assert.throws(() => devkitReadinessResult({ result: { content: [readiness().result.content[0], { type: "text", text: "Browser Use rejected this action" }] } }), /UNAVAILABLE/);
  assert.throws(() => devkitReadinessResult({ result: { isError: true, content: readiness().result.content } }), /UNAVAILABLE/);
  assert.throws(() => devkitReadinessResult({ result: { content: [...readiness().result.content, ...readiness().result.content] } }), /UNAVAILABLE/);
});

test("hosted requests cannot supply session data or receive browser results in exclusive mode", () => {
  const denial = rejectHostedRequest({ jsonrpc: "2.0", id: 8, method: "tools/call", params: {
    name: "js", arguments: { code: "PRIVATE_PAYLOAD" }, _meta: { "x-codex-turn-metadata": { session_id: "PRIVATE_SESSION" } },
  } });
  assert.equal(denial.id, 8);
  assert.equal(denial.error.code, -32003);
  assert.ok(!JSON.stringify(denial).includes("PRIVATE_"));
  assert.equal(rejectHostedRequest({ method: "notifications/initialized" }), null);
  assert.equal(rejectHostedRequest(null), null);
  assert.equal(rejectUnsupportedChildRequest({ id: 5, method: "elicitation/create", params: { message: "PRIVATE" } }).error.code, -32601);
  assert.equal(rejectUnsupportedChildRequest({ id: 5, result: { value: "PRIVATE" } }), null);
});

test("fixed readiness pins one observed Chrome and exposes only booleans, reusing that same binding", async () => {
  const seen = [], output = [];
  const browser = {
    user: { openTabs: async () => { seen.push("user-tabs"); return [{ title: "PRIVATE_TITLE" }]; } },
    tabs: { list: async () => { seen.push("owned-tabs"); return [{ url: "https://private.example/path" }]; } },
  };
  const runtime = { browsers: {
    list: async () => { seen.push("discover"); return [{ id: "exact-chrome", family: "chrome" }]; },
    get: async id => { seen.push(id); return browser; },
  } };
  const context = createContext({ agent: runtime, nodeRepl: { write: text => output.push(JSON.parse(text)) } });
  const code = fixedDevKitReadinessRequest(1).params.arguments.code;
  await new Script(`(async () => { ${code} })()`).runInContext(context);
  runtime.browsers.list = async () => { throw Error("Must preserve existing binding"); };
  await new Script(`(async () => { ${code} })()`).runInContext(context);
  assert.deepEqual(seen, ["discover", "exact-chrome", "user-tabs", "owned-tabs", "user-tabs", "owned-tabs"]);
  assert.equal(output.length, 2);
  assert.ok(output.every(value => value.owner === "devkit" && value.chromeDiscovered));
  assert.ok(!JSON.stringify(output).includes("PRIVATE"));
  assert.ok(!JSON.stringify(output).includes("private.example"));
});

test("ambiguous Chrome selection fails before binding any browser", async () => {
  let selected = false;
  const context = createContext({ agent: { browsers: {
    list: async () => [{ id: "a", family: "chrome" }, { id: "b", family: "chrome" }],
    get: async () => { selected = true; },
  } }, nodeRepl: { write: () => { throw Error("Unexpected readiness"); } } });
  await assert.rejects(new Script(`(async () => { ${fixedDevKitReadinessRequest(1).params.arguments.code} })()`).runInContext(context), /BROWSER_SELECTION_REQUIRED/);
  assert.equal(selected, false);
});

test("readiness rejects returned error text or structured errors from either tab API", async () => {
  for (const [userResult, ownedResult] of [
    ["Browser Use rejected this action", []],
    [{ error: "not available" }, []],
    [[], "Error: not available"],
    [[], { error: "not available" }],
  ]) {
    let reported = false;
    const browser = { user: { openTabs: async () => userResult }, tabs: { list: async () => ownedResult } };
    const context = createContext({ agent: { browsers: {
      list: async () => [{ id: "chrome", family: "chrome" }], get: async () => browser,
    } }, nodeRepl: { write: () => { reported = true; } } });
    await assert.rejects(new Script(`(async () => { ${fixedDevKitReadinessRequest(1).params.arguments.code} })()`).runInContext(context), /DEVKIT_OWNER_BROWSER_UNAVAILABLE/);
    assert.equal(reported, false);
  }
});

async function ownerDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "devkit-session-owner-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, "owner.lock") };
}

test("only one hosted or DevKit wrapper can own the runtime; release permits the next owner", async t => {
  const { path } = await ownerDirectory(t);
  const release = await claimBridgeSession({ path, mode: "hosted" });
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  await assert.rejects(claimBridgeSession({ path, mode: "devkit" }), /OCCUPIED/);
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.pid, process.pid);
  assert.deepEqual(Object.keys(saved).sort(), ["kind", "mode", "pid"]);
  await release();
  const next = await claimBridgeSession({ path, mode: "devkit" });
  await next();
});

test("foreign, insecure and replaced owner files are never removed", async t => {
  const { directory, path } = await ownerDirectory(t);
  await writeFile(path, "unrelated", { mode: 0o644 });
  await chmod(path, 0o644); // Test permissions independently of the caller's umask.
  await assert.rejects(claimBridgeSession({ path, mode: "devkit" }), /INSECURE/);
  assert.equal(await readFile(path, "utf8"), "unrelated");
  await chmod(path, 0o600);
  await assert.rejects(claimBridgeSession({ path, mode: "devkit" }), error =>
    error.message === "INSECURE_BRIDGE_OWNER_FILE" && !error.message.includes("unrelated"));
  assert.equal(await readFile(path, "utf8"), "unrelated");
  await rm(path);
  await symlink(join(directory, "target"), path);
  await assert.rejects(claimBridgeSession({ path, mode: "devkit" }), /INSECURE/);
  assert.equal((await lstat(path)).isSymbolicLink(), true);
  await rm(path);
  const release = await claimBridgeSession({ path, mode: "devkit" });
  const replacement = join(directory, "replacement");
  await writeFile(replacement, "replacement", { mode: 0o600 });
  await rename(replacement, path);
  await assert.rejects(release(), /CHANGED/);
  assert.equal(await readFile(path, "utf8"), "replacement");
});

test("a verified dead wrapper lock is recoverable without signalling another process", async t => {
  const { path } = await ownerDirectory(t);
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  await writeFile(path, JSON.stringify({ kind: "browserjack-session-owner-v1", pid: child.pid, mode: "hosted" }), { mode: 0o600 });
  const release = await claimBridgeSession({ path, mode: "devkit" });
  assert.equal(JSON.parse(await readFile(path, "utf8")).pid, process.pid);
  await release();
});

test("unsafe existing socket paths reject startup and release only the new lock", async t => {
  const { directory, path } = await ownerDirectory(t);
  const socketPath = join(directory, "health.sock");
  await writeFile(socketPath, "unrelated", { mode: 0o600 });
  await assert.rejects(claimBridgeSession({ path, mode: "devkit", socketPaths: [socketPath] }), /INSECURE_BRIDGE_SOCKET/);
  assert.equal(await readFile(socketPath, "utf8"), "unrelated");
  await assert.rejects(lstat(path), { code: "ENOENT" });
});

test("concurrent dead-owner recovery never grants more than one wrapper ownership", async t => {
  const { path } = await ownerDirectory(t);
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await writeFile(path, JSON.stringify({ kind: "browserjack-session-owner-v1", pid: child.pid, mode: "hosted" }), { mode: 0o600 });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => claimBridgeSession({ path, mode: "devkit" })));
    const owners = results.filter(result => result.status === "fulfilled");
    assert.equal(owners.length, 1, `Concurrent recovery attempt ${attempt} produced multiple owners`);
    assert.equal(JSON.parse(await readFile(path, "utf8")).pid, process.pid);
    await owners[0].value();
  }
});

test("an abandoned claim guard fails closed and is not deleted", async t => {
  const { path } = await ownerDirectory(t);
  await writeFile(path + ".claim", "preserve unknown claim", { mode: 0o600 });
  await assert.rejects(claimBridgeSession({ path, mode: "devkit" }), /OCCUPIED/);
  assert.equal(await readFile(path + ".claim", "utf8"), "preserve unknown claim");
  await assert.rejects(lstat(path), { code: "ENOENT" });
});
