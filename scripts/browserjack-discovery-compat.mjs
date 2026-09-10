#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  unlink,
} from "node:fs/promises";
import {
  lstatSync,
  unlinkSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { constants as osConstants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Transform } from "node:stream";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = process.env.BROWSERJACK_DISCOVERY_UPSTREAM
  ?? resolve(repoRoot, "scripts/browserjack-current.sh");
const healthSocketPath = process.env.BROWSERJACK_HEALTH_SOCKET ?? join(
  homedir(),
  ".config/chatgpt-browser-bridge/browserjack-live-health.sock",
);
const browserClientUrl = "file:///Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/chrome/scripts/browser-client.mjs";
const maxHealthRequestBytes = 64;
const healthProbeTimeoutMs = 30_000;
const healthIdPrefix = `__chatgpt_chrome_bridge_health__:${process.pid}:`;
process.umask(0o077);

process.stdout.on("error", (error) => {
  if (error?.code === "EPIPE") {
    process.exitCode = 0;
    return;
  }
  throw error;
});

process.on("uncaughtException", (error) => {
  if (error?.code === "EPIPE") {
    process.exit(0);
  }
  throw error;
});

function safeScalar(value) {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    const rendered = JSON.stringify(value);
    return rendered.length <= 128 ? rendered : `${rendered.slice(0, 125)}...`;
  }
  return "<invalid>";
}

function traceRequest(sequence, method, id, action) {
  process.stderr.write(
    `browserjack_discovery_compat sequence=${sequence} method=${safeScalar(method)} id=${safeScalar(id)} action=${action}\n`,
  );
}

class LineTransform extends Transform {
  constructor(processRecord) {
    super();
    this.buffer = Buffer.alloc(0);
    this.processRecord = processRecord;
  }

  _transform(chunk, _encoding, callback) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let newline;
    while ((newline = this.buffer.indexOf(0x0a)) !== -1) {
      const record = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      this.processRecord(record, Buffer.from("\n"), this);
    }
    callback();
  }

  _flush(callback) {
    if (this.buffer.length > 0) {
      this.processRecord(this.buffer, Buffer.alloc(0), this);
    }
    callback();
  }
}

function parseRecord(record) {
  const parseTarget = record.length > 0 && record[record.length - 1] === 0x0d
    ? record.subarray(0, -1)
    : record;
  try {
    return JSON.parse(parseTarget.toString("utf8"));
  } catch {
    return undefined;
  }
}

function exitCode(code, signal) {
  if (typeof code === "number") return code;
  if (signal && osConstants.signals[signal]) return 128 + osConstants.signals[signal];
  return 1;
}

function forwardSignals(child) {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      child.kill(signal);
    });
  }
}

