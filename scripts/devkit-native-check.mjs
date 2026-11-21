#!/usr/bin/env node
// Run from the normal Mac Terminal. Uses the existing service-check workflow;
// never installs a service, changes permissions, or copies authentication state.
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = join(root, "output");
const receipt = join(directory, "devkit-native-check.json");
const run = promisify(execFile);
if (process.platform !== "darwin") throw Error("This check requires macOS.");
await mkdir(directory, { recursive: true, mode: 0o700 });
const result = { startedAt: new Date().toISOString(), complete: false, success: false, checks: [] };
const save = () => writeFile(receipt, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
await save();
for (const stage of ["doctor", "smoke", "status"]) {
  process.stdout.write(`Checking ${stage}...\n`);
  try {
    const response = await run("/bin/bash", [join(root, "scripts/service-check.sh"), stage], {
      cwd: root, timeout: 100_000, maxBuffer: 200_000,
    });
    const output = response.stdout.trim();
    const pass = stage === "doctor" ? output.includes("doctor_ready=true")
      : stage === "smoke" ? output.includes("example_title=Example Domain") : true;
    result.checks.push({ stage, pass, output });
  } catch (error) {
    result.checks.push({ stage, pass: false, code: error.code,
      output: String(error.stdout ?? "").trim(), error: String(error.stderr ?? "").slice(0, 1500) });
  }
  await save();
  if (!result.checks.at(-1).pass) break;
}
result.complete = true;
result.success = result.checks.length === 3 && result.checks.every(check => check.pass);
result.finishedAt = new Date().toISOString();
await save();
process.stdout.write(result.success ? "Native checks passed.\n" : "Native checks did not pass. The result is saved for diagnosis.\n");
process.stdout.write(`Receipt: ${receipt}\n`);
process.exitCode = result.success ? 0 : 1;
