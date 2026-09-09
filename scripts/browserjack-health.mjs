#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultHealthSocket = process.env.BROWSERJACK_HEALTH_SOCKET ?? join(
  homedir(),
  ".config/chatgpt-browser-bridge/browserjack-live-health.sock",
);
const defaultStateFile = process.env.LOCAL_CHROME_HEALTH_STATE_FILE ?? join(
  homedir(),
  ".config/chatgpt-browser-bridge/local-chrome-health.json",
);
const defaultLabel = process.env.LOCAL_CHROME_LAUNCH_AGENT_LABEL ?? "com.kapunakap.chatgpt-chrome-bridge.local-chrome";
const defaultAlias = process.env.TUNNEL_ALIAS ?? "local-chrome";
const timeoutMs = 30_000;
const restartThreshold = 2;
const minRestartIntervalMs = 5 * 60_000;
const recoveryBackoffMs = [2_000, 5_000, 15_000];
const maxDiagnosticBytes = 16_384;

function diagnosticText(value) {
  return String(value ?? "").trim().slice(-maxDiagnosticBytes);
}

export function isUserUnavailable(value) {
  return /\buser unavailable\b/iu.test(diagnosticText(value));
}

export function classifyProbeFailure(value) {
  return isUserUnavailable(value) ? "user-unavailable" : "other";
}

export function readinessFromToolContent(content) {
  const text = Array.isArray(content)
    ? content.map((item) => typeof item?.text === "string" ? item.text : JSON.stringify(item)).join("\n")
    : String(content ?? "");
  return {
    chromeDiscovered: text.includes('"chromeDiscovered":true'),
    userBindingUsable: text.includes('"userBindingUsable":true'),
    tabsApiUsable: text.includes('"tabsApiUsable":true'),
  };
}

export function blankHealthState() {
  return {
    version: 1,
    status: "unknown",
    consecutiveUserUnavailable: 0,
    restartAttemptedSinceHealthy: false,
    lastRestartAt: null,
    lastProbeAt: null,
    lastSuccessAt: null,
    lastFailureKind: null,
    lastFailure: null,
    lastRecovery: null,
  };
}

export function nextHealthDecision(previous, probe, now = Date.now(), {
  threshold = restartThreshold,
  minimumRestartIntervalMs = minRestartIntervalMs,
} = {}) {
  const base = { ...blankHealthState(), ...(previous ?? {}) };
  if (probe.ok) {
    return {
      action: "healthy",
      state: {
        ...base,
        status: "healthy",
        consecutiveUserUnavailable: 0,
        restartAttemptedSinceHealthy: false,
        lastProbeAt: now,
        lastSuccessAt: now,
        lastFailureKind: null,
        lastFailure: null,
        lastRecovery: probe.recovered === true ? "healthy-after-restart" : base.lastRecovery,
      },
    };
  }

  const failure = diagnosticText(probe.error ?? probe.detail ?? "BrowserJack readiness probe failed");
  const failureKind = probe.failureKind ?? classifyProbeFailure(failure);
  const consecutiveUserUnavailable = failureKind === "user-unavailable"
    ? Number(base.consecutiveUserUnavailable ?? 0) + 1
    : 0;
  const restartRecently = Number.isFinite(base.lastRestartAt) && now - base.lastRestartAt < minimumRestartIntervalMs;
  const shouldRestart = failureKind === "user-unavailable" &&
    consecutiveUserUnavailable >= threshold &&
    base.restartAttemptedSinceHealthy !== true &&
    !restartRecently;

  return {
    action: shouldRestart ? "restart" : "unhealthy",
    state: {
      ...base,
      status: "unhealthy",
      consecutiveUserUnavailable,
      lastProbeAt: now,
      lastFailureKind: failureKind,
      lastFailure: failure,
    },
  };
}

