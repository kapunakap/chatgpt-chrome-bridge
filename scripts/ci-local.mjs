#!/usr/bin/env node
// Run exact-commit CI on a Mac without GitHub Actions, Docker or paid runners.
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = "kapunakap/chatgpt-chrome-bridge";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const full = process.argv.includes("--full");
const report = process.argv.includes("--report");
if (process.argv.some(arg => !["--full", "--report"].includes(arg))) throw Error("Only --full and --report are supported");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const sha = git("rev-parse", "HEAD");
if (!/^[a-f0-9]{40}$/.test(sha) || git("status", "--porcelain")) throw Error("LOCAL_CI_REQUIRES_CLEAN_EXACT_COMMIT");
if (!git("remote", "get-url", "origin").includes("kapunakap/chatgpt-chrome-bridge")) throw Error("WRONG_REPOSITORY");
const suite = full ? "full" : "core";
const checks = [
  ["shell-syntax", "bash", ["-lc", "bash -n scripts/*.sh"], 15_000],
  ["node-syntax", "bash", ["-lc", "for file in scripts/*.mjs; do node --check \"$file\" || exit 1; done"], 30_000],
];
for (const name of [
  "devkit-actions", "browserjack-discovery-compat", "browserjack-fingerprint",
  "browserjack-runtime", "browserjack-live-probe", "browserjack-health",
  "browserjack-supervisor", "browserjack-guidance", "prepare-browserjack",
]) checks.push([name, "node", ["--test", "scripts/" + name + ".test.mjs"], 35_000]);
checks.push(["runtime-review-policy", "bash", ["scripts/review-browserjack-update.test.sh"], 35_000]);
const prepared = "$" + "{CODEX_HOME:-$HOME/.codex}/chatgpt-browser-bridge/browserjack/$ADAPTER_ID";
checks.push(["public-defaults-policy", "bash", ["-lc", [
  "grep -Fq '" + prepared + "' scripts/browserjack-current.sh",
  "grep -Fq '" + prepared + "' scripts/prepare-browserjack.sh",
  "grep -Fq '" + prepared + "' scripts/review-browserjack-update.sh",
  "! git grep -n -F 'Library/Application Support/chatgpt-browser-bridge/browserjack' -- scripts README.md SECURITY.md",
  "! git grep -n -F 'Library/Application Support/browserjack/verified-builds.json' -- scripts README.md SECURITY.md",
  "! git grep -n '/Users/' -- scripts README.md SECURITY.md",
  "! git grep -nE 'tunnel_[a-z0-9]{32}'",
].join(" && ")], 10_000]);
if (full) checks.push(["browserjack-upgrade-process", "node", ["--test", "scripts/browserjack-upgrade-process.test.mjs"], 90_000]);

const receiptDir = join(tmpdir(), "devkit-local-ci-receipts", "chrome-bridge", sha, suite);
await mkdir(receiptDir, { recursive: true, mode: 0o700 });
await chmod(receiptDir, 0o700);
const stages = [];
for (const [name, command, args, timeout] of checks) {
  const start = Date.now();
  const run = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout, maxBuffer: 512 * 1024, env: { ...process.env, CI: "true" } });
  const passed = run.status === 0 && !run.error;
  const log = (run.stdout || "") + "\n" + (run.stderr || "") + "\n" + (run.error?.message || "");
  await writeFile(join(receiptDir, name + ".log"), log, { mode: 0o600 });
  stages.push({ name, passed, durationMs: Date.now() - start, reason: run.error?.code || (run.status === null ? "NO_EXIT_STATUS" : undefined) });
  process.stdout.write((passed ? "PASS " : "FAIL ") + name + "\n");
}
const passed = stages.every(stage => stage.passed);
const receipt = { repo, sha, suite, verifiedAt: new Date().toISOString(), platform: process.platform,
  node: process.version, dependencies: "Node built-ins; no installation or GitHub Actions",
  status: passed ? "passed" : "failed", stages };
const file = join(receiptDir, "result.json");
await writeFile(file, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
if (report) {
  const args = [
    "api", "-X", "POST", "repos/" + repo + "/statuses/" + sha,
    "-f", "state=" + (passed ? "success" : "failure"),
    "-f", "context=local-ci/chrome-bridge-" + suite,
    "-f", "description=" + stages.filter(stage => stage.passed).length + "/" + stages.length + " local macOS checks passed",
  ];
  const status = spawnSync("gh", args, { cwd: root, encoding: "utf8", timeout: 15_000, maxBuffer: 16_000 });
  if (status.status !== 0) {
    process.stderr.write("Could not publish GitHub commit status (local test receipt remains available).\n");
    process.exitCode = 2;
  } else process.stdout.write("GitHub commit status posted (no Actions minutes).\n");
}
process.stdout.write("Local CI " + receipt.status + ": " + sha + " (" + suite + "); receipt " + file + "\n");
if (!passed && !process.exitCode) process.exitCode = 1;
