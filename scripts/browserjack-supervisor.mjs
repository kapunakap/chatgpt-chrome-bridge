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
const mcpHandshakeTimeoutMs = 5_000;
const maxPendingMcpMessages = 32;
const maxPendingMcpBytes = 1_048_576;
const mcpInitializationErrorCode = -32002;

function parseMcpMessage(line) {
  try {
    const value = JSON.parse(line);
    if (value === null || Array.isArray(value) || typeof value !== "object") return null;
    return value;
  } catch {
    return null;
  }
}

function sameRpcId(left, right) {
  return (typeof left === "string" || typeof left === "number" || left === null) &&
    (typeof right === "string" || typeof right === "number" || right === null) &&
    left === right;
}

export function mcpMessageDisposition(phase, message) {
  if (message?.method === "initialize") return "initialize";
  if (message?.method === "notifications/initialized") return "initialized";
  return phase === "ready" ? "forward" : "buffer";
}

export function pendingMcpMessageFits(count, bytes, line) {
  return count < maxPendingMcpMessages &&
    bytes + Buffer.byteLength(`${line}\n`) <= maxPendingMcpBytes;
}

export function replayInitialization(line, id) {
  const message = parseMcpMessage(line);
  if (!message || message.method !== "initialize") {
    throw new Error("Cannot replay a non-initialize MCP message");
  }
  return JSON.stringify({ ...message, id });
}

