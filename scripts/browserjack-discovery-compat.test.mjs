#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const wrapper = resolve(scriptsRoot, "browserjack-discovery-compat.mjs");
const repoRoot = resolve(scriptsRoot, "..");
let socketSequence = 0;

async function makeFakeChild(t) {
  const directory = await mkdtemp(join(tmpdir(), "browserjack-discovery-compat-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  socketSequence += 1;
  const socketDirectory = join(repoRoot, ".git", `bj-health-${process.pid}-${socketSequence}`);
  await mkdir(socketDirectory, { mode: 0o700 });
  t.after(() => rm(socketDirectory, { recursive: true, force: true }));
  const childPath = join(directory, "fake-browserjack.mjs");
  await writeFile(childPath, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "run") {
  appendFileSync(process.env.FAKE_BROWSERJACK_LOG, "started\\n");
  process.stdout.write('{"jsonrpc":"2.0","method":"child/ready","params":{}}\\n');
  let buffer = "";
  const processLine = (line, delimiter) => {
    let message;
    try { message = JSON.parse(line); } catch {}
    if (
      message?.method === "tools/call"
      && typeof message.id === "string"
      && message.id.startsWith("__chatgpt_chrome_bridge_health__:")
    ) {
      appendFileSync(process.env.FAKE_BROWSERJACK_LOG, JSON.stringify(message) + "\\n");
      const response = process.env.FAKE_HEALTH_FAILURE === "user-unavailable"
        ? { jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: "Error: User unavailable" }] } }
        : { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify({ chromeDiscovered: true, userBindingUsable: true, tabsApiUsable: true }) }] } };
      process.stdout.write(JSON.stringify(response) + "\\n");
      return;
    }
    process.stdout.write(line + delimiter);
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\\n")) !== -1) {
      processLine(buffer.slice(0, newline), "\\n");
      buffer = buffer.slice(newline + 1);
    }
  });
  process.stdin.on("end", () => {
    if (buffer.length > 0) processLine(buffer, "");
  });
} else if (args[0] === "fail") {
  process.exit(7);
} else {
  process.stdout.write(JSON.stringify(args) + "\\n");
}
`);
  await chmod(childPath, 0o755);
  return {
    childPath,
    logPath: join(directory, "fake-browserjack.log"),
    socketPath: join(socketDirectory, "health.sock"),
  };
}

function invoke(fake, args, input = "") {
  return new Promise((resolveInvocation, rejectInvocation) => {
    const child = spawn(process.execPath, [wrapper, ...args], {
      env: {
        ...process.env,
        BROWSERJACK_DISCOVERY_UPSTREAM: fake.childPath,
        BROWSERJACK_HEALTH_SOCKET: fake.socketPath,
        FAKE_BROWSERJACK_LOG: fake.logPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectInvocation);
    child.once("exit", (code, signal) => {
      resolveInvocation({ code, signal, stdout, stderr });
    });
    if (Array.isArray(input)) {
      void (async () => {
        for (const chunk of input) {
          child.stdin.write(chunk);
          await new Promise((resolveChunk) => setImmediate(resolveChunk));
        }
        child.stdin.end();
      })();
    } else {
      child.stdin.end(input);
    }
  });
}

async function waitFor(predicate, message, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(message);
}

function requestSocket(path, request) {
  return new Promise((resolveRequest, rejectRequest) => {
    const socket = createConnection(path);
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.end(request));
    socket.on("data", (chunk) => { response += chunk; });
    socket.once("end", () => resolveRequest(response));
    socket.once("error", rejectRequest);
  });
}

function startProxy(fake, extraEnv = {}) {
  const child = spawn(process.execPath, [wrapper, "run"], {
    env: {
      ...process.env,
      BROWSERJACK_DISCOVERY_UPSTREAM: fake.childPath,
      BROWSERJACK_HEALTH_SOCKET: fake.socketPath,
      FAKE_BROWSERJACK_LOG: fake.logPath,
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  return {
    child,
    exited,
    output: () => ({ stdout, stderr }),
  };
}

async function leaveStaleSocket(path) {
  const owner = spawn(process.execPath, [
    "-e",
    "require('node:net').createServer().listen(process.argv[1], () => process.stdout.write('ready'))",
    path,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolveReady, rejectReady) => {
    owner.once("error", rejectReady);
    owner.stdout.once("data", resolveReady);
  });
  owner.kill("SIGKILL");
  await new Promise((resolveExit) => owner.once("exit", resolveExit));
  assert.equal((await lstat(path)).isSocket(), true);
}

test("rejects discovery and forwards all legacy lifecycle messages unchanged", async (t) => {
  const fake = await makeFakeChild(t);
  const discoverString = '{"jsonrpc":"2.0","id":"discover-1","method":"server/discover","params":{"secret":"do-not-log"}}';
  const discoverNumber = '{"jsonrpc":"2.0","id":0,"method":"server/discover","params":{}}';
  const discoverNotification = '{"jsonrpc":"2.0","method":"server/discover","params":{}}';
  const initializeOne = '{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"client":"one"} }';
  const initializeTwo = '{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"client":"two"}}';
  const initialized = '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}';
  const toolsList = '{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}';
  const toolsCall = '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"secret":"never-print-this"}}';
  const invalid = 'not-json';
  const inputLines = [
    discoverString,
    discoverNumber,
    discoverNotification,
    initializeOne,
    initializeTwo,
    initialized,
    toolsList,
    toolsCall,
    invalid,
  ];

  const result = await invoke(fake, ["run"], `${inputLines.join("\n")}\n`);
  assert.equal(result.code, 0);
  const outputLines = result.stdout.trim().split("\n");
  assert(outputLines.includes('{"jsonrpc":"2.0","method":"child/ready","params":{}}'));
  assert(outputLines.includes('{"jsonrpc":"2.0","id":"discover-1","error":{"code":-32601,"message":"Method not found"}}'));
  assert(outputLines.includes('{"jsonrpc":"2.0","id":0,"error":{"code":-32601,"message":"Method not found"}}'));
  assert(outputLines.includes(initializeOne));
  assert(outputLines.includes(initializeTwo));
  assert(outputLines.includes(initialized));
  assert(outputLines.includes(toolsList));
  assert(outputLines.includes(toolsCall));
  assert(outputLines.includes(invalid));
  assert(!outputLines.includes(discoverString));
  assert(!outputLines.includes(discoverNumber));
  assert(!outputLines.includes(discoverNotification));
  assert.match(result.stderr, /method="server\/discover" id="discover-1" action=reject/);
  assert.match(result.stderr, /method="initialize" id=1 action=forward/);
  assert.match(result.stderr, /method="initialize" id=2 action=forward/);
  assert.match(result.stderr, /method="tools\/call" id=4 action=forward/);
  assert(!result.stderr.includes("do-not-log"));
  assert(!result.stderr.includes("never-print-this"));
});

test("handles chunked discovery and preserves an unterminated final record", async (t) => {
  const fake = await makeFakeChild(t);
  const result = await invoke(fake, ["run"], [
    '{"jsonrpc":"2.0","id":"split",',
    '"method":"server/discover","params":{}}\n',
    '{"jsonrpc":"2.0","id":9,"method":"init',
    'ialize","params":{}}\n',
    'unterminated-record',
  ]);
  assert.equal(result.code, 0);
  assert(result.stdout.includes('{"jsonrpc":"2.0","id":"split","error":{"code":-32601,"message":"Method not found"}}\n'));
  assert(result.stdout.includes('{"jsonrpc":"2.0","id":9,"method":"initialize","params":{}}\n'));
  assert(result.stdout.endsWith("unterminated-record"));
});

test("passes non-run commands and their exit status through", async (t) => {
  const fake = await makeFakeChild(t);
  const doctor = await invoke(fake, ["doctor", "--json"]);
  assert.equal(doctor.code, 0);
  assert.equal(doctor.stdout, '["doctor","--json"]\n');

  const failure = await invoke(fake, ["fail"]);
  assert.equal(failure.code, 7);
});

test("serves only the fixed probe through the existing private BrowserJack session", async (t) => {
  const fake = await makeFakeChild(t);
  await leaveStaleSocket(fake.socketPath);
  const proxy = startProxy(fake);
  t.after(() => proxy.child.kill("SIGKILL"));

  await waitFor(async () => {
    try {
      const value = await lstat(fake.socketPath);
      return value.isSocket() && (value.mode & 0o777) === 0o600;
    } catch {
      return false;
    }
  }, "health socket was not exposed");

  const parentStat = await lstat(dirname(fake.socketPath));
  const socketStat = await lstat(fake.socketPath);
  assert.equal(parentStat.mode & 0o777, 0o700);
  assert.equal(socketStat.mode & 0o777, 0o600);

  const rejected = JSON.parse(await requestSocket(fake.socketPath, '{"op":"probe","code":"arbitrary"}\n'));
  assert.deepEqual(rejected, { ok: false, error: "invalid request" });

  const probe = JSON.parse(await requestSocket(fake.socketPath, '{"op":"probe"}\n'));
  assert.deepEqual(probe, {
    ok: true,
    chromeDiscovered: true,
    userBindingUsable: true,
    tabsApiUsable: true,
  });

  proxy.child.stdin.write('{"jsonrpc":"2.0","id":"ordinary","method":"tools/list","params":{}}\n');
  await waitFor(
    () => proxy.output().stdout.includes('"id":"ordinary"'),
    "ordinary MCP traffic was not forwarded",
  );
  const logLines = (await readFile(fake.logPath, "utf8")).trim().split("\n");
  assert.equal(logLines.filter((line) => line === "started").length, 1);
  const injected = JSON.parse(logLines.find((line) => line.startsWith("{")));
  assert.equal(injected.method, "tools/call");
  assert.equal(injected.params.name, "js");
  assert.match(injected.id, /^__chatgpt_chrome_bridge_health__:/u);
  assert.match(injected.params.arguments.code, /\/Applications\/ChatGPT\.app\/Contents\/Resources\/plugins\/openai-bundled\/plugins\/chrome\/scripts\/browser-client\.mjs/u);
  assert.match(injected.params.arguments.code, /setupBrowserRuntime\(\)/u);
  assert.match(injected.params.arguments.code, /nameSession\('chatgpt-chrome-bridge-health'\)/u);
  assert.match(injected.params.arguments.code, /tabs\.list\(\)/u);
  assert(!proxy.output().stdout.includes("__chatgpt_chrome_bridge_health__"));

  proxy.child.stdin.end();
  const result = await proxy.exited;
  assert.equal(result.code, 0, proxy.output().stderr);
  await waitFor(async () => {
    try {
      await lstat(fake.socketPath);
      return false;
    } catch (error) {
      return error?.code === "ENOENT";
    }
  }, "health socket was not cleaned up");
});

test("reduces User unavailable failures to safe readiness fields", async (t) => {
  const fake = await makeFakeChild(t);
  const proxy = startProxy(fake, { FAKE_HEALTH_FAILURE: "user-unavailable" });
  t.after(() => proxy.child.kill("SIGKILL"));
  await waitFor(async () => {
    try {
      return (await lstat(fake.socketPath)).isSocket();
    } catch {
      return false;
    }
  }, "health socket was not exposed");

  const probe = JSON.parse(await requestSocket(fake.socketPath, '{"op":"probe"}\n'));
  assert.deepEqual(probe, {
    ok: false,
    chromeDiscovered: false,
    userBindingUsable: false,
    tabsApiUsable: false,
    failureKind: "user-unavailable",
    error: "User unavailable",
  });
  assert(!proxy.output().stdout.includes("User unavailable"));
  assert(!proxy.output().stdout.includes("__chatgpt_chrome_bridge_health__"));
  proxy.child.stdin.end();
  const result = await proxy.exited;
  assert.equal(result.code, 0, proxy.output().stderr);
});
