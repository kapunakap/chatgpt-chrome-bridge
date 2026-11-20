#!/usr/bin/env node
/**
 * Current-user-only, explicitly opt-in, narrow DevKit endpoint for the
 * existing BrowserJack stdio session. No generic JS, MCP or CDP API.
 */
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { dirname } from "node:path";

const TAB_ID = /^[a-zA-Z0-9_.:-]{1,128}$/;
const REQUEST_ID = /^[a-zA-Z0-9_-]{1,128}$/;
// Leave time for the DevKit agent (4.5s) and cloud route (6s) to return errors.
export const ACTION_TIMEOUT_MS = 3_500;
const RESPONSE_LIMIT = 14_000;
const REQUEST_LIMIT = 30_000;
export function publicOrigin(value) {
  if (typeof value !== "string" || value.length > 2048) throw Error("INVALID_URL");
  let url;
  try { url = new URL(value); } catch { throw Error("INVALID_URL"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !/^[a-z0-9.-]+$/.test(host) || !host.includes(".") || host.endsWith(".") ||
      host.endsWith(".local") || host.endsWith(".internal") ||
      host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
      url.search || url.hash || url.href.length > 2048) throw Error("URL_NOT_ALLOWED");
  return url.origin;
}
function assertOrigin(value) {
  const origin = publicOrigin(value);
  if (origin !== value) throw Error("INVALID_ORIGIN");
  return origin;
}
export function validateDevKitAction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("INVALID_REQUEST");
  const keys = Object.keys(value).sort();
  if (value.op === "tabs_list" && keys.join(",") === "op,origins" &&
      Array.isArray(value.origins) && value.origins.length > 0 && value.origins.length <= 10 &&
      value.origins.every(origin => typeof origin === "string" && origin === publicOrigin(origin))) {
    return { op: "tabs_list", origins: [...new Set(value.origins)] };
  }
  if (value.op === "read" && keys.join(",") === "op,origin,tabId"
      && typeof value.tabId === "string" && TAB_ID.test(value.tabId)) {
    return { op: "read", tabId: value.tabId, origin: assertOrigin(value.origin) };
  }
  if (value.op === "navigate" && keys.join(",") === "op,requestId,url"
      && typeof value.requestId === "string" && REQUEST_ID.test(value.requestId)) {
    publicOrigin(value.url);
    return { op: "navigate", requestId: value.requestId, url: value.url };
  }
  throw Error("INVALID_REQUEST");
}
export function fixedBrowserActionRequest(id, action, { deadlineAt = Date.now() + ACTION_TIMEOUT_MS } = {}) {
  const safe = validateDevKitAction(action);
  if (!Number.isSafeInteger(deadlineAt)) throw Error("INVALID_DEADLINE");
  // The ONLY injected value is a JSON literal of schema-validated fields.
  const code = `
await (async () => {
  const request = ${JSON.stringify(safe)};
  const deadlineAt = ${deadlineAt};
  const requireTime = () => {
    if (Date.now() >= deadlineAt) throw Error("ACTION_DEADLINE_EXCEEDED");
  };
  requireTime();
  let runtime = globalThis.agent;
  let bootstrappedRuntime = false;
  if (typeof runtime?.browsers?.get !== "function") {
    const client = await import("file:///Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/chrome/scripts/browser-client.mjs");
    runtime = await client.setupBrowserRuntime();
    globalThis.agent = runtime;
    bootstrappedRuntime = true;
  }
  // Keep one explicit browser binding. Never silently switch browser/profile.
  let binding = globalThis.__devkitChromeBinding;
  if (!binding || binding.runtime !== runtime) {
    const candidates = (await runtime.browsers.list()).filter(item => item.family === "chrome");
    if (candidates.length !== 1) throw Error("BROWSER_SELECTION_REQUIRED");
    requireTime();
    const browser = await runtime.browsers.get(candidates[0].id);
    if (bootstrappedRuntime) await browser.nameSession("🔎 DevKit Chrome");
    binding = { runtime, browser, ownedTabs: new Map() };
    globalThis.__devkitChromeBinding = binding;
  }
  const chrome = binding.browser;
  const origin = input => {
    try {
      const url = new URL(input);
      return url.protocol === "https:" && !url.username && !url.password ? url.origin : "";
    } catch { return ""; }
  };
  let result;
  if (request.op === "tabs_list") {
    requireTime();
    const [userTabs, ownedTabs] = await Promise.all([chrome.user.openTabs(), chrome.tabs.list()]);
    const seen = new Set();
    const tabs = [...userTabs, ...ownedTabs].filter(tab => {
      if (!request.origins.includes(origin(tab.url)) || seen.has(String(tab.id))) return false;
      seen.add(String(tab.id));
      return true;
    });
    result = { tabs: tabs.slice(0, 20).map(tab => ({
      id: String(tab.id).slice(0, 128), origin: origin(tab.url),
      title: String(tab.title ?? "").slice(0, 200),
    })) };
  } else if (request.op === "read") {
    requireTime();
    const owned = binding.ownedTabs.get(request.tabId);
    let tab = owned;
    if (!tab) {
      const tabs = await chrome.user.openTabs();
      const selected = tabs.find(item => String(item.id) === request.tabId && origin(item.url) === request.origin);
      requireTime();
      if (selected) {
        // Claim only the exact freshly observed user tab on the granted origin.
        tab = await chrome.user.claimTab(selected);
      } else {
        const controlled = await chrome.tabs.list();
        if (!controlled.some(item => String(item.id) === request.tabId && origin(item.url) === request.origin)) throw Error("TAB_ORIGIN_DENIED");
        requireTime();
        tab = await chrome.tabs.get(request.tabId);
      }
    }
    if (origin(await tab.url()) !== request.origin) throw Error("TAB_ORIGIN_DENIED");
    const title = await tab.title();
    requireTime();
    const snapshot = await tab.playwright.domSnapshot();
    if (typeof snapshot !== "string" || /^(?:Error:|Tool error:|Browser Use rejected this action)/i.test(snapshot.trimStart())) {
      throw Error("INVALID_BROWSER_SNAPSHOT");
    }
    if (origin(await tab.url()) !== request.origin) throw Error("TAB_ORIGIN_CHANGED");
    result = { tabId: request.tabId, origin: request.origin,
      title: String(title).slice(0, 200), text: String(snapshot).slice(0, 8000) };
  } else if (request.op === "navigate") {
    requireTime();
    const tab = await chrome.tabs.new();
    try {
      requireTime();
      await tab.goto(request.url);
    } catch (error) {
      await tab.close().catch(() => undefined);
      throw error;
    }
    if (origin(await tab.url()) !== origin(request.url)) {
      await tab.close().catch(() => undefined);
      throw Error("NAVIGATION_REDIRECTED");
    }
    // The requested opened page must survive the bridge's internal tool turn.
    await tab.markDeliverable();
    binding.ownedTabs.set(String(tab.id), tab);
    result = { tabId: String(tab.id), origin: origin(await tab.url()),
      title: String(await tab.title()).slice(0, 200) };
  }
  nodeRepl.write(JSON.stringify(result));
})();`;
  return { jsonrpc: "2.0", id, method: "tools/call",
    params: { name: "js", arguments: { code, title: "DevKit approved Chrome action" } } };
}
export function browserActionResult(message, op) {
  if (message?.error || message?.result?.isError === true) throw Error("BROWSER_ACTION_FAILED");
  if (message?.result?.structuredContent && Object.hasOwn(message.result.structuredContent, "error")) throw Error("BROWSER_ACTION_FAILED");
  const items = message?.result?.content;
  if (!Array.isArray(items)) throw Error("INVALID_BROWSER_RESULT");
  const candidates = [];
  for (const item of items) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    if (/^(?:Error:|Tool error:|Browser Use rejected this action)/i.test(item.text.trimStart())) throw Error("BROWSER_ACTION_FAILED");
    try {
      const value = JSON.parse(item.text);
      if (value && typeof value === "object" && !Array.isArray(value) &&
          (Object.hasOwn(value, "error") || Object.hasOwn(value, "tabs") || Object.hasOwn(value, "tabId"))) candidates.push(value);
    } catch { /* ignore diagnostic text */ }
  }
  if (candidates.length !== 1 || Object.hasOwn(candidates[0], "error")) throw Error("INVALID_BROWSER_RESULT");
  const data = candidates[0];
  if (op === "tabs_list") {
    if (!Array.isArray(data.tabs) || data.tabs.length > 20) throw Error("INVALID_BROWSER_RESULT");
    if (!data.tabs.every(tab =>
      tab && typeof tab.id === "string" && TAB_ID.test(tab.id) &&
      typeof tab.origin === "string" && typeof tab.title === "string" && assertOrigin(tab.origin)
    )) throw Error("INVALID_BROWSER_RESULT");
    return { tabs: data.tabs.map(tab => ({ id: tab.id, origin: tab.origin,
      title: tab.title.slice(0, 200) })) };
  }
  if (typeof data.tabId !== "string" || !TAB_ID.test(data.tabId) ||
      typeof data.origin !== "string" || typeof data.title !== "string") throw Error("INVALID_BROWSER_RESULT");
  assertOrigin(data.origin);
  if (op === "read" && typeof data.text !== "string") throw Error("INVALID_BROWSER_RESULT");
  if (op === "read" && /^(?:Error:|Tool error:|Browser Use rejected this action)/i.test(data.text.trimStart())) throw Error("INVALID_BROWSER_RESULT");
  return { tabId: data.tabId, origin: data.origin.slice(0, 256),
    title: data.title.slice(0, 200),
    ...(op === "read" ? { text: data.text.slice(0, 8000) } : {}) };
}
async function safePath(path) {
  const parentPath = dirname(path);
  await mkdir(parentPath, { recursive: true, mode: 0o700 });
  const parent = await lstat(parentPath);
  if (!parent.isDirectory() || parent.isSymbolicLink() ||
    parent.uid !== process.getuid() || (parent.mode & 0o077) !== 0) throw Error("INSECURE_SOCKET_PARENT");
  try {
    const item = await lstat(path);
    if (!item.isSocket() || item.uid !== process.getuid()) throw Error("INSECURE_SOCKET_PATH");
    const exists = await new Promise(resolve => {
      const test = createConnection(path);
      test.setTimeout(200, () => { test.destroy(); resolve(true); });
      test.once("connect", () => { test.destroy(); resolve(true); });
      test.once("error", err => resolve(err.code !== "ENOENT" && err.code !== "ECONNREFUSED"));
    });
    if (exists) throw Error("SOCKET_ALREADY_LIVE");
    await unlink(path);
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
}
export function createDevKitActionHandler({ invoke, actionTimeoutMs = ACTION_TIMEOUT_MS }) {
  if (!Number.isInteger(actionTimeoutMs) || actionTimeoutMs < 1 || actionTimeoutMs > ACTION_TIMEOUT_MS) throw Error("INVALID_ACTION_TIMEOUT");
  const attempts = new Map(); // Includes unknown outcomes; never replay an uncertain write.
  let queue = Promise.resolve(); // BrowserJack is a single-process REPL
  return socket => {
    let input = "";
    const deadlineAt = Date.now() + actionTimeoutMs;
    let closed = false, replied = false, writeStarted = false, expire;
    const deadline = new Promise(resolve => { expire = resolve; });
    const reply = result => {
      if (closed || replied) return;
      replied = true;
      clearTimeout(timer);
      const encoded = JSON.stringify(result);
      socket.end(Buffer.byteLength(encoded + "\n") <= RESPONSE_LIMIT ? encoded + "\n" : '{"error":"RESPONSE_TOO_LARGE"}\n');
    };
    const timer = setTimeout(() => {
      const result = { error: writeStarted ? "NAVIGATION_OUTCOME_UNKNOWN" : "ACTION_DEADLINE_EXCEEDED" };
      expire(result);
      reply(result);
    }, actionTimeoutMs);
    socket.once("close", () => { closed = true; clearTimeout(timer); expire({ error: "CLIENT_DISCONNECTED" }); });
    socket.on("error", () => undefined);
    socket.on("data", chunk => {
      input += chunk.toString("utf8");
      if (Buffer.byteLength(input) > REQUEST_LIMIT) socket.destroy();
    });
    socket.once("end", () => {
      const work = queue.then(async () => {
        let action;
        try {
          if (closed || replied || Date.now() >= deadlineAt) throw Error("ACTION_DEADLINE_EXCEEDED");
          action = validateDevKitAction(JSON.parse(input));
          if (action.op === "navigate") {
            const previous = attempts.get(action.requestId);
            if (previous) {
              if (previous.url !== action.url) throw Error("REQUEST_CONFLICT");
              return previous.result;
            }
            if (attempts.size >= 100) throw Error("NAVIGATION_SESSION_LIMIT");
            // Save before dispatch: even a failed/lost response must not rerun the write.
            attempts.set(action.requestId, { url: action.url, result: { error: "NAVIGATION_OUTCOME_UNKNOWN" } });
            writeStarted = true;
          }
          const response = await invoke(fixedBrowserActionRequest(randomUUID(), action, { deadlineAt }), { deadlineAt });
          const result = browserActionResult(response, action.op);
          if (action.op === "navigate") {
            if (result.origin !== publicOrigin(action.url)) throw Error("NAVIGATION_REDIRECTED");
            attempts.set(action.requestId, { url: action.url, result });
          }
          return result;
        } catch (error) {
          const code = /^(INVALID_REQUEST|INVALID_URL|INVALID_ORIGIN|URL_NOT_ALLOWED|REQUEST_CONFLICT|NAVIGATION_REDIRECTED|NAVIGATION_SESSION_LIMIT|ACTION_DEADLINE_EXCEEDED)$/.test(error?.message)
            ? error.message : writeStarted ? "NAVIGATION_OUTCOME_UNKNOWN" : "BROWSER_UNAVAILABLE";
          return { error: code };
        }
      });
      const boundedWork = Promise.race([work, deadline]);
      // Preserve ordering even after a caller closes. The internal invocation has
      // its own bounded deadline; a reply timeout must not start a second call.
      queue = work.then(() => undefined, () => undefined);
      boundedWork.then(reply).catch(() => reply({ error: "BROWSER_UNAVAILABLE" }));
    });
  };
}

export async function createDevKitActionServer({ socketPath, invoke, actionTimeoutMs = ACTION_TIMEOUT_MS }) {
  const handler = createDevKitActionHandler({ invoke, actionTimeoutMs });
  await safePath(socketPath);
  const server = createServer({ allowHalfOpen: true }, handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  const identity = await lstat(socketPath);
  const close = async () => {
    await new Promise(resolve => server.close(resolve));
    const current = await lstat(socketPath).catch(() => undefined);
    if (current?.isSocket() && current.dev === identity.dev && current.ino === identity.ino) await unlink(socketPath);
  };
  return { server, close };
}
