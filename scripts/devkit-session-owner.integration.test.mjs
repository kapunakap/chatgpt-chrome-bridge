/**
 * Synthetic wrapper wiring only. Runs no OpenAI runtime and no real browser.
 * The fake verified launcher and socket paths exist only in a fixture checkout.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceScripts = dirname(fileURLToPath(import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const shellQuote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";

async function waitFor(check, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(15);
  }
  throw Error(message);
}

async function fixture(t, { badReadiness = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "devkit-owner-fixture-"));
  // Keep Unix paths under the macOS sockaddr_un length limit.
  const sockets = await mkdtemp("/tmp/dko-");
  await chmod(sockets, 0o700);
  const scripts = join(root, "scripts");
  await mkdir(scripts);
  const health = join(sockets, "health.sock"), actions = join(sockets, "actions.sock");
  const ownerLock = join(sockets, "browserjack-session-owner.lock");
  const log = join(root, "synthetic-protocol.jsonl"), release = join(root, "release-readiness");
  for (const name of ["devkit-session-owner.mjs", "browserjack-internal-rpc.mjs", "devkit-actions.mjs"]) {
    await copyFile(join(sourceScripts, name), join(scripts, name));
  }
  let wrapper = await readFile(join(sourceScripts, "browserjack-discovery-compat.mjs"), "utf8");
  const healthDeclaration = 'const healthSocketPath = process.env.BROWSERJACK_HEALTH_SOCKET ?? join(\n  homedir(),\n  ".config/chatgpt-browser-bridge/browserjack-live-health.sock",\n);';
  const actionDeclaration = 'const devkitSocketPath = join(homedir(), ".config/chatgpt-browser-bridge/devkit-actions.sock");';
  assert.ok(wrapper.includes(healthDeclaration) && wrapper.includes(actionDeclaration));
  // Dependency-path rebinding in the copied fixture only. Runtime logic and the
  // production no-override launcher check are copied unchanged.
  wrapper = wrapper.replace(healthDeclaration, `const healthSocketPath = ${JSON.stringify(health)};`)
    .replace(actionDeclaration, `const devkitSocketPath = ${JSON.stringify(actions)};`);
  await writeFile(join(scripts, "browserjack-discovery-compat.mjs"), wrapper);
  const runtime = join(scripts, "synthetic-runtime.mjs");
  await writeFile(runtime, `
import { appendFile, access } from "node:fs/promises";
import { createInterface } from "node:readline";
const log = ${JSON.stringify(log)}, release = ${JSON.stringify(release)};
const badReadiness = ${badReadiness};
const record = value => appendFile(log, JSON.stringify(value) + "\\n");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
await record({ synthetic: true, event: "started", arguments: process.argv.slice(2) });
send({ jsonrpc: "2.0", method: "synthetic/private-notification", params: { text: "PRIVATE_NATIVE_RESULT" } });
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  await record(message);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "synthetic-owner-fixture" } } });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "js" }] } });
  } else if (message.method === "tools/call") {
    await record({ synthetic: true, event: "readiness-reached" });
    if (!badReadiness) {
      const deadline = Date.now() + 5000;
      while (true) {
        try { await access(release); break; } catch {}
        if (Date.now() >= deadline) process.exit(9);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify({ owner: "devkit", chromeDiscovered: true, userBindingUsable: true, tabsApiUsable: !badReadiness }) }] } });
  }
}
`);
  const launcher = join(scripts, "browserjack-current.sh");
  await writeFile(launcher, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(runtime)} "$@"\n`, { mode: 0o700 });
  const environment = { ...process.env, BROWSERJACK_DEVKIT_SESSION_OWNER: "devkit", BROWSERJACK_DEVKIT_ACTIONS_ENABLED: "true" };
  delete environment.BROWSERJACK_DISCOVERY_UPSTREAM;
  const child = spawn(process.execPath, [join(scripts, "browserjack-discovery-compat.mjs"), "run"], {
    cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", value => { stdout += value; });
  child.stderr.on("data", value => { stderr += value; });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    let timer;
    try {
      await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => { child.kill("SIGKILL"); reject(Error("Synthetic wrapper did not stop")); }, 3000);
      })]);
    } finally { clearTimeout(timer); }
    await rm(root, { recursive: true, force: true });
    await rm(sockets, { recursive: true, force: true });
  });
  return {
    child, exited, health, actions, ownerLock, release,
    output: () => ({ stdout, stderr }),
    records: async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
  };
}

async function healthProbe(path) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let result = "";
    socket.setTimeout(2000, () => { socket.destroy(); reject(Error("Synthetic health response timed out")); });
    socket.once("connect", () => socket.end('{"op":"probe"}'));
    socket.on("data", value => { result += value; });
    socket.once("end", () => resolve(JSON.parse(result)));
    socket.once("error", reject);
  });
}

test("synthetic exclusive wrapper initializes once, gates sockets, and rejects hosted metadata without leaking private output", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await waitFor(async () => (await f.records()).some(value => value.event === "readiness-reached"), "Synthetic owner never reached readiness");
  await assert.rejects(lstat(f.health), { code: "ENOENT" });
  await assert.rejects(lstat(f.actions), { code: "ENOENT" });
  f.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 71, method: "initialize", params: { _meta: { "x-codex-turn-metadata": { session_id: "PRIVATE_HOST_SESSION" } } } }) + "\n");
  f.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 72, method: "tools/call", params: { name: "js", arguments: { code: "PRIVATE_HOST_PAYLOAD" } } }) + "\n");
  await waitFor(() => f.output().stdout.includes('"id":72'), "Hosted request did not receive an explicit refusal");
  await writeFile(f.release, "synthetic readiness may finish\n");
  await waitFor(async () => (await lstat(f.health).catch(() => null))?.isSocket() && (await lstat(f.actions).catch(() => null))?.isSocket(), "Sockets were not published after valid readiness");
  assert.deepEqual(await healthProbe(f.health), { ok: true, chromeDiscovered: true, userBindingUsable: true, tabsApiUsable: true });
  const records = await f.records();
  const methods = records.filter(value => value.method).map(value => value.method);
  assert.deepEqual(methods.slice(0, 4), ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
  assert.equal(methods.filter(method => method === "initialize").length, 1);
  assert.ok(!JSON.stringify(records).includes("PRIVATE_HOST_"));
  assert.ok(!JSON.stringify(records).includes('"_meta"'));
  const output = f.output();
  assert.ok(!output.stdout.includes("PRIVATE_NATIVE_RESULT"));
  assert.ok(!output.stdout.includes("chromeDiscovered"));
  const replies = output.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(replies.map(reply => [reply.id, reply.error?.code]), [[71, -32003], [72, -32003]]);
  // A local health client that never finishes its input must not hold shutdown
  // or the owner lock open after the child has exited.
  const held = [createConnection(f.health), createConnection(f.actions)];
  held.forEach(socket => socket.on("error", () => undefined));
  await Promise.all(held.map(socket => once(socket, "connect")));
  const heldClosed = Promise.all(held.map(socket => new Promise(resolve => socket.once("close", resolve))));
  f.child.kill("SIGTERM");
  await f.exited;
  await heldClosed;
  await assert.rejects(lstat(f.ownerLock), { code: "ENOENT" });
  await assert.rejects(lstat(f.health), { code: "ENOENT" });
  await assert.rejects(lstat(f.actions), { code: "ENOENT" });
});

test("synthetic exclusive wrapper fails and releases its owner before publishing sockets on bad readiness", { timeout: 10000 }, async t => {
  const f = await fixture(t, { badReadiness: true });
  const result = await f.exited;
  assert.equal(result.code, 1);
  assert.match(f.output().stderr, /DEVKIT_OWNER_BROWSER_UNAVAILABLE/);
  assert.ok(!f.output().stderr.includes("ready=true"));
  assert.equal(f.output().stdout, "");
  await assert.rejects(lstat(f.health), { code: "ENOENT" });
  await assert.rejects(lstat(f.actions), { code: "ENOENT" });
  await assert.rejects(lstat(f.ownerLock), { code: "ENOENT" });
  const records = await f.records();
  assert.equal(records.filter(value => value.event === "started").length, 1);
  assert.deepEqual(records.filter(value => value.method).map(value => value.method), ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
});
