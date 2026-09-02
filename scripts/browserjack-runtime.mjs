#!/usr/bin/env node

import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { inspectRuntime } from "./browserjack-fingerprint.mjs";

const defaultApp = "/Applications/ChatGPT.app";
const defaultManifest = join(
  homedir(),
  "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json",
);
const defaultRegistry = join(
  homedir(),
  "Library/Application Support/OpenAI/Codex/chrome-native-hosts-v2.json",
);
const defaultNodeReplConfig = join(homedir(), ".codex/config.toml");
const expectedChannel = "prod";
const expectedProtocolVersion = 2;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function expandPath(value, label = "runtime path") {
  const text = nonEmptyString(value, label);
  if (text === "~") return homedir();
  if (text.startsWith(`~${sep}`)) return join(homedir(), text.slice(2));
  if (!isAbsolute(text)) throw new Error(`${label} is not absolute: ${text}`);
  return resolve(text);
}

function contained(root, candidate, label) {
  const suffix = relative(resolve(root), resolve(candidate));
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error(`${label} escapes its trusted root: ${candidate}`);
  }
  return resolve(candidate);
}

async function existingRealpath(path, label) {
  try {
    return await realpath(path);
  } catch {
    throw new Error(`${label} is missing: ${path}`);
  }
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function parseTomlString(value) {
  const text = value.trim();
  if (text.startsWith('"') && text.endsWith('"')) return JSON.parse(text);
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  return null;
}

async function readNodeReplEnv(path) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch {
    return {};
  }
  let inSection = false;
  const values = {};
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.replace(/#.*/u, "").trim();
    if (line.startsWith("[")) {
      inSection = line === "[mcp_servers.node_repl.env]";
      continue;
    }
    if (!inSection) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.+)$/u);
    if (!match) continue;
    const parsed = parseTomlString(match[2]);
    if (parsed !== null) values[match[1]] = parsed;
  }
  return values;
}

export function selectV2RuntimeEntry(
  registry,
  { appVersion, channel = expectedChannel, nativeHostName, extensionIds },
) {
  if (!isObject(registry) || registry.schemaVersion !== 2 || !Array.isArray(registry.entries)) {
    throw new Error("Chrome native-host v2 registry must use schemaVersion 2");
  }
  const wantedIds = new Set(extensionIds);
  const matches = registry.entries.filter((entry) => {
    if (!isObject(entry) || entry.schemaVersion !== 2) return false;
    if (entry.appVersion !== appVersion || entry.channel !== channel) return false;
    if (
      entry.appServerProtocolVersion !== expectedProtocolVersion ||
      entry.nativeHostProtocolVersion !== expectedProtocolVersion
    ) return false;
    if (!Array.isArray(entry.extensionBuildChannels) || !entry.extensionBuildChannels.includes(channel)) {
      return false;
    }
    if (!Array.isArray(entry.nativeHostNames) || !entry.nativeHostNames.includes(nativeHostName)) {
      return false;
    }
    return (
      Array.isArray(entry.extensionIds) &&
      entry.extensionIds.length === wantedIds.size &&
      entry.extensionIds.every((id) => wantedIds.has(id))
    );
  });
  if (matches.length !== 1) {
    throw new Error(`Expected one current Chrome native-host v2 entry, found ${matches.length}`);
  }
  return matches[0];
}

