/**
 * Optional ownership of the existing tunnel-launched BrowserJack child.
 * This module never launches a runtime, accepts caller JS, forwards host state,
 * grants browser access, or changes signed-runtime validation.
 */
import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, isAbsolute } from "node:path";

const PROTOCOL_VERSION = "2025-06-18";
const OWNER_KIND = "browserjack-session-owner-v1";
const MODES = new Set(["hosted", "devkit"]);

export function sessionOwnerMode(environment) {
  const mode = environment.BROWSERJACK_DEVKIT_SESSION_OWNER ?? "hosted";
  if (!MODES.has(mode)) throw Error("INVALID_BROWSER_SESSION_OWNER");
  if (mode === "devkit" && environment.BROWSERJACK_DEVKIT_ACTIONS_ENABLED !== "true") {
    throw Error("DEVKIT_OWNER_REQUIRES_ACTION_SOCKET_OPT_IN");
  }
  return mode;
}

/** No hosted input reaches the child in DevKit-exclusive mode. */
export function rejectHostedRequest(message) {
  if (!message || typeof message !== "object" || Array.isArray(message) ||
      !Object.hasOwn(message, "id") ||
      !(typeof message.id === "string" || typeof message.id === "number" || message.id === null)) return null;
  return {
    jsonrpc: "2.0", id: message.id,
    error: { code: -32003, message: "This browser session is reserved for DevKit. Hosted Local Chrome calls are unavailable in this service mode." },
  };
}

/** The owner advertises no elicitation, sampling, roots, or credential handling. */
export function rejectUnsupportedChildRequest(message) {
  if (!message || typeof message !== "object" || Array.isArray(message) ||
      typeof message.method !== "string" || !Object.hasOwn(message, "id")) return null;
  return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Client method is not supported by the DevKit session owner." } };
}

export function fixedDevKitReadinessRequest(id) {
  const code = `
await (async () => {
  let runtime = globalThis.agent;
  let bootstrappedRuntime = false;
  if (typeof runtime?.browsers?.get !== "function") {
    const client = await import("file:///Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/chrome/scripts/browser-client.mjs");
    runtime = await client.setupBrowserRuntime();
    globalThis.agent = runtime;
    bootstrappedRuntime = true;
  }
  let binding = globalThis.__devkitChromeBinding;
  if (!binding || binding.runtime !== runtime) {
    const candidates = (await runtime.browsers.list()).filter(item => item.family === "chrome");
    if (candidates.length !== 1 || typeof candidates[0].id !== "string" || !candidates[0].id) throw Error("BROWSER_SELECTION_REQUIRED");
    const browser = await runtime.browsers.get(candidates[0].id);
    if (bootstrappedRuntime) await browser.nameSession("DevKit Chrome");
    binding = { runtime, browser, ownedTabs: new Map() };
    globalThis.__devkitChromeBinding = binding;
  }
  // Check the same pinned browser as the action helper. Discard all tab data.
  const userTabs = await binding.browser.user.openTabs();
  const ownedTabs = await binding.browser.tabs.list();
  if (!Array.isArray(userTabs) || !Array.isArray(ownedTabs)) throw Error("DEVKIT_OWNER_BROWSER_UNAVAILABLE");
  nodeRepl.write(JSON.stringify({
    owner: "devkit", chromeDiscovered: true,
    userBindingUsable: true, tabsApiUsable: true,
  }));
})();`;
  return { jsonrpc: "2.0", id, method: "tools/call", params: {
    name: "js", arguments: { code, title: "Check DevKit Chrome readiness" },
  } };
}

export function devkitReadinessResult(message) {
  if (message?.error || message?.result?.isError === true ||
      message?.result?.structuredContent && Object.hasOwn(message.result.structuredContent, "error")) {
    throw Error("DEVKIT_OWNER_BROWSER_UNAVAILABLE");
  }
  const content = message?.result?.content;
  if (!Array.isArray(content)) throw Error("DEVKIT_OWNER_BROWSER_UNAVAILABLE");
  const observations = [];
  for (const item of content) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    if (/^(?:Error:|Tool error:|Browser Use rejected this action)/i.test(item.text.trimStart())) {
      throw Error("DEVKIT_OWNER_BROWSER_UNAVAILABLE");
    }
    try {
      const value = JSON.parse(item.text);
      if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "owner")) observations.push(value);
    } catch { /* Documentation is not a readiness observation. */ }
  }
  if (observations.length !== 1) throw Error("DEVKIT_OWNER_BROWSER_UNAVAILABLE");
  const value = observations[0];
  if (value.owner !== "devkit" || value.chromeDiscovered !== true ||
      value.userBindingUsable !== true || value.tabsApiUsable !== true || Object.hasOwn(value, "error")) {
    throw Error("DEVKIT_OWNER_BROWSER_UNAVAILABLE");
  }
  return { owner: "devkit", chromeDiscovered: true, userBindingUsable: true, tabsApiUsable: true };
}

/**
 * Ordinary MCP client handshake. Let the verified upstream runtime supply its
 * normal per-child metadata; never copy or synthesize x-codex-turn-metadata.
 * Failures stop initialization. No automatic tool/action retry occurs here.
 */
