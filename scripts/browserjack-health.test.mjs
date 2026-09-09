import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  blankHealthState,
  classifyProbeFailure,
  isUserUnavailable,
  nextHealthDecision,
  probeBrowserJack,
  readinessFromToolContent,
  restartLaunchAgentAndWait,
  runHealthCycle,
  tunnelRuntimeReady,
} from "./browserjack-health.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("User unavailable is classified separately from discovery failures", () => {
  assert.equal(isUserUnavailable("Error: User unavailable"), true);
  assert.equal(classifyProbeFailure("health_stage=user-binding: Error: User unavailable"), "user-unavailable");
  assert.equal(classifyProbeFailure("Chrome backend is not connected"), "other");
});

test("readiness parses the text payload returned by the js MCP tool", () => {
  assert.deepEqual(
    readinessFromToolContent([{ type: "text", text: '{"chromeDiscovered":true,"userBindingUsable":true,"tabsApiUsable":true}' }]),
    { chromeDiscovered: true, userBindingUsable: true, tabsApiUsable: true },
  );
  assert.deepEqual(
    readinessFromToolContent([{ type: "text", text: '{"chromeDiscovered":true,"userBindingUsable":false,"tabsApiUsable":false}' }]),
    { chromeDiscovered: true, userBindingUsable: false, tabsApiUsable: false },
  );
});

test("launchd ownership ignores managed process_running while manual ownership requires it", () => {
  const detached = { process_running: false, healthy: true, ready: true };
  assert.equal(tunnelRuntimeReady(detached, { owner: "launchd", launchdPidAlive: true }), true);
  assert.equal(tunnelRuntimeReady(detached, { owner: "launchd", launchdPidAlive: false }), false);
  assert.equal(tunnelRuntimeReady(detached, { owner: "managed" }), false);
  assert.equal(tunnelRuntimeReady({ ...detached, process_running: true }, { owner: "managed" }), true);
});

test("restart uses exact kickstart -k and accepts a new alive launchd PID with healthy ready tunnel", async () => {
  const calls = [];
  const runCommandFn = async (command, args) => {
    calls.push([command, args]);
    if (command === "launchctl" && args[0] === "print") {
      const pid = calls.filter(([name, values]) => name === "launchctl" && values[0] === "print").length === 1
        ? "111"
        : "222";
      return { code: 0, stdout: `state = running\npid = ${pid}\n`, stderr: "" };
    }
    if (command === "launchctl") return { code: 0, stdout: "", stderr: "" };
    return {
      code: 0,
      stdout: JSON.stringify({ process_running: false, healthy: true, ready: true }),
      stderr: "",
    };
  };
  const result = await restartLaunchAgentAndWait({
    label: "test.local-chrome",
    alias: "local-chrome",
    runCommandFn,
    isPidAlive: (pid) => pid === "222",
    now: () => 0,
    sleepFn: async () => {},
  });
  assert.deepEqual(calls[1], [
    "launchctl",
    ["kickstart", "-k", `gui/${process.getuid()}/test.local-chrome`],
  ]);
  assert.equal(result.owner, "launchd");
  assert.equal(result.beforePid, "111");
  assert.equal(result.afterPid, "222");
  assert.equal(result.launchdPidAlive, true);
  assert.equal(result.managedProcessRunning, false);
  assert.equal(result.tunnelHealthy, true);
  assert.equal(result.tunnelReady, true);
});

test("restart rejects healthy tunnel bookkeeping until launchd has a new PID", async () => {
  let clock = 0;
  const runCommandFn = async (command, args) => {
    if (command === "launchctl" && args[0] === "print") {
      return { code: 0, stdout: "state = running\npid = 111\n", stderr: "" };
    }
    if (command === "launchctl") return { code: 0, stdout: "", stderr: "" };
    return {
      code: 0,
      stdout: JSON.stringify({ process_running: false, healthy: true, ready: true }),
      stderr: "",
    };
  };
  await assert.rejects(
    restartLaunchAgentAndWait({
      runCommandFn,
      isPidAlive: () => true,
      timeout: 1_500,
      now: () => clock,
      sleepFn: async (ms) => { clock += ms; },
    }),
    /new_alive=false/u,
  );
});

