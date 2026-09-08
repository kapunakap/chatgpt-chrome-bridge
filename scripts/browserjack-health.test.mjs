import assert from "node:assert/strict";
import test from "node:test";

import {
  blankHealthState,
  classifyProbeFailure,
  isUserUnavailable,
  nextHealthDecision,
  readinessFromToolContent,
  restartLaunchAgentAndWait,
  runHealthCycle,
} from "./browserjack-health.mjs";

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

test("restart path uses launchctl kickstart -k", () => {
  assert.match(
    restartLaunchAgentAndWait.toString(),
    /runCommand\("launchctl",\s*\["kickstart", "-k", target\]/u,
  );
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
