#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policyPath = join(repoRoot, "scripts", "browserjack-trust.json");
const defaultAppPath = "/Applications/ChatGPT.app";
const defaultManifestPath = join(
  homedir(),
  "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json",
);
const defaultApprovalsFile = join(
  homedir(),
  ".config/chatgpt-browser-bridge/browser-runtime-approvals.json",
);
export function resolveVerifiedBuildsFile({ env = process.env, home = homedir() } = {}) {
  const override = env.BROWSERJACK_VERIFIED_BUILDS_FILE;
  if (override !== undefined) {
    if (override.length === 0 || !isAbsolute(override)) {
      throw new Error("BROWSERJACK_VERIFIED_BUILDS_FILE must be a non-empty absolute path");
    }
    return resolve(override);
  }
  const codexHome = resolve(env.CODEX_HOME ?? join(home, ".codex"));
  return join(codexHome, "chatgpt-browser-bridge/browserjack/verified-builds.json");
}
const CODESIGN = "/usr/bin/codesign";
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/u;

function requireObject(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

async function readJson(path, label = path) {
  return requireObject(JSON.parse(await readFile(path, "utf8")), label);
}

export async function loadPolicy(path = policyPath) {
  const value = await readJson(path);
  if (value.schemaVersion !== 1) throw new Error(`${path} has an unsupported schema`);
  requireObject(value.adapter, `${path}.adapter`);
  requireObject(value.identity, `${path}.identity`);
  if (!Array.isArray(value.fingerprints) || value.fingerprints.length === 0) {
    throw new Error(`${path}.fingerprints must be a non-empty array`);
  }
  return value;
}

function run(path, args) {
  const result = spawnSync(path, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  return { code: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function assertStrictSignature(path, label) {
  const result = run(CODESIGN, ["--verify", "--strict", path]);
  if (result.code !== 0) {
    throw new Error(`${label} strict signature verification failed: ${result.output.trim()}`);
  }
}

function plistValue(appPath, key) {
  const result = run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, join(appPath, "Contents/Info.plist")]);
  if (result.code !== 0) throw new Error(`Could not read ${key} from ${appPath}`);
  return result.output.trim();
}

function teamIdentifier(appPath) {
  const result = run("/usr/bin/codesign", ["-dv", "--verbose=4", appPath]);
  const match = result.output.match(/^TeamIdentifier=(.+)$/m);
  if (!match) throw new Error(`Could not read TeamIdentifier from ${appPath}`);
  return match[1].trim();
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export function fingerprintFields(snapshot) {
  return {
    bundleId: snapshot.bundleId,
    teamId: snapshot.teamId,
    nativeHostName: snapshot.nativeHostName,
    extensionId: snapshot.extensionId,
    browserClientSha256: snapshot.browserClientSha256,
    browserServiceSha256: snapshot.browserServiceSha256,
    nativeHostSha256: snapshot.nativeHostSha256,
  };
}

export function fingerprintDigest(fields) {
  const ordered = fingerprintFields(fields);
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

function parseExtensionId(value, label) {
  if (typeof value !== "string" || !EXTENSION_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be a valid Chrome extension ID`);
  }
  return value;
}

function parseExtensionIdArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return [...new Set(value.map((id) => parseExtensionId(id, `${label}[]`)))];
}

function extensionHostName(value, source) {
  return requireString(value.extensionHostName, `${source}.extensionHostName`);
}

function parseLegacyMetadata(value, source) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${source} must contain an object`);
  }
  const extensionId = parseExtensionId(value.extensionId, `${source}.extensionId`);
  const extensionIds = Array.isArray(value.extensionIds)
    ? parseExtensionIdArray(value.extensionIds, `${source}.extensionIds`)
    : [extensionId];
  if (!extensionIds.includes(extensionId)) {
    throw new Error(`${source}.extensionId is not included in extensionIds`);
  }
  return {
    extensionId,
    extensionIds,
    extensionHostName: extensionHostName(value, source),
  };
}

export function parseLegacyExtensionMetadata(value, source = "scripts/extension-id.json") {
  return parseLegacyMetadata(value, source);
}

export function parsePluralExtensionMetadata(value, source = "scripts/extension-ids.json") {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${source} must contain an object`);
  }
  if (!Array.isArray(value.browserExtensions)) {
    throw new Error(`${source} must identify a browserFamily=chrome entry`);
  }
  const chromeEntries = value.browserExtensions.filter(
    (entry) => entry && typeof entry === "object" && entry.browserFamily === "chrome",
  );
  if (chromeEntries.length !== 1) {
    throw new Error(`${source} must contain exactly one Chrome browser entry`);
  }
  const chrome = chromeEntries[0];
  const chromeIds = parseExtensionIdArray(chrome.extensionIds, `${source}.browserExtensions[chrome].extensionIds`);
  const extensionId = parseExtensionId(
    chrome.storeExtensionId,
    `${source}.browserExtensions[chrome].storeExtensionId`,
  );
  if (!chromeIds.includes(extensionId)) {
    throw new Error(`${source} Chrome storeExtensionId is not one of the Chrome extension IDs`);
  }
  const extensionIds = Array.isArray(value.extensionIds)
    ? parseExtensionIdArray(value.extensionIds, `${source}.extensionIds`)
    : [...new Set(value.browserExtensions.flatMap((entry) => (
      entry && typeof entry === "object" && Array.isArray(entry.extensionIds) ? entry.extensionIds : []
    )))].map((id) => parseExtensionId(id, `${source}.browserExtensions[].extensionIds[]`));
  if (!extensionIds.includes(extensionId)) {
    throw new Error(`${source} Chrome storeExtensionId is not included in extensionIds`);
  }
  return {
    extensionId,
    extensionIds,
    extensionHostName: extensionHostName(value, source),
  };
}

async function loadSignedExtensionMetadata(pluginPath) {
  const pluralPath = join(pluginPath, "scripts/extension-ids.json");
  try {
    return parsePluralExtensionMetadata(JSON.parse(await readFile(pluralPath, "utf8")), pluralPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const singularPath = join(pluginPath, "scripts/extension-id.json");
  try {
    return parseLegacyExtensionMetadata(JSON.parse(await readFile(singularPath, "utf8")), singularPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  throw new Error(`Missing signed ${pluralPath} and ${singularPath}`);
}

function assertContained(root, candidate, label) {
  const containment = relative(resolve(root), resolve(candidate));
  if (containment === ".." || containment.startsWith(`..${sep}`) || isAbsolute(containment)) {
    throw new Error(`${label} escapes its trusted root: ${candidate}`);
  }
}

export function validateIdentity(snapshot, policy) {
  const expected = policy.identity;
  for (const [field, expectedValue] of [
    ["bundleId", expected.bundleId],
    ["teamId", expected.teamId],
    ["nativeHostName", expected.nativeHostName],
    ["extensionId", expected.preferredExtensionId],
  ]) {
    if (snapshot[field] !== expectedValue) {
      throw new Error(`Unexpected ${field}: ${snapshot[field] ?? "missing"}`);
    }
  }
  if (snapshot.nativeHostSha256 !== snapshot.bundledNativeHostSha256) {
    throw new Error("Installed Chrome native host differs from the ChatGPT.app native host");
  }
}

export function baselineMatch(snapshot, policy) {
  return policy.fingerprints.find(
    (candidate) =>
      candidate.browserClientSha256 === snapshot.browserClientSha256 &&
      candidate.browserServiceSha256 === snapshot.browserServiceSha256 &&
      candidate.nativeHostSha256 === snapshot.nativeHostSha256,
  ) ?? null;
}

async function assertPrivateApprovalsFile(path) {
  const details = await stat(path);
  if (!details.isFile()) throw new Error(`Browser fingerprint approvals are not a file: ${path}`);
  if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
    throw new Error(`Browser fingerprint approvals must be owned by the current user: ${path}`);
  }
  if ((details.mode & 0o777) !== 0o600) {
    throw new Error(`Browser fingerprint approvals permissions must be 600: ${path}`);
  }
}

export async function loadApprovals(path = defaultApprovalsFile) {
  try {
    await assertPrivateApprovalsFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const value = await readJson(path);
  if (value.schemaVersion !== 1 || !Array.isArray(value.fingerprints)) {
    throw new Error(`${path} has an unsupported schema`);
  }
  return value.fingerprints.filter(
    (entry) =>
      entry && typeof entry === "object" &&
      typeof entry.fingerprint === "string" &&
      typeof entry.approvedAt === "string",
  );
}

export function approvalMatch(snapshot, approvals) {
  const fingerprint = fingerprintDigest(snapshot);
  return approvals.find((entry) => entry.fingerprint === fingerprint) ?? null;
}

export async function writeApproval(path, snapshot) {
  const existing = await loadApprovals(path);
  const fingerprint = fingerprintDigest(snapshot);
  const retained = existing.filter((entry) => entry.fingerprint !== fingerprint);
  retained.push({
    fingerprint,
    approvedAt: new Date().toISOString(),
    appVersion: snapshot.appVersion,
    buildVersion: snapshot.buildVersion,
    pluginVersion: snapshot.pluginVersion,
    ...fingerprintFields(snapshot),
  });

  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const temporary = `${path}.next-${process.pid}`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, fingerprints: retained }, null, 2)}\n`);
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return fingerprint;
}

export async function inspectRuntime({
  appPath = defaultAppPath,
  manifestPath = defaultManifestPath,
  approvalsFile = process.env.BROWSERJACK_APPROVAL_FILE ?? defaultApprovalsFile,
  policy = undefined,
} = {}) {
  const trust = policy ?? await loadPolicy();
  const pluginPath = join(appPath, "Contents/Resources/plugins/openai-bundled/plugins/chrome");
  const clientPath = join(pluginPath, "scripts/browser-client.mjs");
  const servicePath = join(pluginPath, "scripts/browser-service.mjs");
  const bundledNativeHostPath = join(
    pluginPath,
    "extension-host/macos",
    process.arch,
    "ChatGPT for Chrome",
  );
  assertStrictSignature(appPath, "ChatGPT.app");
  const extensionMetadata = await loadSignedExtensionMetadata(pluginPath);
  const manifest = await readJson(manifestPath);
  const nativeHostName = extensionMetadata.extensionHostName;
  const manifestHostName = requireString(manifest.name, `${manifestPath}.name`);
  if (manifestHostName !== nativeHostName) {
    throw new Error(`Native host name ${manifestHostName} does not match signed plugin metadata ${nativeHostName}`);
  }
  const configuredNativeHostPath = requireString(manifest.path, `${manifestPath}.path`);
  if (!isAbsolute(configuredNativeHostPath)) {
    throw new Error(`Native host path is not absolute: ${configuredNativeHostPath}`);
  }
  const nativeHostPath = await realpath(configuredNativeHostPath);
  const cacheRoot = await realpath(join(homedir(), ".codex/plugins/cache/openai-bundled/chrome"));
  assertContained(cacheRoot, nativeHostPath, "Chrome native host");
  const allowedOrigins = Array.isArray(manifest.allowed_origins) ? manifest.allowed_origins : [];
  const extensionId = extensionMetadata.extensionId;
  if (!allowedOrigins.includes(`chrome-extension://${extensionId}/`)) {
    throw new Error(`Signed Chrome extension ID is not allowed by ${manifestPath}`);
  }
  assertStrictSignature(bundledNativeHostPath, "ChatGPT.app Chrome native host");
  assertStrictSignature(nativeHostPath, "Installed Chrome native host");
  const plugin = await readJson(join(pluginPath, ".codex-plugin/plugin.json"));
  const snapshot = {
    appVersion: plistValue(appPath, "CFBundleShortVersionString"),
    buildVersion: plistValue(appPath, "CFBundleVersion"),
    pluginVersion: requireString(plugin.version, "Chrome plugin version"),
    bundleId: plistValue(appPath, "CFBundleIdentifier"),
    teamId: teamIdentifier(appPath),
    nativeHostName,
    extensionId,
    extensionIds: extensionMetadata.extensionIds,
    browserClientSha256: await sha256(clientPath),
    browserServiceSha256: await sha256(servicePath),
    nativeHostSha256: await sha256(nativeHostPath),
    bundledNativeHostSha256: await sha256(bundledNativeHostPath),
  };
  validateIdentity(snapshot, trust);
  const baseline = baselineMatch(snapshot, trust);
  const approvals = await loadApprovals(approvalsFile);
  const local = approvalMatch(snapshot, approvals);
  return {
    ...snapshot,
    fingerprint: fingerprintDigest(snapshot),
    approved: Boolean(baseline || local),
    approvalSource: baseline ? "baseline" : local ? "local" : null,
    approvalLabel: baseline?.label ?? null,
  };
}

function parseArgs(argv) {
  const values = { command: argv[0] ?? "inspect" };
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!["--app", "--manifest", "--approvals-file", "--expected"].includes(key) || value === undefined) {
      throw new Error(`Unknown or incomplete argument: ${key}`);
    }
    values[key.slice(2).replaceAll("-", "_")] = value;
    index += 1;
  }
  return values;
}