export async function probeBrowserJack({
  socketPath = defaultHealthSocket,
  timeout = timeoutMs,
} = {}) {
  try {
    const response = await new Promise((resolveProbe, rejectProbe) => {
      const socket = createConnection(socketPath);
      let body = "";
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        callback(value);
      };
      socket.setEncoding("utf8");
      socket.setTimeout(timeout, () => finish(rejectProbe, new Error("BrowserJack health socket timed out")));
      socket.once("connect", () => socket.end('{"op":"probe"}\n'));
      socket.on("data", (chunk) => {
        body = `${body}${chunk}`;
        if (body.length > 4_096) {
          finish(rejectProbe, new Error("BrowserJack health socket response was too large"));
        }
      });
      socket.once("error", (error) => finish(rejectProbe, error));
      socket.once("end", () => finish(resolveProbe, body));
    });
    const value = JSON.parse(response);
    if (value?.ok !== true) {
      return {
        ok: false,
        chromeDiscovered: value?.chromeDiscovered === true,
        userBindingUsable: value?.userBindingUsable === true,
        tabsApiUsable: value?.tabsApiUsable === true,
        failureKind: value?.failureKind === "user-unavailable" ? "user-unavailable" : "other",
        error: value?.failureKind === "user-unavailable" ? "User unavailable" : "BrowserJack readiness probe failed",
      };
    }
    const readiness = {
      chromeDiscovered: value.chromeDiscovered === true,
      userBindingUsable: value.userBindingUsable === true,
      tabsApiUsable: value.tabsApiUsable === true,
    };
    if (!readiness.chromeDiscovered || !readiness.userBindingUsable || !readiness.tabsApiUsable) {
      throw new Error("BrowserJack health socket returned incomplete readiness");
    }
    return { ok: true, ...readiness };
  } catch (error) {
    const detail = diagnosticText(error instanceof Error ? error.message : String(error));
    return {
      ok: false,
      chromeDiscovered: false,
      userBindingUsable: false,
      tabsApiUsable: false,
      failureKind: classifyProbeFailure(detail),
      error: isUserUnavailable(detail) ? "User unavailable" : "BrowserJack health socket unavailable",
    };
  }
}

function runCommand(command, args, { timeout = 30_000 } = {}) {
  return new Promise((resolveCommand) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timer;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolveCommand(result);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-maxDiagnosticBytes); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-maxDiagnosticBytes); });
    child.once("error", (error) => finish({ code: 1, stdout, stderr: error.message }));
    child.once("exit", (code) => finish({ code: typeof code === "number" ? code : 1, stdout, stderr }));
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: 124, stdout, stderr: `${stderr}\ncommand timed out` });
    }, timeout);
  });
}

function parseLaunchdPid(value) {
  return value.match(/^[\t ]*pid = (\d+)$/mu)?.[1] ?? null;
}

function parseLaunchdState(value) {
  return value.match(/^[\t ]*state = ([^\n]+)$/mu)?.[1]?.trim() ?? null;
}

function pidIsAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

export function tunnelRuntimeReady(value, {
  owner = "managed",
  launchdPidAlive = false,
} = {}) {
  if (value?.healthy !== true || value?.ready !== true) return false;
  if (owner === "launchd") return launchdPidAlive === true;
  return owner === "managed" && value?.process_running === true;
}

async function sleep(ms) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function restartLaunchAgentAndWait({
  label = defaultLabel,
  alias = defaultAlias,
  timeout = 30_000,
  runCommandFn = runCommand,
  isPidAlive = pidIsAlive,
  now = Date.now,
  sleepFn = sleep,
} = {}) {
  const target = `gui/${process.getuid()}/${label}`;
  const before = await runCommandFn("launchctl", ["print", target], { timeout: 5_000 });
  const beforePid = before.code === 0 ? parseLaunchdPid(before.stdout) : null;
  const kicked = await runCommandFn("launchctl", ["kickstart", "-k", target], { timeout: 10_000 });
  if (kicked.code !== 0) {
    throw new Error(`launchctl kickstart failed: ${diagnosticText(kicked.stderr || kicked.stdout)}`);
  }

  const deadline = now() + timeout;
  let lastDetail = "waiting for launchd and tunnel runtime";
  while (now() < deadline) {
    const printed = await runCommandFn("launchctl", ["print", target], { timeout: 5_000 });
    const afterPid = printed.code === 0 ? parseLaunchdPid(printed.stdout) : null;
    const launchdPidAlive = printed.code === 0
      && parseLaunchdState(printed.stdout) === "running"
      && afterPid !== null
      && afterPid !== beforePid
      && isPidAlive(afterPid);
    const status = await runCommandFn(resolve(repoRoot, "scripts/tunnel-client-current.sh"), [
      "runtimes", "--json", "status", alias,
    ], { timeout: 5_000 });
    let tunnelReady = false;
    let tunnelStatus = null;
    if (status.code === 0) {
      try {
        tunnelStatus = JSON.parse(status.stdout);
        tunnelReady = tunnelRuntimeReady(tunnelStatus, { owner: "launchd", launchdPidAlive });
      } catch {
        lastDetail = "tunnel status returned invalid JSON";
      }
    } else {
      lastDetail = diagnosticText(status.stderr || status.stdout || lastDetail);
    }
    if (launchdPidAlive && tunnelReady) {
      return {
        owner: "launchd",
        beforePid,
        afterPid,
        launchdPidAlive: true,
        managedProcessRunning: tunnelStatus?.process_running === true,
        tunnelHealthy: true,
        tunnelReady: true,
      };
    }
    lastDetail = `launchd_pid_new_alive=${Boolean(launchdPidAlive)} tunnel_healthy=${tunnelStatus?.healthy === true} tunnel_ready=${tunnelStatus?.ready === true}`;
    await sleepFn(1_000);
  }
  throw new Error(`LaunchAgent restart did not reconcile runtime readiness: ${lastDetail}`);
}