async function readManifest(manifestPath) {
  let value;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read native-host manifest ${manifestPath}: ${error.message}`, { cause: error });
  }
  if (!isObject(value)) throw new Error(`Native-host manifest ${manifestPath} must contain an object`);
  return value;
}

async function resolveV2({ registryPath, snapshot, manifest, appPluginPath, appCodexPath, appResourcesRoot }) {
  let registry;
  try {
    registry = JSON.parse(await readFile(registryPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Could not read Chrome native-host v2 registry ${registryPath}: ${error.message}`, { cause: error });
  }

  const entry = selectV2RuntimeEntry(registry, {
    appVersion: snapshot.appVersion,
    nativeHostName: snapshot.nativeHostName,
    extensionIds: snapshot.extensionIds,
  });
  const paths = entry.paths;
  if (!isObject(paths)) throw new Error("Current v2 registry entry has no paths object");

  const codexHome = await existingRealpath(expandPath(paths.codexHome, "v2 CODEX_HOME"), "v2 CODEX_HOME");
  const cacheRoot = await existingRealpath(
    join(codexHome, "plugins/cache/openai-bundled"),
    "OpenAI plugin cache",
  );
  const resourcesRoot = await existingRealpath(expandPath(paths.resourcesPath, "v2 resources path"), "v2 resources path");
  if (resourcesRoot !== appResourcesRoot) throw new Error("v2 resources path does not match ChatGPT.app");

  const browserClientPath = await existingRealpath(expandPath(paths.browserClientPath, "v2 browser client"), "v2 browser client");
  const browserServicePath = await existingRealpath(expandPath(paths.browserServicePath, "v2 browser service"), "v2 browser service");
  const extensionHostPath = await existingRealpath(expandPath(paths.extensionHostPath, "v2 extension host"), "v2 extension host");
  contained(cacheRoot, browserClientPath, "v2 browser client");
  contained(cacheRoot, browserServicePath, "v2 browser service");
  contained(cacheRoot, extensionHostPath, "v2 extension host");

  const manifestHostPath = await existingRealpath(nonEmptyString(manifest.path, "native-host manifest path"), "native-host manifest target");
  if (manifestHostPath !== extensionHostPath) throw new Error("v2 extension host does not match Chrome native-host manifest");
  if (manifest.name !== snapshot.nativeHostName) throw new Error("native-host manifest name does not match signed plugin metadata");
  const allowedOrigins = Array.isArray(manifest.allowed_origins) ? manifest.allowed_origins : [];
  for (const id of snapshot.extensionIds) {
    if (!allowedOrigins.includes(`chrome-extension://${id}/`)) {
      throw new Error(`native-host manifest does not allow signed extension ${id}`);
    }
  }

  const signedAppClientPath = await existingRealpath(join(appPluginPath, "scripts/browser-client.mjs"), "signed app browser client");
  const signedAppServicePath = await existingRealpath(join(appPluginPath, "scripts/browser-service.mjs"), "signed app browser service");
  const signedAppHostPath = await existingRealpath(
    join(appPluginPath, "extension-host/macos", process.arch, "ChatGPT for Chrome"),
    "signed app native host",
  );
  const registryCodexPath = await existingRealpath(expandPath(paths.codexCliPath, "v2 Codex CLI"), "v2 Codex CLI");
  contained(codexHome, registryCodexPath, "v2 Codex CLI");

  const [clientSha, serviceSha, hostSha, appClientSha, appServiceSha, appHostSha, registryCodexSha, appCodexSha] = await Promise.all([
    sha256(browserClientPath),
    sha256(browserServicePath),
    sha256(extensionHostPath),
    sha256(signedAppClientPath),
    sha256(signedAppServicePath),
    sha256(signedAppHostPath),
    sha256(registryCodexPath),
    sha256(appCodexPath),
  ]);
  if (clientSha !== appClientSha || clientSha !== snapshot.browserClientSha256) {
    throw new Error("v2 browser client is not byte-identical to the signed app client");
  }
  if (serviceSha !== appServiceSha || serviceSha !== snapshot.browserServiceSha256) {
    throw new Error("v2 browser service is not byte-identical to the signed app service");
  }
  if (hostSha !== appHostSha || hostSha !== snapshot.nativeHostSha256) {
    throw new Error("v2 extension host is not byte-identical to the signed app host");
  }
  if (registryCodexSha !== appCodexSha) throw new Error("v2 Codex CLI is not byte-identical to ChatGPT.app");

  const nodePath = await existingRealpath(expandPath(paths.nodePath, "v2 node path"), "v2 node path");
  const nodeReplPath = await existingRealpath(expandPath(paths.nodeReplPath, "v2 node_repl path"), "v2 node_repl path");
  contained(resourcesRoot, nodePath, "v2 node path");
  contained(resourcesRoot, nodeReplPath, "v2 node_repl path");
  if (!Array.isArray(paths.nodeModuleDirs) || paths.nodeModuleDirs.length === 0) {
    throw new Error("v2 registry has no node module directories");
  }
  const nodeModuleDirs = await Promise.all(
    paths.nodeModuleDirs.map((path) => existingRealpath(expandPath(path, "v2 node module directory"), "v2 node module directory")),
  );
  for (const path of nodeModuleDirs) contained(resourcesRoot, path, "v2 node module directory");

  const requestedExtensionId = process.env.BROWSERJACK_EXPERIMENT_EXTENSION_ID;
  if (requestedExtensionId && requestedExtensionId !== snapshot.extensionId) {
    throw new Error("Requested extension ID does not match signed Chrome metadata");
  }
  const pluginRoots = [
    ...new Set([
      resolve(dirname(browserClientPath), ".."),
      resolve(dirname(browserServicePath), ".."),
    ]),
  ];
  return {
    registryPath: resolve(registryPath),
    appServerProtocolVersion: entry.appServerProtocolVersion,
    nativeHostProtocolVersion: entry.nativeHostProtocolVersion,
    codexHome,
    codexCliPath: registryCodexPath,
    nodePath,
    nodeReplPath,
    nodeModuleDirs,
    browserClientPath,
    browserClientSha256: clientSha,
    browserServicePath,
    browserServiceSha256: serviceSha,
    extensionHostPath,
    nativeHostName: snapshot.nativeHostName,
    extensionIds: snapshot.extensionIds,
    extensionId: snapshot.extensionId,
    pluginRoots,
  };
}

