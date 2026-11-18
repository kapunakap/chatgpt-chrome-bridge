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
export function fixedBrowserActionRequest(id, action) {
  const safe = validateDevKitAction(action);
  // The ONLY injected value is a JSON literal of schema-validated fields.
  const code = `
await (async () => {
  const request = ${JSON.stringify(safe)};
  let runtime = globalThis.agent;
  if (typeof runtime?.browsers?.get !== "function") {
    const client = await import("file:///Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/chrome/scripts/browser-client.mjs");
    runtime = await client.setupBrowserRuntime();
    globalThis.agent = runtime;
  }
  const chrome = await runtime.browsers.get("chrome");
  const origin = input => {
    const url = new URL(input);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : "";
  };
  let result;
  if (request.op === "tabs_list") {
    const tabs = await chrome.tabs.list();
    result = { tabs: tabs.filter(tab => request.origins.includes(origin(tab.url))).slice(0, 20).map(tab => ({
      id: String(tab.id).slice(0, 128), origin: origin(tab.url),
      title: String(tab.title ?? "").slice(0, 200),
    })) };
  } else if (request.op === "read") {
    const tab = await chrome.tabs.get(request.tabId);
    if (origin(await tab.url()) !== request.origin) throw Error("TAB_ORIGIN_DENIED");
    const title = await tab.title();
    const snapshot = await tab.playwright.domSnapshot();
    if (origin(await tab.url()) !== request.origin) throw Error("TAB_ORIGIN_CHANGED");
    result = { tabId: request.tabId, origin: request.origin,
      title: String(title).slice(0, 200), text: String(snapshot).slice(0, 8000) };
  } else if (request.op === "navigate") {
    const tab = await chrome.tabs.new();
    await tab.goto(request.url);
    if (origin(await tab.url()) !== origin(request.url)) {
      await tab.close().catch(() => undefined);
      throw Error("NAVIGATION_REDIRECTED");
    }
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
  const items = message?.result?.content;
  if (!Array.isArray(items)) throw Error("INVALID_BROWSER_RESULT");
  let data;
  for (const item of items) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    try { data = JSON.parse(item.text); break; } catch { /* ignore diagnostic text */ }
  }
  if (!data || typeof data !== "object") throw Error("INVALID_BROWSER_RESULT");
  if (op === "tabs_list") {
    if (!Array.isArray(data.tabs) || data.tabs.length > 20) throw Error("INVALID_BROWSER_RESULT");
    return { tabs: data.tabs.filter(tab =>
      tab && typeof tab.id === "string" && TAB_ID.test(tab.id) &&
      typeof tab.origin === "string" && typeof tab.title === "string"
    ).map(tab => ({ id: tab.id, origin: tab.origin.slice(0, 256),
      title: tab.title.slice(0, 200) })) };
  }
  if (typeof data.tabId !== "string" || !TAB_ID.test(data.tabId) ||
      typeof data.origin !== "string" || typeof data.title !== "string") throw Error("INVALID_BROWSER_RESULT");
  if (op === "read" && typeof data.text !== "string") throw Error("INVALID_BROWSER_RESULT");
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
export async function createDevKitActionServer({ socketPath, invoke }) {
  await safePath(socketPath);
  const completed = new Map(); // idempotent during this owner process only
  let queue = Promise.resolve(); // BrowserJack is a single-process REPL
  const server = createServer({ allowHalfOpen: true }, socket => {
    let input = "";
    socket.setTimeout(7_000, () => socket.destroy());
    socket.on("error", () => undefined);
    socket.on("data", chunk => {
      input += chunk.toString("utf8");
      if (Buffer.byteLength(input) > 1200) socket.destroy();
    });
    socket.once("end", () => {
      const work = queue.then(async () => {
        let action;
        try {
          action = validateDevKitAction(JSON.parse(input));
          if (action.op === "navigate") {
            const previous = completed.get(action.requestId);
            if (previous) {
              if (previous.url !== action.url) throw Error("REQUEST_CONFLICT");
              return previous.result;
            }
          }
          const response = await invoke(fixedBrowserActionRequest(randomUUID(), action));
          const result = browserActionResult(response, action.op);
          if (action.op === "navigate") {
            if (result.origin !== publicOrigin(action.url)) throw Error("NAVIGATION_REDIRECTED");
            completed.set(action.requestId, { url: action.url, result });
            if (completed.size > 100) completed.delete(completed.keys().next().value);
          }
          return result;
        } catch (error) {
          const code = /^(INVALID_REQUEST|INVALID_URL|INVALID_ORIGIN|URL_NOT_ALLOWED|REQUEST_CONFLICT|NAVIGATION_REDIRECTED)$/.test(error?.message)
            ? error.message : "BROWSER_UNAVAILABLE";
          return { error: code };
        }
      });
      queue = work.then(() => undefined, () => undefined);
      work.then(result => {
        const encoded = JSON.stringify(result);
        socket.end(encoded.length <= 14000 ? encoded + "\n" : '{"error":"RESPONSE_TOO_LARGE"}\n');
      }).catch(() => socket.end('{"error":"BROWSER_UNAVAILABLE"}\n'));
    });
  });
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