function runPassthrough(args) {
  const child = spawn(upstream, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  forwardSignals(child);
  child.once("error", (error) => {
    process.stderr.write(`browserjack_discovery_compat spawn_error=${JSON.stringify(error.message)}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = exitCode(code, signal);
  });
}

function socketIsLive(path) {
  return new Promise((resolveLive, rejectLive) => {
    const client = createConnection(path);
    let finished = false;
    const finish = (live) => {
      if (finished) return;
      finished = true;
      client.destroy();
      resolveLive(live);
    };
    client.setTimeout(250, () => {
      if (finished) return;
      finished = true;
      client.destroy();
      rejectLive(new Error("Existing BrowserJack health socket did not answer safely"));
    });
    client.once("connect", () => finish(true));
    client.once("error", (error) => {
      if (error?.code === "ECONNREFUSED" || error?.code === "ENOENT") {
        finish(false);
        return;
      }
      if (finished) return;
      finished = true;
      rejectLive(error);
    });
  });
}

async function prepareSocketPath(path) {
  if (!path.startsWith("/")) {
    throw new Error("BrowserJack health socket path must be absolute");
  }
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.uid !== process.getuid()) {
    throw new Error("BrowserJack health socket parent must be a current-user directory");
  }
  await chmod(parent, 0o700);

  let socketStat;
  try {
    socketStat = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!socketStat.isSocket() || socketStat.uid !== process.getuid()) {
    throw new Error("Refusing to replace a non-socket or foreign BrowserJack health path");
  }
  if (await socketIsLive(path)) {
    throw new Error("BrowserJack health socket is already active");
  }
  await unlink(path);
}

function healthFailure(error) {
  const text = error instanceof Error ? error.message : String(error ?? "");
  const userUnavailable = /\buser unavailable\b/iu.test(text);
  const readinessTimedOut = /\bBrowserJack readiness probe timed out\b/u.test(text);
  const chromeDiscovered = /health_stage=(?:user-binding|tabs-list)/u.test(text);
  const userBindingUsable = /health_stage=tabs-list/u.test(text);
  return {
    ok: false,
    chromeDiscovered,
    userBindingUsable,
    tabsApiUsable: false,
    failureKind: userUnavailable
      ? "user-unavailable"
      : readinessTimedOut ? "readiness-timeout" : "other",
    error: userUnavailable
      ? "User unavailable"
      : readinessTimedOut ? "BrowserJack readiness probe timed out" : "BrowserJack readiness probe failed",
  };
}

function readinessFromToolResponse(message) {
  if (message?.error || message?.result?.isError === true) {
    throw new Error(JSON.stringify(message?.error ?? message?.result ?? {}));
  }
  const content = message?.result?.content;
  if (!Array.isArray(content)) throw new Error("BrowserJack probe returned no content");
  for (const item of content) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    let value;
    try {
      value = JSON.parse(item.text);
    } catch {
      continue;
    }
    if (
      value !== null
      && typeof value === "object"
      && value.chromeDiscovered === true
      && value.userBindingUsable === true
      && value.tabsApiUsable === true
    ) {
      return {
        ok: true,
        chromeDiscovered: true,
        userBindingUsable: true,
        tabsApiUsable: true,
      };
    }
  }
  throw new Error("BrowserJack probe returned unexpected readiness content");
}

function fixedProbeRequest(id) {
  const code = `
    await (async () => {
      let healthStage = 'setup-runtime';
      try {
        let healthAgent = globalThis.agent;
        let healthBootstrappedAgent = false;
        if (typeof healthAgent?.browsers?.list !== 'function') {
          const healthClient = await import(${JSON.stringify(browserClientUrl)});
          healthAgent = await healthClient.setupBrowserRuntime();
          globalThis.agent = healthAgent;
          healthBootstrappedAgent = true;
        }
        healthStage = 'discovery';
        const healthBackends = await healthAgent.browsers.list();
        const healthChromeSummary = healthBackends.find((backend) => backend.family === 'chrome');
        if (!healthChromeSummary) throw new Error('Chrome backend is not connected');
        const healthChrome = await healthAgent.browsers.get('chrome');
        healthStage = 'user-binding';
        if (typeof healthChrome.nameSession !== 'function') throw new Error('Chrome backend does not expose nameSession()');
        if (healthBootstrappedAgent) {
          await healthChrome.nameSession('chatgpt-chrome-bridge-health');
        }
        healthStage = 'tabs-list';
        if (typeof healthChrome.tabs?.list !== 'function') throw new Error('Chrome backend does not expose tabs.list()');
        await healthChrome.tabs.list();
        nodeRepl.write(JSON.stringify({
          chromeDiscovered: true,
          userBindingUsable: true,
          tabsApiUsable: true,
        }));
      } catch (error) {
        throw new Error('health_stage=' + healthStage + ': ' + String(error));
      }
    })();
  `;
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "js",
      arguments: { code, title: "Check Local Chrome readiness" },
    },
  };
}

async function createHealthServer({ child, pending, reservedIds }) {
  await prepareSocketPath(healthSocketPath);
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let request = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      request = Buffer.concat([request, chunk]);
      if (request.length > maxHealthRequestBytes) socket.destroy();
    });
    socket.once("end", async () => {
      if (request.toString("utf8").trim() !== '{"op":"probe"}') {
        socket.end(`${JSON.stringify({ ok: false, error: "invalid request" })}\n`);
        return;
      }
      const id = `${healthIdPrefix}${randomUUID()}`;
      reservedIds.add(id);
      try {
        const response = await new Promise((resolveProbe, rejectProbe) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            rejectProbe(new Error("BrowserJack readiness probe timed out"));
          }, healthProbeTimeoutMs);
          pending.set(id, {
            resolve: (message) => {
              clearTimeout(timer);
              resolveProbe(message);
            },
            reject: (error) => {
              clearTimeout(timer);
              rejectProbe(error);
            },
          });
          child.stdin.write(`${JSON.stringify(fixedProbeRequest(id))}\n`, (error) => {
            if (!error) return;
            clearTimeout(timer);
            pending.delete(id);
            reservedIds.delete(id);
            rejectProbe(error);
          });
        });
        socket.end(`${JSON.stringify(readinessFromToolResponse(response))}\n`);
      } catch (error) {
        socket.end(`${JSON.stringify(healthFailure(error))}\n`);
      }
    });
    socket.on("error", () => {});
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(healthSocketPath, resolveListen);
  });
  await chmod(healthSocketPath, 0o600);
  const identity = await lstat(healthSocketPath);
  return { server, identity };
}

function removeOwnedSocket(identity) {
  try {
    const current = lstatSync(healthSocketPath);
    if (current.isSocket() && current.dev === identity.dev && current.ino === identity.ino) {
      unlinkSync(healthSocketPath);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      process.stderr.write(`browserjack_discovery_compat socket_cleanup_error=${JSON.stringify(error.message)}\n`);
    }
  }
}

async function runProxy(args) {
  const child = spawn(upstream, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  forwardSignals(child);
  child.stderr.pipe(process.stderr);
  child.stdin.on("error", (error) => {
    if (error.code !== "EPIPE") throw error;
  });
  const childDone = new Promise((resolveChild) => {
    child.once("error", (error) => resolveChild({ error }));
    child.once("exit", (code, signal) => resolveChild({ code, signal }));
  });

  const pending = new Map();
  const reservedIds = new Set();
  let sequence = 0;
  const input = new LineTransform((record, delimiter, stream) => {
    const message = parseRecord(record);
    if (message === null || Array.isArray(message) || typeof message !== "object") {
      stream.push(Buffer.concat([record, delimiter]));
      return;
    }
    if (typeof message.method === "string") {
      sequence += 1;
      const hasId = Object.prototype.hasOwnProperty.call(message, "id");
      const action = message.method === "server/discover" ? "reject" : "forward";
      traceRequest(sequence, message.method, hasId ? message.id : undefined, action);
      if (message.method === "server/discover") {
        if (hasId) {
          process.stdout.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Method not found" },
          })}\n`);
        }
        return;
      }
    }
    stream.push(Buffer.concat([record, delimiter]));
  });
  process.stdin.pipe(input).pipe(child.stdin);

  const output = new LineTransform((record, delimiter, stream) => {
    const message = parseRecord(record);
    const isObject = message !== null && typeof message === "object" && !Array.isArray(message);
    const isResponse = isObject
      && reservedIds.has(message.id)
      && typeof message.method !== "string"
      && (Object.prototype.hasOwnProperty.call(message, "result")
        || Object.prototype.hasOwnProperty.call(message, "error"));
    if (isResponse) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      waiter?.resolve(message);
      return;
    }
    stream.push(Buffer.concat([record, delimiter]));
  });
  child.stdout.pipe(output).pipe(process.stdout);

  let health;
  try {
    health = await createHealthServer({ child, pending, reservedIds });
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
  process.once("exit", () => removeOwnedSocket(health.identity));
  const result = await childDone;
  for (const waiter of pending.values()) {
    waiter.reject(result.error ?? new Error("BrowserJack exited during readiness probe"));
  }
  pending.clear();
  reservedIds.clear();
  await new Promise((resolveClose) => health.server.close(resolveClose));
  removeOwnedSocket(health.identity);
  if (result.error) {
    process.stderr.write(`browserjack_discovery_compat spawn_error=${JSON.stringify(result.error.message)}\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = exitCode(result.code, result.signal);
}

const args = process.argv.slice(2);
if (args[0] === "run") {
  runProxy(args).catch((error) => {
    process.stderr.write(`browserjack_discovery_compat health_socket_error=${JSON.stringify(error.message)}\n`);
    process.exitCode = 1;
  });
} else {
  runPassthrough(args);
}