export function initializationError(line, reason) {
  const message = parseMcpMessage(line);
  if (message === null || !Object.prototype.hasOwnProperty.call(message, "id")) return null;
  return `${JSON.stringify({
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: mcpInitializationErrorCode,
      message: `MCP initialization is pending: ${reason}`,
    },
  })}\n`;
}

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
  let protocolPhase = "awaiting-init";
  let sessionInitializeLine = null;
  let handshake = null;
  let handshakeTimer = null;
  let pendingTimer = null;
  let pendingMessages = [];
  let pendingBytes = 0;
  let suppressInitializedNotifications = 0;
  let replaySequence = 0;
  let childWriteChain = Promise.resolve();
  let childOutputChain = Promise.resolve();

  function protocolLog(message) {
    process.stderr.write(`browserjack: ${message}\n`);
  }

  function clearHandshakeTimer() {
    if (handshakeTimer) clearTimeout(handshakeTimer);
    handshakeTimer = null;
  }

  function clearPendingTimer() {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
  }

  function writeInitializationError(line, reason) {
    const response = initializationError(line, reason);
    if (response) process.stdout.write(response);
  }

  function rejectPendingMessages(reason) {
    clearPendingTimer();
    const queued = pendingMessages;
    pendingMessages = [];
    pendingBytes = 0;
    for (const item of queued) writeInitializationError(item.line, reason);
  }

  function armPendingTimer() {
    if (pendingTimer || pendingMessages.length === 0) return;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      if (protocolPhase === "ready" || pendingMessages.length === 0) return;
      rejectPendingMessages("initialization timed out");
      protocolLog("dropped buffered MCP requests after initialization timeout");
    }, mcpHandshakeTimeoutMs);
  }

  function queuePendingMessage(line, message) {
    const bytes = Buffer.byteLength(`${line}\n`);
    if (!pendingMcpMessageFits(pendingMessages.length, pendingBytes, line)) {
      writeInitializationError(line, "initialization queue is full");
      protocolLog(`rejected ${typeof message?.method === "string" ? message.method : "message"} while initialization queue was full`);
      return false;
    }
    pendingMessages.push({ line, message, bytes });
    pendingBytes += bytes;
    armPendingTimer();
    return true;
  }

  function writeChildLine(child, line) {
    return new Promise((resolveWrite, rejectWrite) => {
      if (!child?.stdin || child.stdin.destroyed) {
        rejectWrite(new Error("BrowserJack child stdin is unavailable"));
        return;
      }
      const onError = (error) => {
        child.stdin.off("drain", onDrain);
        rejectWrite(error);
      };
      const onDrain = () => {
        child.stdin.off("error", onError);
        resolveWrite();
      };
      child.stdin.once("error", onError);
      if (child.stdin.write(`${line}\n`)) {
        child.stdin.off("error", onError);
        resolveWrite();
      } else {
        child.stdin.once("drain", onDrain);
      }
    });
  }

  function queueChildLine(child, line) {
    childWriteChain = childWriteChain
      .catch(() => {})
      .then(() => writeChildLine(child, line));
    return childWriteChain;
  }

  function armHandshakeTimer(child, expected) {
    clearHandshakeTimer();
    handshakeTimer = setTimeout(() => {
      if (handshake !== expected || activeChild !== child) return;
      const reason = `${expected.kind} MCP initialization timed out`;
      clearHandshakeTimer();
      handshake = null;
      protocolPhase = "awaiting-init";
      if (expected.kind === "external") writeInitializationError(expected.line, "initialization timed out");
      rejectPendingMessages("initialization timed out");
      protocolLog(reason);
      void setBlocked(reason, true);
    }, mcpHandshakeTimeoutMs);
  }

  async function flushPendingMessages(child) {
    if (protocolPhase !== "ready" || activeChild !== child) return;
    while (pendingMessages.length > 0 && protocolPhase === "ready" && activeChild === child) {
      const item = pendingMessages.shift();
      pendingBytes -= item.bytes;
      const method = item.message?.method;
      if (method === "notifications/initialized" && suppressInitializedNotifications > 0) {
        suppressInitializedNotifications -= 1;
        continue;
      }
      if (method === "initialize") {
        await beginExternalHandshake(child, item.line);
        return;
      }
      await queueChildLine(child, item.line);
    }
    if (pendingMessages.length === 0) clearPendingTimer();
  }

  async function completeHandshake(child, response, responseLine) {
    const expected = handshake;
    if (!expected || activeChild !== child || !sameRpcId(response.id, expected.id)) return false;
    clearHandshakeTimer();
    handshake = null;
    if (expected.kind === "external") process.stdout.write(`${responseLine}\n`);
    if (response.error) {
      protocolPhase = "awaiting-init";
      rejectPendingMessages("initialization failed");
      const reason = `${expected.kind} MCP initialization failed`;
      protocolLog(reason);
      if (expected.kind === "replay") void setBlocked(reason, true);
      return true;
    }

    if (expected.kind === "external") sessionInitializeLine = expected.line;
    suppressInitializedNotifications += 1;
    await queueChildLine(child, JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }));
    protocolPhase = "ready";
    protocolLog(`${expected.kind} MCP initialization completed`);
    await flushPendingMessages(child);
    return true;
  }

  async function beginExternalHandshake(child, line) {
    const message = parseMcpMessage(line);
    if (!message || message.method !== "initialize" || !Object.prototype.hasOwnProperty.call(message, "id")) {
      queuePendingMessage(line, message);
      return;
    }
    if (handshake) {
      queuePendingMessage(line, message);
      return;
    }
    protocolPhase = "initializing";
    const expected = {
      kind: "external",
      id: message.id,
      line,
    };
    handshake = expected;
    armHandshakeTimer(child, expected);
    try {
      await queueChildLine(child, line);
    } catch (error) {
      clearHandshakeTimer();
      handshake = null;
      protocolPhase = "awaiting-init";
      writeInitializationError(line, "initialization transport failed");
      rejectPendingMessages("initialization transport failed");
      void setBlocked(`MCP initialization transport failed: ${error.message}`, true);
    }
  }

  async function beginReplayHandshake(child) {
    const original = parseMcpMessage(sessionInitializeLine);
    if (!original || original.method !== "initialize") {
      protocolPhase = "awaiting-init";
      return;
    }
    const replayId = `browserjack-supervisor-init-${++replaySequence}`;
    const expected = {
      kind: "replay",
      id: replayId,
      line: replayInitialization(sessionInitializeLine, replayId),
    };
    protocolPhase = "replaying";
    handshake = expected;
    armHandshakeTimer(child, expected);
    try {
      await queueChildLine(child, expected.line);
    } catch (error) {
      clearHandshakeTimer();
      handshake = null;
      protocolPhase = "awaiting-init";
      rejectPendingMessages("initialization replay transport failed");
      void setBlocked(`MCP initialization replay transport failed: ${error.message}`, true);
    }
  }

  async function handleChildLine(child, line) {
    const message = parseMcpMessage(line);
    if (message && handshake && !Object.prototype.hasOwnProperty.call(message, "method")) {
      if (await completeHandshake(child, message, line)) return;
    }
    process.stdout.write(`${line}\n`);
  }

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
    protocolPhase = sessionInitializeLine ? "replaying" : "awaiting-init";
    handshake = null;
    clearHandshakeTimer();
    const childLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    childLines.on("line", (line) => {
      childOutputChain = childOutputChain
        .then(() => handleChildLine(child, line))
        .catch((error) => {
          if (!stopping && activeChild === child) {
            void setBlocked(`BrowserJack output handling failed: ${error.message}`, true);
          }
        });
    });
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
      childLines.close();
      if (activeChild !== child || stopping || transitioning) return;
      activeChild = null;
      clearHandshakeTimer();
      handshake = null;
      protocolPhase = "awaiting-init";
      const detail = diagnosticText(stderrTail);
      const reason = `BrowserJack child exited${signal ? ` with ${signal}` : ` with code ${code ?? 1}`}${detail ? `: ${detail}` : ""}`;
      void setBlocked(reason, !detail || isTransientBrowserFailure(detail));
    });
    activeChild = child;
    if (sessionInitializeLine) void beginReplayHandshake(child);
  }

  async function setBlocked(reason, retryable = false) {
    blockedReason = reason;
    blockedRetryable = retryable;
    blockedRetryAt = retryable ? Date.now() + retryDelay(retryAttempt) : 0;
    if (retryable) retryAttempt = Math.min(retryAttempt + 1, 4);
    else retryAttempt = 0;
    if (!transitioning) blockedGeneration = activeSnapshot ? runtimeGeneration(activeSnapshot) : null;
    clearHandshakeTimer();
    handshake = null;
    protocolPhase = "awaiting-init";
    rejectPendingMessages(reason);
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
      const message = parseMcpMessage(line);
      const method = message?.method;
      const child = activeChild;
      if (method === "initialize") {
        if (protocolPhase === "awaiting-init" || protocolPhase === "ready") {
          await beginExternalHandshake(child, line);
        } else {
          queuePendingMessage(line, message);
        }
        continue;
      }
      if (method === "notifications/initialized") {
        if (suppressInitializedNotifications > 0) {
          suppressInitializedNotifications -= 1;
          protocolLog("suppressed duplicate notifications/initialized");
        } else if (protocolPhase === "ready") {
          await queueChildLine(child, line);
        }
        continue;
      }
      if (protocolPhase !== "ready") {
        queuePendingMessage(line, message);
        continue;
      }
      await queueChildLine(child, line);
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
