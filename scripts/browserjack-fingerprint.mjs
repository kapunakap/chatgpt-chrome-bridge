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
import { dirname, join, resolve, sep } from "node:path";
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
const defaultVerifiedBuildsFile = join(
  homedir(),
  "Library/Application Support/browserjack/verified-builds.json",
);

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
  approvalsFile = defaultApprovalsFile,
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
  const manifest = await readJson(manifestPath);
  const nativeHostName = requireString(manifest.name, `${manifestPath}.name`);
  const nativeHostPath = await realpath(requireString(manifest.path, `${manifestPath}.path`));
  const cacheRoot = await realpath(join(homedir(), ".codex/plugins/cache/openai-bundled/chrome"));
  if (nativeHostPath !== cacheRoot && !nativeHostPath.startsWith(`${cacheRoot}${sep}`)) {
    throw new Error(`Chrome native host escapes the OpenAI plugin cache: ${nativeHostPath}`);
  }
  const allowedOrigins = Array.isArray(manifest.allowed_origins) ? manifest.allowed_origins : [];
  const extensionId = trust.identity.preferredExtensionId;
  if (!allowedOrigins.includes(`chrome-extension://${extensionId}/`)) {
    throw new Error(`Preferred Chrome extension ID is not allowed by ${manifestPath}`);
  }
  const plugin = await readJson(join(pluginPath, ".codex-plugin/plugin.json"));
  const snapshot = {
    appVersion: plistValue(appPath, "CFBundleShortVersionString"),
    buildVersion: plistValue(appPath, "CFBundleVersion"),
    pluginVersion: requireString(plugin.version, "Chrome plugin version"),
    bundleId: plistValue(appPath, "CFBundleIdentifier"),
    teamId: teamIdentifier(appPath),
    nativeHostName,
    extensionId,
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
      verifiedBuildsFile: defaultVerifiedBuildsFile,
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