async function main() {
  const command = process.argv[2] ?? "inspect";
  if (command === "config") {
    const field = process.argv[3];
    const policy = await loadPolicy();
    const values = {
      adapterId: policy.adapter.id,
      upstreamCommit: policy.adapter.upstreamCommit,
      nativeHostName: policy.identity.nativeHostName,
      preferredExtensionId: policy.identity.preferredExtensionId,
      approvalsFile: defaultApprovalsFile,
      verifiedBuildsFile: resolveVerifiedBuildsFile(),
    };
    if (!(field in values)) throw new Error(`Unknown config field: ${field}`);
    process.stdout.write(`${values[field]}\n`);
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  const approvalsFile = args.approvals_file ?? process.env.BROWSERJACK_APPROVAL_FILE ?? defaultApprovalsFile;
  const options = {
    appPath: args.app ?? defaultAppPath,
    manifestPath: args.manifest ?? defaultManifestPath,
    approvalsFile,
  };
  const snapshot = await inspectRuntime(options);
  if (args.command === "inspect") {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return;
  }
  if (args.command === "assert") {
    if (!snapshot.approved) {
      throw new Error(
        `Unapproved browser runtime fingerprint: ${snapshot.fingerprint}. Run bash scripts/review-browserjack-update.sh.`,
      );
    }
    process.stdout.write(`${JSON.stringify(snapshot)}\n`);
    return;
  }
  if (args.command === "approve") {
    if (!args.expected || args.expected !== snapshot.fingerprint) {
      throw new Error("The current browser fingerprint does not match --expected");
    }
    await writeApproval(approvalsFile, snapshot);
    process.stdout.write(`fingerprint=${snapshot.fingerprint}\n`);
    return;
  }
  throw new Error(`Unknown command: ${args.command}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
