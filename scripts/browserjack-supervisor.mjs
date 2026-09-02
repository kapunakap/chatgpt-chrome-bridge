#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { inspectRuntime, writeApproval } from "./browserjack-fingerprint.mjs";
import { resolveRuntime } from "./browserjack-runtime.mjs";

const defaultManifest = join(
  process.env.HOME || "/Users/unknown",
  "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json",
);
const defaultApp = "/Applications/ChatGPT.app";
const defaultApprovalsFile = join(
  process.env.HOME || "/Users/unknown",
  ".config/chatgpt-browser-bridge/browser-runtime-approvals.json",
);
const defaultPollMs = 5_000;
const maxDiagnosticBytes = 16_384;

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 1_000 && value <= 60_000 ? value : fallback;
}

export function runtimeGeneration(runtime) {
  return [
    runtime.fingerprint,
    runtime.appVersion,
    runtime.buildVersion,
    runtime.pluginVersion,
    Array.isArray(runtime.extensionIds) ? runtime.extensionIds.join(",") : "",
  ].map((value) => String(value ?? "")).join("\u0000");
}

export function generationChanged(previous, current) {
  return runtimeGeneration(previous) !== runtimeGeneration(current);
}

export function blockedResponse(line, reason) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return null;
  }
  if (message === null || Array.isArray(message) || typeof message !== "object") return null;
  if (!Object.prototype.hasOwnProperty.call(message, "id")) return null;
  return `${JSON.stringify({
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: -32001,
      message: `Local Chrome is unavailable: ${reason}`,
    },
  })}\n`;
}

function diagnosticText(value) {
  return String(value ?? "").trim().slice(-maxDiagnosticBytes);
}

function probeFailureText(probe) {
  const stderr = diagnosticText(probe.stderr);
  if (stderr) return stderr;
  try {
    const report = JSON.parse(probe.stdout);
    const live = Array.isArray(report.checks)
      ? report.checks.find((check) => check?.id === "live")
      : null;
    if (typeof live?.summary === "string") return diagnosticText(live.summary);
  } catch {
    // Fall through to the bounded raw output.
  }
  return diagnosticText(probe.stdout);
}

export function isTransientBrowserFailure(value) {
  const text = diagnosticText(value).toLowerCase();
  if (!text) return false;
  if (/(sandbox_apply|strict signature|byte-identical|unexpected|unsupported|protocol|interface|extension metadata)/u.test(text)) {
    return false;
  }
  return /(no browser|no .*backend|chrome .*unavailable|chrome .*not connected|browser .*not connected|native messaging.*(unavailable|connect|running)|connection.*chrome)/u.test(text);
}

export function retryDelay(attempt) {
  return [2_000, 5_000, 15_000, 30_000, 60_000][Math.min(attempt, 4)];
}

function runtimeEnvironment(base, runtime) {
  const env = {
    ...base,
    BROWSERJACK_VALIDATED_RUNTIME_JSON: JSON.stringify(runtime),
    BROWSERJACK_RUNTIME_FINGERPRINT: runtime.fingerprint,
    BROWSERJACK_EXPERIMENT_NATIVE_HOST_NAME: runtime.nativeHostName,
    BROWSERJACK_EXPERIMENT_EXTENSION_ID: runtime.extensionId,
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ browser: runtime.browserServicePath }),
    BROWSER_USE_CODEX_APP_VERSION: runtime.appVersion,
    BROWSER_USE_CODEX_APP_BUILD_VERSION: runtime.buildVersion,
    BROWSER_USE_CODEX_APP_BUILD_FLAVOR: runtime.buildFlavor,
    NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: runtime.nativePipeConnectTimeoutMs,
    BROWSER_USE_AVAILABLE_BACKENDS: runtime.availableBackends,
  };
  delete env.BROWSERJACK_ALLOW_UNAPPROVED_CANDIDATE;
  return env;
}