export async function resolveRuntime({
  appPath = defaultApp,
  manifestPath = defaultManifest,
  registryPath = process.env.BROWSERJACK_RUNTIME_REGISTRY ?? defaultRegistry,
  nodeReplConfig = process.env.BROWSERJACK_NODE_REPL_CONFIG ?? defaultNodeReplConfig,
  approvalsFile = process.env.BROWSERJACK_APPROVAL_FILE,
  allowUnapproved = process.env.BROWSERJACK_ALLOW_UNAPPROVED_CANDIDATE === "1",
} = {}) {
  const snapshot = await inspectRuntime({ appPath, manifestPath, approvalsFile });
  if (!snapshot.approved && !allowUnapproved) {
    throw new Error(`Unapproved browser runtime fingerprint: ${snapshot.fingerprint}`);
  }

  const appPluginPath = await existingRealpath(
    join(appPath, "Contents/Resources/plugins/openai-bundled/plugins/chrome"),
    "ChatGPT Chrome plugin",
  );
  const appResourcesRoot = await existingRealpath(join(appPath, "Contents/Resources"), "ChatGPT resources");
  const appCodexPath = await existingRealpath(join(appResourcesRoot, "codex"), "ChatGPT codex binary");
  const manifest = await readManifest(manifestPath);
  const v2 = await resolveV2({
    registryPath,
    snapshot,
    manifest,
    appPluginPath,
    appCodexPath,
    appResourcesRoot,
  });
  const nodeEnv = await readNodeReplEnv(nodeReplConfig);
  const configuredBackends = nodeEnv.BROWSER_USE_AVAILABLE_BACKENDS
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? ["chrome"];
  if (!configuredBackends.includes("chrome")) {
    throw new Error("node_repl configuration does not enable the Chrome backend");
  }

  const base = v2 ?? {
    registryPath: null,
    appServerProtocolVersion: null,
    nativeHostProtocolVersion: null,
    codexHome: resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex")),
    codexCliPath: appCodexPath,
    nodePath: await existingRealpath(join(appResourcesRoot, "cua_node/bin/node"), "ChatGPT node path"),
    nodeReplPath: await existingRealpath(join(appResourcesRoot, "cua_node/bin/node_repl"), "ChatGPT node_repl path"),
    nodeModuleDirs: [await existingRealpath(join(appResourcesRoot, "cua_node/lib/node_modules"), "ChatGPT node modules")],
    browserClientPath: await existingRealpath(join(appPluginPath, "scripts/browser-client.mjs"), "ChatGPT browser client"),
    browserClientSha256: snapshot.browserClientSha256,
    browserServicePath: await existingRealpath(join(appPluginPath, "scripts/browser-service.mjs"), "ChatGPT browser service"),
    browserServiceSha256: snapshot.browserServiceSha256,
    extensionHostPath: await existingRealpath(manifest.path, "Chrome native host"),
    nativeHostName: snapshot.nativeHostName,
    extensionIds: snapshot.extensionIds,
    extensionId: snapshot.extensionId,
    pluginRoots: [appPluginPath],
  };
  return {
    ...base,
    appPath: resolve(appPath),
    appVersion: snapshot.appVersion,
    buildVersion: snapshot.buildVersion,
    pluginVersion: snapshot.pluginVersion,
    fingerprint: snapshot.fingerprint,
    trustedCodePaths: [...new Set([appPluginPath, ...base.pluginRoots, ...base.nodeModuleDirs])],
    availableBackends: "chrome",
    nativePipeConnectTimeoutMs: nodeEnv.NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS ?? "1000",
    tinyskyEnabled: nodeEnv.BROWSER_USE_TINYSKY_ENABLED ?? "0",
    buildFlavor: nodeEnv.BROWSER_USE_CODEX_APP_BUILD_FLAVOR ?? expectedChannel,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? "resolve";
  const appPath = args.includes("--app") ? args[args.indexOf("--app") + 1] : defaultApp;
  const manifestPath = args.includes("--manifest") ? args[args.indexOf("--manifest") + 1] : defaultManifest;
  const result = await resolveRuntime({ appPath, manifestPath });
  if (command === "resolve" || command === "inspect") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
