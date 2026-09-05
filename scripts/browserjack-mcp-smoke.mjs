#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = process.env.BROWSERJACK_COMMAND ?? resolve(repoRoot, "scripts/browserjack-current.sh");
const timeoutMs = 45_000;
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
  stderr = `${stderr}${chunk}`.slice(-16_384);
});

const pending = new Map();
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const waiter = pending.get(message.id);
  if (waiter) {
    pending.delete(message.id);
    waiter.resolve(message);
  }
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(id, method, params) {
  return new Promise((resolveRequest, rejectRequest) => {
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function rejectPending(error) {
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
}

child.once("error", (error) => rejectPending(new Error(`BrowserJack process failed to start: ${error.message}`)));
child.once("exit", (code, signal) => {
  if (pending.size === 0) return;
  rejectPending(new Error(`BrowserJack exited before completing MCP smoke (${signal ?? `code ${code ?? 1}`})`));
});

const timeout = setTimeout(() => {
  rejectPending(new Error("BrowserJack MCP smoke test timed out"));
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The child may already have exited.
    }
  }
}, timeoutMs);

try {
  const initialized = await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "chatgpt-browser-bridge-smoke", version: "1" },
  });
  if (initialized.error) throw new Error(`MCP initialize failed: ${initialized.error.message}`);

  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const toolsResponse = await request(2, "tools/list", {});
  const tools = toolsResponse.result?.tools ?? [];
  if (!tools.some((tool) => tool.name === "js")) throw new Error("BrowserJack did not expose the js tool");

  const instructions = initialized.result?.instructions ?? "";
  const browserClientUrl = instructions.match(/file:\/\/\S+browser-client\.mjs/)?.[0];
  if (!browserClientUrl) throw new Error("BrowserJack did not expose its verified browser-client URL");

  const sessionId = `bridge-smoke-${randomUUID()}`;
  const code = `
    var smokeStage = 'import-client';
    var smokeTab;
    try {
    var smokeClient = await import(${JSON.stringify(browserClientUrl)});
    smokeStage = 'setup-runtime';
    globalThis.agent = await smokeClient.setupBrowserRuntime();
    smokeStage = 'list-browsers';
    var smokeBackends = await agent.browsers.list();
    if (!smokeBackends.some((backend) => backend.family === "chrome")) {
      await new Promise((resolveRetry) => setTimeout(resolveRetry, 2000));
      smokeBackends = await agent.browsers.list();
    }
    var smokeBackendSummary = smokeBackends.map((backend) => ({
      family: backend.family,
      name: backend.name,
      type: backend.type,
    }));
    var smokeChrome;
    smokeStage = 'get-chrome';
    try {
      smokeChrome = await agent.browsers.get("chrome");
    } catch (error) {
      throw new Error(
        "Chrome unavailable; backends=" + JSON.stringify(smokeBackendSummary) +
        "; cause=" + String(error),
      );
    }
    smokeStage = 'browser-documentation';
    await smokeChrome.documentation();
    smokeStage = 'create-tab';
    smokeTab = await smokeChrome.tabs.new();
    smokeStage = 'navigate-example';
    await smokeTab.goto("https://example.com");
    smokeStage = 'wait-dom';
    await smokeTab.playwright.waitForLoadState({ state: "domcontentloaded", timeoutMs: 10000 });
    smokeStage = 'read-title';
    var smokeTitle = await smokeTab.title();
    smokeStage = 'close-tab';
    await smokeTab.close();
    smokeTab = undefined;
    nodeRepl.write(JSON.stringify({
      chromeAvailable: smokeBackends.some((backend) => backend.family === "chrome" || backend.type === "extension"),
      title: smokeTitle,
    }));
    } catch (error) { throw new Error('smoke_stage=' + smokeStage + ': ' + String(error)); }
    finally { if (smokeTab) { try { await smokeTab.close(); } catch { nodeRepl.write('smoke_cleanup_failed=true'); } } }
  `;
  const toolResponse = await request(3, "tools/call", {
    name: "js",
    arguments: { code, title: "Verify Local Chrome bridge" },
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
    const failure = JSON.stringify(toolResponse.error ?? toolResponse.result ?? {});
    throw new Error(`BrowserJack browser smoke call failed: ${failure}`);
  }

  const rendered = JSON.stringify(toolResponse.result?.content ?? []);
  if (!rendered.includes("Example Domain") || !rendered.includes("chromeAvailable\\\":true")) {
    throw new Error(`Unexpected browser smoke result: ${rendered}`);
  }

  console.log("mcp_initialized=true");
  console.log("js_tool_discovered=true");
  console.log("chrome_backend_available=true");
  console.log("example_title=Example Domain");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (stderr) console.error(`browserjack_stderr=${stderr}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  child.stdin.end();
  lines.close();
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Child already exited.
    }
  }
}