function runDoctor(cliPath, env) {
  return new Promise((resolveDoctor) => {
    const child = spawn(process.execPath, [cliPath, "doctor", "--live", "--json"], {
      env,
      cwd: env.CODEX_HOME || process.cwd(),
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
      resolveDoctor(result);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-maxDiagnosticBytes); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-maxDiagnosticBytes); });
    child.once("error", (error) => finish({ code: 1, stdout, stderr: error.message }));
    child.once("exit", (code, signal) => finish({
      code: typeof code === "number" ? code : 1,
      signal,
      stdout,
      stderr,
    }));
    timer = setTimeout(() => {
      killGroup(child, "SIGKILL");
      finish({ code: 124, stdout, stderr: `${stderr}\nlive doctor timed out` });
    }, 45_000);
  });
}

function killGroup(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The child may already have exited.
  }
}

async function stopChild(child) {
  if (!child) return;
  killGroup(child, "SIGTERM");
  let exited = false;
  const exit = once(child, "exit").then(() => {
    exited = true;
  }).catch(() => {});
  await Promise.race([
    exit,
    new Promise((resolveStop) => setTimeout(resolveStop, 2_000)),
  ]);
  if (!exited) killGroup(child, "SIGKILL");
}

function parseInvocation() {
  const args = process.argv.slice(2);
  const separator = args.indexOf("--");
  if (separator === -1 || !args[separator + 1]) {
    throw new Error("Supervisor invocation requires -- BROWSERJACK_CLI run");
  }
  const cliPath = args[separator + 1];
  const cliArgs = args.slice(separator + 2);
  if (cliArgs[0] !== "run") throw new Error("Supervisor can only wrap BrowserJack run");
  return { cliPath, cliArgs };
}

