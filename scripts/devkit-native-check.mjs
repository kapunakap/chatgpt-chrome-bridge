#!/usr/bin/env node
// Run from the normal Mac Terminal. Uses the existing service-check workflow;
// never installs a service, changes permissions, or copies authentication state.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);
const usage = "Usage: node scripts/devkit-native-check.mjs [--installed-service-root /absolute/checkout]";
const booleanFields = new Set([
  "doctor_ready", "doctor_report_unavailable", "service_check_timed_out",
  "mcp_initialized", "js_tool_discovered", "chrome_backend_available",
  "stdio_send_initialized_notification", "launch_agent_installed", "launch_agent_loaded",
  "launch_agent_running", "launch_agent_pid_alive", "health_watch_installed",
  "health_watch_loaded", "health_watch_ready", "chrome_discovered", "user_binding_ready",
  "tabs_api_ready", "browser_ready", "tunnel_managed_runtime_process_running",
  "tunnel_process_running", "launch_agent_owns_process", "process_running", "healthy", "ready",
]);
const numericFields = new Set([
  "doctor_exit_code", "smoke_exit_code", "status_exit_code",
  "doctor_checks_passed", "doctor_checks_warning", "doctor_checks_failed",
  "browserjack_status_exit", "browserjack_live_doctor_exit", "browserjack_user_probe_exit",
]);
const failureCodes = new Set([
  "installed_checkout_mismatch", "service_not_loaded", "service_not_running",
  "service_pid_not_alive", "initialized_notification_missing", "check_failed",
  "service_not_installed", "bootstrap_failed",
]);
const statusRequiredFields = [
  "launch_agent_installed", "launch_agent_loaded", "launch_agent_running", "launch_agent_pid_alive",
  "process_running", "healthy", "ready", "browser_ready", "health_watch_ready",
];

export function parseArguments(args) {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === "--installed-service-root" && isAbsolute(args[1])) {
    return { installedServiceRoot: args[1] };
  }
  throw new Error(usage);
}

async function validateCheckRoot(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("A check root must be an absolute directory.");
  const canonical = await realpath(path);
  if (!(await lstat(canonical)).isDirectory()) throw new Error("A check root must be a directory.");
  for (const name of ["service-check.sh", "status.sh"]) {
    const script = join(canonical, "scripts", name);
    const target = await realpath(script);
    const inside = relative(canonical, target);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) || !(await lstat(target)).isFile()) {
      throw new Error("Required check scripts must be files inside the selected checkout.");
    }
  }
  return canonical;
}

// Even errors from the launcher may contain private logs. Persist only known
// readiness keys and fixed failure codes, never stderr, error messages or paths.
export function safeCheckFields(text) {
  const fields = {};
  let conflicting = false;
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    const allowed = (booleanFields.has(key) && /^(?:true|false)$/u.test(value))
      || (numericFields.has(key) && /^(?:0|[1-9][0-9]{0,5})$/u.test(value))
      || (key === "example_title" && value === "Example Domain")
      || (["status_failure_code", "service_check_failure_code"].includes(key) && failureCodes.has(value));
    if (!allowed) continue;
    if (Object.hasOwn(fields, key) && fields[key] !== value) conflicting = true;
    fields[key] = value;
  }
  return { fields, conflicting };
}

export function evaluateCheck(stage, { stdout = "", stderr = "", error = null } = {}) {
  const { fields, conflicting } = safeCheckFields(`${stdout}\n${stderr}`);
  const exitCode = error === null ? 0 : Number.isInteger(error.code) && error.code >= 0 && error.code <= 255 ? error.code : null;
  const marker = stage === "doctor" ? fields.doctor_ready === "true"
    : stage === "smoke" ? fields.example_title === "Example Domain"
      : statusRequiredFields.every((key) => fields[key] === "true");
  const reportedExit = fields[`${stage}_exit_code`];
  const pass = error === null && marker && !conflicting
    && !fields.status_failure_code && !fields.service_check_failure_code
    && fields.service_check_timed_out !== "true" && fields.doctor_report_unavailable !== "true"
    && (reportedExit === undefined || reportedExit === "0");
  const failureCode = pass ? null : conflicting ? "conflicting_report"
    : error?.killed === true || fields.service_check_timed_out === "true" ? "check_timed_out"
    : fields.status_failure_code ?? fields.service_check_failure_code
      ?? (error === null && !marker ? "required_readiness_missing" : "check_failed");
  return { stage, pass, exitCode, failureCode, fields };
}