export async function initializeDevKitSession({ invoke, notify, requestId }) {
  const initialized = await invoke({
    jsonrpc: "2.0", id: requestId(), method: "initialize", params: {
      protocolVersion: PROTOCOL_VERSION, capabilities: {},
      clientInfo: { name: "devkit-chrome-session-owner", version: "0.1.0" },
    },
  }, 20_000);
  const result = initialized?.result;
  if (initialized?.error || !result || result.protocolVersion !== PROTOCOL_VERSION ||
      !result.capabilities || typeof result.capabilities !== "object" ||
      typeof result.serverInfo?.name !== "string" || !result.serverInfo.name) {
    throw Error("DEVKIT_OWNER_INITIALIZE_FAILED");
  }
  await notify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const discovery = await invoke({ jsonrpc: "2.0", id: requestId(), method: "tools/list", params: {} }, 5_000);
  if (discovery?.error || !Array.isArray(discovery?.result?.tools) ||
      !discovery.result.tools.some(tool => tool?.name === "js")) throw Error("DEVKIT_OWNER_JS_TOOL_UNAVAILABLE");
  return devkitReadinessResult(await invoke(fixedDevKitReadinessRequest(requestId()), 30_000));
}

function sameFile(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function privateFile(info, uid) {
  return info.isFile() && !info.isSymbolicLink() && info.uid === uid && (info.mode & 0o077) === 0;
}

async function socketLive(path) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const finish = live => { socket.destroy(); resolve(live); };
    socket.setTimeout(250, () => finish(true)); // Unknown/slow is occupied.
    socket.once("connect", () => finish(true));
    socket.once("error", error => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") finish(false);
      else { socket.destroy(); reject(Error("BRIDGE_OWNER_OCCUPIED")); }
    });
  });
}

async function ensureSocketsVacant(paths, uid) {
  for (const path of paths) {
    let info;
    try { info = await lstat(path); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!info.isSocket() || info.uid !== uid || (info.mode & 0o077) !== 0) throw Error("INSECURE_BRIDGE_SOCKET");
    if (await socketLive(path)) throw Error("BRIDGE_OWNER_OCCUPIED");
    // The existing socket servers perform their own safe stale-path cleanup.
  }
}

async function withOwnerClaim(path, operation) {
  const guardPath = path + ".claim";
  let guard;
  try {
    guard = await open(guardPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw Error("BRIDGE_OWNER_OCCUPIED");
    throw error;
  }
  const identity = await guard.stat();
  try {
    await guard.writeFile(JSON.stringify({ kind: "browserjack-owner-claim-v1", pid: process.pid }) + "\n");
    return await operation();
  } finally {
    await guard.close();
    const current = await lstat(guardPath);
    if (!sameFile(identity, current)) throw Error("BRIDGE_OWNER_CHANGED");
    await unlink(guardPath);
  }
}

async function claimBridgeSessionUnderGuard({ path, mode, socketPaths, uid }) {
  let handle;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const before = await lstat(path);
      if (!privateFile(before, uid) || before.size > 1024) throw Error("INSECURE_BRIDGE_OWNER_FILE");
      const previous = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let info, owner;
      try {
        info = await previous.stat();
        if (!privateFile(info, uid) || !sameFile(before, info) || info.size > 1024) throw Error("INSECURE_BRIDGE_OWNER_FILE");
        try { owner = JSON.parse(await previous.readFile("utf8")); }
        catch { throw Error("INSECURE_BRIDGE_OWNER_FILE"); }
      } finally { await previous.close(); }
      if (owner?.kind !== OWNER_KIND || !Number.isSafeInteger(owner.pid) || owner.pid <= 1 || !MODES.has(owner.mode)) throw Error("INSECURE_BRIDGE_OWNER_FILE");
      try { process.kill(owner.pid, 0); throw Error("BRIDGE_OWNER_OCCUPIED"); }
      catch (status) { if (status.code !== "ESRCH") throw status; }
      const current = await lstat(path);
      if (!sameFile(info, current)) throw Error("BRIDGE_OWNER_CHANGED");
      await unlink(path);
    }
  }
  if (!handle) throw Error("BRIDGE_OWNER_OCCUPIED");
  let identity;
  const release = async () => {
    let current;
    try { current = await lstat(path); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (!sameFile(identity, current)) throw Error("BRIDGE_OWNER_CHANGED");
    await unlink(path);
  };
  try {
    await handle.writeFile(JSON.stringify({ kind: OWNER_KIND, pid: process.pid, mode }) + "\n");
    await handle.sync();
    identity = await handle.stat();
  } catch (error) {
    identity = await handle.stat();
    await release();
    throw error;
  } finally { await handle.close(); }
  try { await ensureSocketsVacant(socketPaths, uid); }
  catch (error) { await release(); throw error; }
  return release;
}

/**
 * One updated wrapper may own the runtime. The short-lived claim guard
 * serializes creation, dead-owner recovery, and release, so a late stale unlink
 * cannot remove a new owner. An abandoned guard is never auto-recovered.
 */
export async function claimBridgeSession({ path, mode, socketPaths = [] }) {
  const uid = process.getuid?.();
  if (uid === undefined || !isAbsolute(path) || !MODES.has(mode)) throw Error("INVALID_BRIDGE_OWNER");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || (parent.mode & 0o077) !== 0) throw Error("INSECURE_BRIDGE_OWNER_DIRECTORY");
  return withOwnerClaim(path, async () => {
    const release = await claimBridgeSessionUnderGuard({ path, mode, socketPaths, uid });
    return () => withOwnerClaim(path, release);
  });
}