async function main() {
  const { cliPath, cliArgs } = parseInvocation();
  const appPath = process.env.CHATGPT_APP_PATH || defaultApp;
  const manifestPath = process.env.BROWSERJACK_MANIFEST_PATH || defaultManifest;
  const approvalsFile = process.env.BROWSERJACK_APPROVAL_FILE || defaultApprovalsFile;
  const pollMs = numberEnv("BROWSERJACK_RUNTIME_POLL_MS", defaultPollMs);
  const baseEnv = { ...process.env };

  let activeSnapshot;
  let activeRuntime;
  let activeChild = null;
  let blockedReason = null;
  let blockedGeneration = null;
  let blockedRetryable = false;
  let blockedRetryAt = 0;
  let retryAttempt = 0;
  let transitioning = false;
  let stopping = false;

  function writeBlockedResponse(line) {
    const response = blockedResponse(line, blockedReason || "runtime revalidation is pending");
    if (response) process.stdout.write(response);
  }

  function startChild(runtime) {
    const child = spawn(process.execPath, [cliPath, ...cliArgs], {
      cwd: runtime.codexHome,
      env: runtimeEnvironment(baseEnv, runtime),
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.pipe(process.stdout, { end: false });
    let stderrTail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-maxDiagnosticBytes);
      process.stderr.write(chunk);
    });
    child.stdin.on("error", () => {});
    child.once("error", (error) => {
      if (!stopping && activeChild === child) {
        activeChild = null;
        void setBlocked(`BrowserJack child could not start: ${error.message}`, true);
      }
    });
    child.once("exit", (code, signal) => {
      if (activeChild !== child || stopping || transitioning) return;
      activeChild = null;
      const detail = diagnosticText(stderrTail);
      const reason = `BrowserJack child exited${signal ? ` with ${signal}` : ` with code ${code ?? 1}`}${detail ? `: ${detail}` : ""}`;
      void setBlocked(reason, !detail || isTransientBrowserFailure(detail));
    });
    activeChild = child;
  }

  async function setBlocked(reason, retryable = false) {
    blockedReason = reason;
    blockedRetryable = retryable;
    blockedRetryAt = retryable ? Date.now() + retryDelay(retryAttempt) : 0;
    if (retryable) retryAttempt = Math.min(retryAttempt + 1, 4);
    else retryAttempt = 0;
    if (!transitioning) blockedGeneration = activeSnapshot ? runtimeGeneration(activeSnapshot) : null;
    const child = activeChild;
    activeChild = null;
    await stopChild(child);
    process.stderr.write(`browserjack: Local Chrome blocked until runtime revalidation succeeds: ${reason}\n`);
  }

  async function revalidate(snapshot) {
    if (transitioning || stopping) return;
    transitioning = true;
    blockedGeneration = runtimeGeneration(snapshot);
    if (activeSnapshot && runtimeGeneration(activeSnapshot) !== blockedGeneration) retryAttempt = 0;
    blockedRetryable = false;
    blockedRetryAt = 0;
    try {
      let candidateRuntime;
      try {
        candidateRuntime = await resolveRuntime({
          appPath,
          manifestPath,
          approvalsFile,
          allowUnapproved: true,
        });
      } catch (error) {
        await setBlocked(`signed runtime resolution failed: ${error.message}`, true);
        return;
      }

      const probe = await runDoctor(cliPath, runtimeEnvironment(baseEnv, candidateRuntime));
      if (probe.code !== 0) {
        const detail = probeFailureText(probe);
        await setBlocked(
          `live compatibility test failed${detail ? `: ${detail}` : ""}`,
          isTransientBrowserFailure(detail),
        );
        return;
      }

      const latest = await inspectRuntime({ appPath, manifestPath, approvalsFile });
      if (runtimeGeneration(latest) !== runtimeGeneration(snapshot)) {
        await setBlocked("ChatGPT.app changed again during live revalidation");
        return;
      }
      if (!latest.approved) {
        await writeApproval(approvalsFile, latest);
        process.stderr.write(`browserjack: locally approved exact runtime ${latest.fingerprint} after live self-test\n`);
      }

      const oldChild = activeChild;
      activeChild = null;
      await stopChild(oldChild);
      activeSnapshot = latest;
      activeRuntime = candidateRuntime;
      blockedReason = null;
      blockedGeneration = null;
      blockedRetryable = false;
      blockedRetryAt = 0;
      retryAttempt = 0;
      startChild(candidateRuntime);
      process.stderr.write(`browserjack: restarted BrowserJack for ChatGPT.app ${latest.appVersion} build ${latest.buildVersion}\n`);
    } catch (error) {
      await setBlocked(`runtime revalidation failed: ${error.message}`);
    } finally {
      transitioning = false;
    }
  }

  try {
    activeSnapshot = await inspectRuntime({ appPath, manifestPath, approvalsFile });
    if (activeSnapshot.approved) {
      activeRuntime = await resolveRuntime({ appPath, manifestPath, approvalsFile });
      startChild(activeRuntime);
    } else {
      await revalidate(activeSnapshot);
    }
  } catch (error) {
    await setBlocked(`initial signed runtime resolution failed: ${error.message}`, true);
  }

  const poll = setInterval(async () => {
    if (stopping || transitioning || !activeSnapshot) return;
    try {
      const current = await inspectRuntime({ appPath, manifestPath, approvalsFile });
      const currentGeneration = runtimeGeneration(current);
      const changed = generationChanged(activeSnapshot, current);
      const retryableFailure = blockedRetryable &&
        blockedGeneration === currentGeneration &&
        Date.now() >= blockedRetryAt;
      if ((changed || retryableFailure) && blockedGeneration !== currentGeneration) {
        await revalidate(current);
      } else if (retryableFailure) {
        await revalidate(current);
      }
    } catch (error) {
      await setBlocked(`runtime inspection failed: ${error.message}`, true);
    }
  }, pollMs);
  poll.unref();

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const handleSignal = (signal) => {
    if (stopping) return;
    stopping = true;
    clearInterval(poll);
    input.close();
    const child = activeChild;
    activeChild = null;
    void stopChild(child).finally(() => {
      process.exit(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
    });
  };
  process.once("SIGINT", () => handleSignal("SIGINT"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));
  process.once("SIGHUP", () => handleSignal("SIGHUP"));
  try {
    for await (const line of input) {
      if (!line) continue;
      if (blockedReason || !activeChild || activeChild.stdin.destroyed) {
        writeBlockedResponse(line);
        continue;
      }
      if (!activeChild.stdin.write(`${line}\n`)) await once(activeChild.stdin, "drain");
    }
  } finally {
    stopping = true;
    clearInterval(poll);
    input.close();
    const child = activeChild;
    activeChild = null;
    await stopChild(child);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`browserjack supervisor: ${error.message}\n`);
    process.exitCode = 1;
  });
}
