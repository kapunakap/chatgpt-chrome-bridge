import assert from "node:assert/strict";
import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = dirname(fileURLToPath(import.meta.url));
const supervisor = join(repoRoot, "browserjack-supervisor.mjs");

function snapshot(buildVersion, fingerprint, approved = true) {
  return {
    appVersion: "26.901.41600",
    buildVersion: String(buildVersion),
    pluginVersion: "26.901.41600",
    fingerprint,
    approved,
    extensionId: "a".repeat(32),
    extensionIds: ["a".repeat(32)],
    nativeHostName: "com.openai.codexextension",
    browserClientPath: "/tmp/fake/browser-client.mjs",
    browserServicePath: "/tmp/fake/browser-service.mjs",
    browserClientSha256: "b".repeat(64),
    browserServiceSha256: "c".repeat(64),
    nativeHostSha256: "d".repeat(64),
    availableBackends: "chrome",
    buildFlavor: "prod",
    nativePipeConnectTimeoutMs: "1000",
  };
}

async function makeFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "browserjack-upgrade-process-"));
  const statePath = join(root, "runtime-state.json");
  const loaderPath = join(root, "runtime-loader.mjs");
  const fingerprintModule = join(root, "fake-fingerprint.mjs");
  const runtimeModule = join(root, "fake-runtime.mjs");
  const fakeCli = join(root, "fake-browserjack.mjs");
  const sessionLog = join(root, "sessions.jsonl");
  const doctorMarker = join(root, "doctor-started");
  const approvalLog = join(root, "approvals.log");
  const initial = snapshot("1000", "a".repeat(64));

  await writeFile(statePath, JSON.stringify({
    mode: "approved",
    doctorDelayMs: 0,
    doctorFailure: false,
    snapshot: initial,
    runtime: { ...initial, codexHome: root },
  }));

  await writeFile(fingerprintModule, `
import { appendFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";

async function state() {
  return JSON.parse(await readFile(process.env.BROWSERJACK_TEST_STATE, "utf8"));
}

function rejectMode(value) {
  if (value === "missing-native-host") throw new Error("native host is missing");
  if (value === "mismatched-native-host") throw new Error("native host signature mismatch");
}

export async function inspectRuntime() {
  const current = await state();
  rejectMode(current.mode);
  return { ...current.snapshot, approved: current.mode !== "rejected-fingerprint" && current.snapshot.approved !== false };
}

export async function resolveRuntime({ allowUnapproved = false } = {}) {
  const current = await state();
  rejectMode(current.mode);
  if (current.mode === "rejected-fingerprint" && !allowUnapproved) {
    throw new Error("Unapproved browser runtime fingerprint: " + current.snapshot.fingerprint);
  }
  return { ...current.runtime };
}

export async function writeApproval(_path, _snapshot) {
  await appendFile(process.env.BROWSERJACK_TEST_APPROVAL_LOG, "approved\\n");
}
`);

  await writeFile(runtimeModule, `
export { resolveRuntime } from ${JSON.stringify(pathToFileURL(fingerprintModule).href)};
`);

  await writeFile(loaderPath, `
const fingerprint = ${JSON.stringify(pathToFileURL(fingerprintModule).href)};
const runtime = ${JSON.stringify(pathToFileURL(runtimeModule).href)};

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith("/scripts/browserjack-supervisor.mjs")) {
    if (specifier === "./browserjack-fingerprint.mjs") return { url: fingerprint, shortCircuit: true };
    if (specifier === "./browserjack-runtime.mjs") return { url: runtime, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`);

  await writeFile(fakeCli, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import readline from "node:readline";

const args = process.argv.slice(2);
const statePath = process.env.BROWSERJACK_TEST_STATE;
const sessionLog = process.env.BROWSERJACK_TEST_SESSION_LOG;

function state() {
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function log(value) {
  appendFileSync(sessionLog, JSON.stringify(value) + "\\n");
}

if (args.includes("doctor")) {
  const current = state();
  if (process.env.BROWSERJACK_TEST_DOCTOR_MARKER) writeFileSync(process.env.BROWSERJACK_TEST_DOCTOR_MARKER, "started\\n");
  if (current.doctorDelayMs) await delay(current.doctorDelayMs);
  if (current.doctorFailure) {
    process.stderr.write("rejected browser fingerprint\\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ ready: true, checks: [{ id: "live", status: "pass" }] }) + "\\n");
  process.exit(0);
}

if (args[0] !== "run") process.exit(0);
const session = { kind: "session-start", pid: process.pid, sessionId: "browserjack-" + process.pid };
log(session);
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "child/ready", params: { pid: process.pid } }) + "\\n");

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  log({ kind: "request", pid: process.pid, id: message.id, method: message.method });
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { instructions: "fake" } }) + "\\n");
  } else if (message.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "js", inputSchema: { type: "object" } }] } }) + "\\n");
  } else if (message.method === "tools/call" && message.id !== 99) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "fake browser action" }] } }) + "\\n");
  }
});
`);
  await chmod(fakeCli, 0o755);

  const children = new Set();
  t.after(async () => {
    for (const child of children) await stopProcess(child);
    await rm(root, { recursive: true, force: true });
  });

  return {
    root,
    statePath,
    loaderPath,
    fakeCli,
    sessionLog,
    doctorMarker,
    approvalLog,
    children,
  };
}

async function writeState(info, updates) {
  const current = JSON.parse(await readFile(info.statePath, "utf8"));
  await writeFile(info.statePath, JSON.stringify({ ...current, ...updates }));
}

function launch(info) {
  const child = spawn(process.execPath, [
    "--experimental-loader", info.loaderPath,
    supervisor, "--", info.fakeCli, "run",
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      CHATGPT_APP_PATH: join(info.root, "ChatGPT.app"),
      BROWSERJACK_MANIFEST_PATH: join(info.root, "manifest.json"),
      BROWSERJACK_APPROVAL_FILE: join(info.root, "approvals.json"),
      BROWSERJACK_RUNTIME_POLL_MS: "1000",
      BROWSERJACK_TEST_STATE: info.statePath,
      BROWSERJACK_TEST_SESSION_LOG: info.sessionLog,
      BROWSERJACK_TEST_DOCTOR_MARKER: info.doctorMarker,
      BROWSERJACK_TEST_APPROVAL_LOG: info.approvalLog,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = [];
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    for (const line of chunk.split("\n").filter(Boolean)) {
      try { lines.push(JSON.parse(line)); } catch { /* diagnostics are ignored */ }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const run = { child, lines, logPath: info.sessionLog, get stderr() { return stderr; } };
  info.children.add(child);
  return run;
}

function waitFor(predicate, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for simulated upgrade state")), timeoutMs);
    const poll = async () => {
      let value;
      try { value = await predicate(); } catch (error) { clearTimeout(timer); reject(error); return; }
      if (value) { clearTimeout(timer); resolve(value); return; }
      setTimeout(poll, 20);
    };
    poll();
  });
}

function waitForResponse(run, id) {
  return waitFor(() => run.lines.find((message) => message.id === id), 20_000).catch(async (error) => {
    let log = "";
    try { log = await readFile(run.logPath, "utf8"); } catch { /* no log yet */ }
    throw new Error(`${error.message}; stderr=${run.stderr}; lines=${JSON.stringify(run.lines)}; child=${run.child.exitCode}/${run.child.signalCode}; log=${log}`);
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    waitForExit(child),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function readJsonLines(path) {
  let source = "";
  try { source = await readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  return source.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

function send(child, message) {
  child.stdin.write(JSON.stringify(message) + "\n");
}

test("compatible generation replacement uses a fresh supervisor and BrowserJack session", async (t) => {
  const info = await makeFixture(t);
  const first = launch(info);
  await waitFor(() => first.lines.some((message) => message.method === "child/ready"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  send(first.child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal((await waitForResponse(first, 1)).result.instructions, "fake");
  send(first.child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  send(first.child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  await waitForResponse(first, 2);
  send(first.child, {
    jsonrpc: "2.0",
    id: 98,
    method: "tools/call",
    params: {
      name: "js",
      arguments: {
        code: 'await import("file:///tmp/test/.codex/plugins/cache/openai-bundled/chrome/26.901.20858/scripts/browser-client.mjs")',
      },
    },
  });
  const staleImport = await waitForResponse(first, 98);
  assert.equal(staleImport.result?.isError, true);
  assert.match(staleImport.result.content[0].text, /Current verified browser bootstrap/);
  assert.equal((await readJsonLines(info.sessionLog)).some((entry) => entry.kind === "request" && entry.id === 98), false);
  send(first.child, { jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "js", arguments: { code: "old action" } } });
  await waitFor(() => readJsonLines(info.sessionLog).then((entries) => entries.some((entry) => entry.kind === "request" && entry.id === 99)));

  const nextSnapshot = snapshot("1001", "e".repeat(64));
  await writeState(info, {
    mode: "compatible-pending",
    doctorDelayMs: 2_000,
    doctorFailure: false,
    snapshot: nextSnapshot,
    runtime: { ...nextSnapshot, codexHome: info.root },
  });
  await waitFor(() => readFile(info.doctorMarker, "utf8").then(() => true, () => false));

  send(first.child, { jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "js", arguments: { code: "must be blocked" } } });
  const blockedDuringValidation = await waitForResponse(first, 100);
  assert.equal(blockedDuringValidation.error?.code, -32001, `${JSON.stringify(blockedDuringValidation)} stderr=${first.stderr}`);
  const firstExit = await waitForExit(first.child);
  assert.equal(firstExit.code, 0);
  assert.equal(first.lines.filter((message) => message.id === 99).length, 1);
  assert.equal(first.lines.filter((message) => message.id === 100).length, 1);
  assert.match(first.lines.find((message) => message.id === 99).error.message, /fresh MCP session/);

  const second = launch(info);
  send(second.child, { jsonrpc: "2.0", id: 10, method: "initialize", params: {} });
  await waitForResponse(second, 10);
  send(second.child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  send(second.child, { jsonrpc: "2.0", id: 11, method: "tools/list", params: {} });
  await waitForResponse(second, 11);
  send(second.child, { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "js", arguments: { code: "new action" } } });
  await waitForResponse(second, 12);

  const sessions = (await readJsonLines(info.sessionLog)).filter((entry) => entry.kind === "session-start");
  assert.equal(sessions.length, 2);
  assert.notEqual(first.child.pid, second.child.pid);
  assert.notEqual(sessions[0].pid, sessions[1].pid);
  const secondRequests = (await readJsonLines(info.sessionLog)).filter(
    (entry) => entry.kind === "request" && entry.pid === sessions[1].pid,
  );
  assert.equal(secondRequests.some((entry) => entry.id === 99), false);
  await stopProcess(second.child);
});

test("missing hosts, mismatches, and rejected fingerprints stay fail-closed", async (t) => {
  const info = await makeFixture(t);
  const cases = [
    ["missing-native-host", 201],
    ["mismatched-native-host", 202],
    ["rejected-fingerprint", 203],
  ];
  for (const [mode, id] of cases) {
    const rejected = snapshot("2000", "f".repeat(64), mode !== "rejected-fingerprint");
    await writeState(info, {
      mode,
      doctorDelayMs: 0,
      doctorFailure: mode === "rejected-fingerprint",
      snapshot: rejected,
      runtime: { ...rejected, codexHome: info.root },
    });
    const run = launch(info);
    await waitFor(() => run.stderr.includes("Local Chrome blocked"));
    send(run.child, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "js", arguments: { code: "blocked" } } });
    const response = await waitForResponse(run, id);
    assert.equal(response.error?.code, -32001);
    assert.equal((await readJsonLines(info.sessionLog)).some((entry) => entry.kind === "request" && entry.id === id), false);
    assert.equal(run.child.exitCode, null);
    await stopProcess(run.child);
  }
});
