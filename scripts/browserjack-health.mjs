#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultLauncher = process.env.BROWSERJACK_COMMAND ?? resolve(repoRoot, "scripts/browserjack-current.sh");
const defaultApp = process.env.CHATGPT_APP_PATH ?? "/Applications/ChatGPT.app";
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

function killGroup(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The process may already have exited.
  }
}

export async function probeBrowserJack({
  launcher = defaultLauncher,
  appPath = defaultApp,
  timeout = timeoutMs,
} = {}) {
  const browserClientUrl = pathToFileURL(join(
    appPath,
    "Contents/Resources/plugins/openai-bundled/plugins/chrome/scripts/browser-client.mjs",
  )).href;
  const child = spawn(launcher, ["run"], {
    cwd: repoRoot,
    detached: true,
    env: process.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-maxDiagnosticBytes);
  });

  const pending = new Map();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    waiter.resolve(message);
  });

  const rejectPending = (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (id, method, params) => new Promise((resolveRequest, rejectRequest) => {
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    send({ jsonrpc: "2.0", id, method, params });
  });

  child.once("error", (error) => rejectPending(new Error(`BrowserJack process failed to start: ${error.message}`)));
  child.once("exit", (code, signal) => {
    if (pending.size === 0) return;
    rejectPending(new Error(`BrowserJack exited during readiness probe (${signal ?? `code ${code ?? 1}`})`));
  });

  const timer = setTimeout(() => {
    rejectPending(new Error("BrowserJack readiness probe timed out"));
    killGroup(child, "SIGKILL");
  }, timeout);

  try {
    const initialized = await request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "chatgpt-chrome-bridge-health", version: "1" },
    });
    if (initialized.error) throw new Error(`MCP initialize failed: ${initialized.error.message}`);
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

    const toolsResponse = await request(2, "tools/list", {});
    const tools = toolsResponse.result?.tools ?? [];
    if (!tools.some((tool) => tool.name === "js")) throw new Error("BrowserJack did not expose the js tool");

    const sessionId = `bridge-health-${randomUUID()}`;
    const code = `
      var healthStage = 'import-client';
      try {
        var healthClient = await import(${JSON.stringify(browserClientUrl)});
        healthStage = 'setup-runtime';
        globalThis.agent = await healthClient.setupBrowserRuntime();
        healthStage = 'discovery';
        var healthBackends = await agent.browsers.list();
        var healthChromeSummary = healthBackends.find((backend) => backend.family === 'chrome');
        if (!healthChromeSummary) throw new Error('Chrome backend is not connected');
        var healthChrome = await agent.browsers.get('chrome');
        healthStage = 'user-binding';
        if (typeof healthChrome.nameSession !== 'function') throw new Error('Chrome backend does not expose nameSession()');
        await healthChrome.nameSession('chatgpt-chrome-bridge-health');
        healthStage = 'tabs-list';
        if (typeof healthChrome.tabs?.list !== 'function') throw new Error('Chrome backend does not expose tabs.list()');
        var healthTabs = await healthChrome.tabs.list();
        nodeRepl.write(JSON.stringify({
          chromeDiscovered: true,
          userBindingUsable: true,
          tabsApiUsable: true,
          tabCount: healthTabs.length,
          browserClientUrl: ${JSON.stringify(browserClientUrl)},
        }));
      } catch (error) {
        throw new Error('health_stage=' + healthStage + ': ' + String(error));
      }
    `;
    const toolResponse = await request(3, "tools/call", {
      name: "js",
      arguments: { code, title: "Check Local Chrome readiness" },
      _meta: {
        "x-codex-turn-metadata": {
          installation_id: sessionId,
          session_id: sessionId,
          thread_id: sessionId,
          turn_id: "turn-1",
          request_kind: "agent",
          turn_started_at_unix_ms: Date.now(),
        },
      },
    });
    if (toolResponse.error || toolResponse.result?.isError === true) {
      const failure = diagnosticText(JSON.stringify(toolResponse.error ?? toolResponse.result ?? {}));
      throw new Error(`BrowserJack readiness call failed: ${failure}`);
    }

    const readiness = readinessFromToolContent(toolResponse.result?.content ?? []);
    if (!readiness.chromeDiscovered || !readiness.userBindingUsable || !readiness.tabsApiUsable) {
      throw new Error(`Unexpected BrowserJack readiness result: ${diagnosticText(JSON.stringify(toolResponse.result?.content ?? []))}`);
    }
    return {
      ok: true,
      ...readiness,
      browserClientUrl,
    };
  } catch (error) {
    const detail = diagnosticText(`${error instanceof Error ? error.message : String(error)}${stderr ? `\n${stderr}` : ""}`);
    return {
      ok: false,
      chromeDiscovered: !/health_stage=(?:import-client|setup-runtime|discovery)/u.test(detail),
      userBindingUsable: false,
      tabsApiUsable: false,
      failureKind: classifyProbeFailure(detail),
      error: detail,
      browserClientUrl,
    };
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    lines.close();
    killGroup(child, "SIGTERM");
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

async function sleep(ms) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function restartLaunchAgentAndWait({
  label = defaultLabel,
  alias = defaultAlias,
  timeout = 30_000,
} = {}) {
  const target = `gui/${process.getuid()}/${label}`;
  const before = await runCommand("launchctl", ["print", target], { timeout: 5_000 });
  const beforePid = before.code === 0 ? parseLaunchdPid(before.stdout) : null;
  const kicked = await runCommand("launchctl", ["kickstart", "-k", target], { timeout: 10_000 });
  if (kicked.code !== 0) {
    throw new Error(`launchctl kickstart failed: ${diagnosticText(kicked.stderr || kicked.stdout)}`);
  }

  const deadline = Date.now() + timeout;
  let lastDetail = "waiting for launchd and tunnel runtime";
  while (Date.now() < deadline) {
    const printed = await runCommand("launchctl", ["print", target], { timeout: 5_000 });
    const afterPid = printed.code === 0 ? parseLaunchdPid(printed.stdout) : null;
    const launchdReady = printed.code === 0 && afterPid && (!beforePid || afterPid !== beforePid);
    const status = await runCommand(resolve(repoRoot, "scripts/tunnel-client-current.sh"), [
      "runtimes", "--json", "status", alias,
    ], { timeout: 5_000 });
    let tunnelReady = false;
    if (status.code === 0) {
      try {
        const value = JSON.parse(status.stdout);
        tunnelReady = value.process_running === true && value.healthy === true && value.ready === true;
      } catch {
        lastDetail = "tunnel status returned invalid JSON";
      }
    } else {
      lastDetail = diagnosticText(status.stderr || status.stdout || lastDetail);
    }
    if (launchdReady && tunnelReady) {
      return { beforePid, afterPid, tunnelReady: true };
    }
    await sleep(1_000);
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