export async function runHealthCycle({
  state = blankHealthState(),
  probe = () => probeBrowserJack(),
  restart = () => restartLaunchAgentAndWait(),
  now = Date.now,
  sleepFn = sleep,
  threshold = restartThreshold,
  minimumRestartIntervalMs = minRestartIntervalMs,
  backoffMs = recoveryBackoffMs,
} = {}) {
  const initialProbe = await probe();
  const first = nextHealthDecision(state, initialProbe, now(), { threshold, minimumRestartIntervalMs });
  if (first.action !== "restart") {
    return { state: first.state, probe: initialProbe, restarted: false };
  }

  let workingState = {
    ...first.state,
    restartAttemptedSinceHealthy: true,
    lastRestartAt: now(),
    lastRecovery: "restart-requested",
  };
  try {
    await restart();
    workingState = { ...workingState, lastRecovery: "restart-completed" };
  } catch (error) {
    return {
      state: {
        ...workingState,
        status: "unhealthy",
        lastRecovery: `restart-failed: ${diagnosticText(error instanceof Error ? error.message : error)}`,
      },
      probe: initialProbe,
      restarted: true,
    };
  }

  let latestProbe = initialProbe;
  for (const delay of backoffMs) {
    await sleepFn(delay);
    latestProbe = await probe();
    if (latestProbe.ok) {
      const recovered = nextHealthDecision(
        workingState,
        { ...latestProbe, recovered: true },
        now(),
        { threshold, minimumRestartIntervalMs },
      );
      return { state: recovered.state, probe: latestProbe, restarted: true };
    }
  }
  const failed = nextHealthDecision(workingState, latestProbe, now(), { threshold, minimumRestartIntervalMs });
  return {
    state: {
      ...failed.state,
      restartAttemptedSinceHealthy: true,
      lastRecovery: "restart-exhausted",
    },
    probe: latestProbe,
    restarted: true,
  };
}

async function readState(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return { ...blankHealthState(), ...value };
  } catch (error) {
    if (error?.code === "ENOENT") return blankHealthState();
    return { ...blankHealthState(), lastRecovery: `state-reset: ${diagnosticText(error.message)}` };
  }
}

async function writeState(path, state) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
  await chmod(path, 0o600);
}

function outputProbe(probe) {
  process.stdout.write(`${JSON.stringify(probe)}\n`);
}

async function main() {
  const command = process.argv[2] ?? "probe";
  if (command === "probe") {
    const result = await probeBrowserJack();
    outputProbe(result);
    process.exitCode = result.ok ? 0 : 2;
    return;
  }
  if (command === "watch-once") {
    const state = await readState(defaultStateFile);
    const result = await runHealthCycle({ state });
    await writeState(defaultStateFile, result.state);
    process.stdout.write(`${JSON.stringify({ ...result.state, restarted: result.restarted })}\n`);
    process.exitCode = result.probe.ok ? 0 : 2;
    return;
  }
  if (command === "state") {
    process.stdout.write(`${JSON.stringify(await readState(defaultStateFile))}\n`);
    return;
  }
  throw new Error(`Unknown health command: ${command}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`browserjack health: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