test("health probe uses the private socket and treats an absent socket as unhealthy", async (t) => {
  const directory = join(repoRoot, ".git", `health-test-${process.pid}`);
  await mkdir(directory, { mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "health.sock");
  let request = "";
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { request += chunk; });
    socket.once("end", () => socket.end(`${JSON.stringify({
      ok: true,
      chromeDiscovered: true,
      userBindingUsable: true,
      tabsApiUsable: true,
    })}\n`));
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, resolveListen);
  });
  t.after(() => server.close());

  const healthy = await probeBrowserJack({ socketPath, timeout: 1_000 });
  assert.equal(request, '{"op":"probe"}\n');
  assert.deepEqual(healthy, {
    ok: true,
    chromeDiscovered: true,
    userBindingUsable: true,
    tabsApiUsable: true,
  });

  const unavailable = await probeBrowserJack({ socketPath: join(directory, "absent.sock"), timeout: 100 });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.failureKind, "other");
  assert.equal(unavailable.error, "BrowserJack health socket unavailable");
});

test("unrelated failures do not trigger stale-identity recovery", async () => {
  let restarts = 0;
  const result = await runHealthCycle({
    state: {
      ...blankHealthState(),
      consecutiveUserUnavailable: 1,
    },
    probe: async () => ({
      ok: false,
      failureKind: "other",
      error: "Chrome backend is not connected",
    }),
    restart: async () => { restarts += 1; },
    sleepFn: async () => {},
    now: () => 5_000,
  });

  assert.equal(restarts, 0);
  assert.equal(result.restarted, false);
  assert.equal(result.state.consecutiveUserUnavailable, 0);
  assert.equal(result.state.lastFailureKind, "other");
});

test("two consecutive stale identity failures trigger one bounded restart then recover", async () => {
  let state = blankHealthState();
  let restarts = 0;
  const stale = { ok: false, failureKind: "user-unavailable", error: "Error: User unavailable" };
  let probes = [stale];

  let result = await runHealthCycle({
    state,
    probe: async () => probes.shift(),
    restart: async () => { restarts += 1; },
    sleepFn: async () => {},
    now: () => 1_000,
  });
  state = result.state;
  assert.equal(restarts, 0);
  assert.equal(state.consecutiveUserUnavailable, 1);
  assert.equal(state.status, "unhealthy");

  probes = [stale, { ok: true, chromeDiscovered: true, userBindingUsable: true, tabsApiUsable: true }];
  result = await runHealthCycle({
    state,
    probe: async () => probes.shift(),
    restart: async () => { restarts += 1; },
    sleepFn: async () => {},
    now: () => 10_000,
    backoffMs: [0],
  });
  assert.equal(restarts, 1);
  assert.equal(result.restarted, true);
  assert.equal(result.state.status, "healthy");
  assert.equal(result.state.consecutiveUserUnavailable, 0);
  assert.equal(result.state.restartAttemptedSinceHealthy, false);
  assert.equal(result.state.lastRecovery, "healthy-after-restart");
});

test("failed recovery does not enter a restart loop before a healthy probe", async () => {
  const stale = { ok: false, failureKind: "user-unavailable", error: "Error: User unavailable" };
  let state = {
    ...blankHealthState(),
    consecutiveUserUnavailable: 1,
  };
  let restarts = 0;

  let result = await runHealthCycle({
    state,
    probe: async () => stale,
    restart: async () => { restarts += 1; },
    sleepFn: async () => {},
    now: () => 20_000,
    backoffMs: [0, 0],
  });
  state = result.state;
  assert.equal(restarts, 1);
  assert.equal(state.restartAttemptedSinceHealthy, true);
  assert.equal(state.lastRecovery, "restart-exhausted");

  result = await runHealthCycle({
    state,
    probe: async () => stale,
    restart: async () => { restarts += 1; },
    sleepFn: async () => {},
    now: () => 600_000,
    backoffMs: [0],
  });
  assert.equal(restarts, 1);
  assert.equal(result.restarted, false);
  assert.equal(result.state.restartAttemptedSinceHealthy, true);
});

test("restart rate limiting survives state that was not armed", () => {
  const state = {
    ...blankHealthState(),
    consecutiveUserUnavailable: 1,
    restartAttemptedSinceHealthy: false,
    lastRestartAt: 100_000,
  };
  const decision = nextHealthDecision(
    state,
    { ok: false, failureKind: "user-unavailable", error: "User unavailable" },
    100_000 + 60_000,
  );
  assert.equal(decision.action, "unhealthy");
  assert.equal(decision.state.consecutiveUserUnavailable, 2);
});