export async function runNativeChecks({
  candidateRoot = root, installedServiceRoot = candidateRoot,
  run = execute, write = (text) => process.stdout.write(text),
} = {}) {
  const candidate = await validateCheckRoot(candidateRoot);
  const installed = await validateCheckRoot(installedServiceRoot);
  const directory = join(candidate, "output");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Never overwrite the original receipt or an earlier run.
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const receipt = join(directory, `devkit-native-check-${stamp}-${randomUUID()}.json`);
  const handle = await open(receipt, "wx", 0o600);
  const result = {
    schemaVersion: 2, startedAt: new Date().toISOString(), complete: false, success: false,
    candidate: { root: candidate, nativeChecksPassed: false },
    installedService: { root: installed, checkoutMatchesCandidate: candidate === installed, statusPassed: null },
    checks: [],
  };
  const save = async () => {
    const data = Buffer.from(JSON.stringify(result, null, 2) + "\n");
    let offset = 0;
    while (offset < data.length) {
      const { bytesWritten } = await handle.write(data, offset, data.length - offset, offset);
      if (bytesWritten === 0) throw new Error("Could not save the check receipt.");
      offset += bytesWritten;
    }
    await handle.truncate(data.length);
  };
  try {
    await save();
    for (const stage of ["doctor", "smoke", "status"]) {
      const scope = stage === "status" ? "installed_service" : "candidate_native";
      const checkoutRoot = stage === "status" ? installed : candidate;
      write(`Checking ${scope === "installed_service" ? "installed service" : "candidate"} ${stage}...\n`);
      let check;
      try {
        const response = await run("/bin/bash", [join(checkoutRoot, "scripts/service-check.sh"), stage], {
          cwd: checkoutRoot, timeout: 100_000, maxBuffer: 200_000,
        });
        check = evaluateCheck(stage, response);
      } catch (error) {
        check = evaluateCheck(stage, { stdout: error.stdout, stderr: error.stderr, error });
      }
      result.checks.push({ ...check, scope, checkoutRoot });
      result.candidate.nativeChecksPassed = ["doctor", "smoke"].every((name) => result.checks.some((item) => item.stage === name && item.pass));
      if (stage === "status") result.installedService.statusPassed = check.pass;
      write(`${stage}: ${check.pass ? "passed" : `failed (${check.failureCode})`}\n`);
      await save();
      if (!check.pass) break;
    }
    result.complete = true;
    result.success = result.candidate.nativeChecksPassed && result.installedService.statusPassed === true;
    result.finishedAt = new Date().toISOString();
    await save();
  } finally {
    await handle.close();
  }
  write(`Candidate doctor and smoke: ${result.candidate.nativeChecksPassed ? "passed" : "not passed"}.\n`);
  write(`Installed-service status: ${result.installedService.statusPassed === null ? "not run" : result.installedService.statusPassed ? "passed" : "failed"}.\n`);
  if (!result.installedService.checkoutMatchesCandidate) {
    write("Status was requested from a different checkout; that result does not verify candidate installation.\n");
  }
  write(result.success ? "Native prerequisites and installed-service health passed. DevKit integration still needs separate acceptance.\n"
    : "Native prerequisites or installed-service health did not pass.\n");
  write(`Receipt: ${receipt}\n`);
  return { result, receipt };
}

const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== "darwin") throw new Error("This check requires macOS.");
    const options = parseArguments(process.argv.slice(2));
    const { result } = await runNativeChecks(options);
    process.exitCode = result.success ? 0 : 1;
  } catch {
    process.stderr.write(`${usage}\nCheck requires macOS, readable checkout scripts, and a writable candidate output directory. No service was installed or reconfigured.\n`);
    process.exitCode = 1;
  }
}
