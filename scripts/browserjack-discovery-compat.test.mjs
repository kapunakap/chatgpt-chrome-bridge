#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const wrapper = resolve(scriptsRoot, "browserjack-discovery-compat.mjs");

async function makeFakeChild(t) {
  const directory = await mkdtemp(join(tmpdir(), "browserjack-discovery-compat-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const childPath = join(directory, "fake-browserjack.mjs");
  await writeFile(childPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run") {
  process.stdout.write('{"jsonrpc":"2.0","method":"child/ready","params":{}}\\n');
  process.stdin.pipe(process.stdout);
} else if (args[0] === "fail") {
  process.exit(7);
} else {
  process.stdout.write(JSON.stringify(args) + "\\n");
}
`);
  await chmod(childPath, 0o755);
  return childPath;
}

function invoke(childPath, args, input = "") {
  return new Promise((resolveInvocation, rejectInvocation) => {
    const child = spawn(process.execPath, [wrapper, ...args], {
      env: { ...process.env, BROWSERJACK_DISCOVERY_UPSTREAM: childPath },
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

test("rejects discovery and forwards all legacy lifecycle messages unchanged", async (t) => {
  const childPath = await makeFakeChild(t);
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

  const result = await invoke(childPath, ["run"], `${inputLines.join("\n")}\n`);
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
  const childPath = await makeFakeChild(t);
  const result = await invoke(childPath, ["run"], [
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
  const childPath = await makeFakeChild(t);
  const doctor = await invoke(childPath, ["doctor", "--json"]);
  assert.equal(doctor.code, 0);
  assert.equal(doctor.stdout, '["doctor","--json"]\n');

  const failure = await invoke(childPath, ["fail"]);
  assert.equal(failure.code, 7);
});
