import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { evaluateCheck, parseArguments, runNativeChecks, safeCheckFields } from "./devkit-native-check.mjs";

const execute = promisify(execFile);
const scripts = dirname(fileURLToPath(import.meta.url));
const secret = "PRIVATE_FIXTURE_TOKEN_DO_NOT_EXPORT";
const statusOutput = "status_exit_code=0\\nlaunch_agent_installed=true\\nlaunch_agent_loaded=true\\nlaunch_agent_running=true\\nlaunch_agent_pid_alive=true\\nprocess_running=true\\nhealthy=true\\nready=true\\nbrowser_ready=true\\nhealth_watch_ready=true\\n";
const candidateScript = `case "$1" in
  doctor) printf 'doctor_exit_code=0\\ndoctor_ready=true\\n' ;;
  smoke) printf 'smoke_exit_code=0\\nexample_title=Example Domain\\n' ;;
  *) exit 97 ;;
esac\n`;
const installedScript = `case "$1" in
  status) printf '${statusOutput}' ;;
  *) exit 98 ;;
esac\n`;

async function temporary(t) {
  const path = await realpath(await mkdtemp(join(tmpdir(), "native-check-fixture-")));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function checkout(parent, name, script) {
  const path = join(parent, name);
  await mkdir(join(path, "scripts"), { recursive: true });
  await writeFile(join(path, "scripts/service-check.sh"), script);
  await writeFile(join(path, "scripts/status.sh"), "# fixture only; no service operation\n");
  return path;
}

async function summarize(parent, stage, raw, code) {
  const path = join(parent, `raw-${stage}.txt`);
  await writeFile(path, raw);
  return (await execute("python3", [join(scripts, "service-check-report.py"), stage, path, String(code)])).stdout;
}

test("explicit installed root routes only status, records both scopes, and preserves receipts", async (t) => {
  const parent = await temporary(t);
  const candidate = await checkout(parent, "candidate", candidateScript);
  const installed = await checkout(parent, "installed", installedScript);
  await mkdir(join(candidate, "output"));
  const original = join(candidate, "output/devkit-native-check.json");
  await writeFile(original, "original receipt remains unchanged\n");
  const calls = [];
  let printed = "";
  const options = {
    candidateRoot: candidate, installedServiceRoot: installed,
    run: async (command, args, settings) => { calls.push({ command, args, settings }); return execute(command, args, settings); },
    write: (text) => { printed += text; },
  };
  const first = await runNativeChecks(options);
  assert.equal(first.result.success, true);
  assert.equal(first.result.candidate.nativeChecksPassed, true);
  assert.equal(first.result.installedService.statusPassed, true);
  assert.equal(first.result.installedService.checkoutMatchesCandidate, false);
  assert.deepEqual(first.result.checks.map(({ stage, scope, checkoutRoot }) => [stage, scope, checkoutRoot]), [
    ["doctor", "candidate_native", candidate], ["smoke", "candidate_native", candidate], ["status", "installed_service", installed],
  ]);
  assert.deepEqual(calls.map(({ args, settings }) => [args[0], settings.cwd]), [
    [join(candidate, "scripts/service-check.sh"), candidate],
    [join(candidate, "scripts/service-check.sh"), candidate],
    [join(installed, "scripts/service-check.sh"), installed],
  ]);
  assert.match(printed, /does not verify candidate installation/u);
  assert.match(printed, /DevKit integration still needs separate acceptance/u);
  assert.deepEqual(JSON.parse(await readFile(first.receipt, "utf8")), first.result);
  assert.equal((await stat(first.receipt)).mode & 0o777, 0o600);
  const savedFirst = await readFile(first.receipt, "utf8");
  const second = await runNativeChecks(options);
  assert.notEqual(second.receipt, first.receipt);
  assert.equal(await readFile(first.receipt, "utf8"), savedFirst);
  assert.equal(await readFile(original, "utf8"), "original receipt remains unchanged\n");
});

test("default status root remains the candidate checkout", async (t) => {
  const parent = await temporary(t);
  const script = candidateScript.replace("  *) exit 97 ;;", `  status) printf '${statusOutput}' ;;\n  *) exit 97 ;;`);
  const candidate = await checkout(parent, "candidate", script);
  const { result } = await runNativeChecks({ candidateRoot: candidate, write: () => {} });
  assert.equal(result.success, true);
  assert.equal(result.installedService.root, candidate);
  assert.equal(result.installedService.checkoutMatchesCandidate, true);
  assert.equal(result.checks.at(-1).scope, "installed_service");
});

test("a real installed-status process failure preserves candidate passes and redacts private output", async (t) => {
  const parent = await temporary(t);
  const candidate = await checkout(parent, "candidate", candidateScript);
  const installed = await checkout(parent, "installed", `printf 'status_exit_code=1\\nlaunch_agent_installed=true\\nstatus_failure_code=service_not_running\\napi_key=${secret}\\n'\nprintf '${secret}\\n' >&2\nexit 1\n`);
  let printed = "";
  const { result, receipt } = await runNativeChecks({ candidateRoot: candidate, installedServiceRoot: installed, write: (text) => { printed += text; } });
  assert.equal(result.success, false);
  assert.equal(result.candidate.nativeChecksPassed, true);
  assert.equal(result.installedService.statusPassed, false);
  assert.equal(result.checks.at(-1).exitCode, 1);
  assert.equal(result.checks.at(-1).failureCode, "service_not_running");
  assert.equal(result.checks.length, 3);
  assert.equal((await readFile(receipt, "utf8")).includes(secret), false);
  assert.equal(printed.includes(secret), false);
});

test("doctor failure cannot pass because its output contains a readiness marker; no later checks run", async (t) => {
  const parent = await temporary(t);
  const candidate = await checkout(parent, "candidate", "printf 'doctor_exit_code=1\\ndoctor_ready=true\\n'\nexit 1\n");
  const { result } = await runNativeChecks({ candidateRoot: candidate, write: () => {} });
  assert.equal(result.success, false);
  assert.equal(result.candidate.nativeChecksPassed, false);
  assert.equal(result.installedService.statusPassed, null);
  assert.equal(result.checks.length, 1);
});

test("missing readiness, timeout and contradictory reports stay failures without exposing error messages", () => {
  assert.equal(evaluateCheck("smoke", { stdout: "smoke_exit_code=0\n" }).failureCode, "required_readiness_missing");
  assert.equal(evaluateCheck("doctor", { stdout: "doctor_ready=true\ndoctor_ready=false\n" }).failureCode, "conflicting_report");
  const result = evaluateCheck("status", { stderr: secret, error: { killed: true, code: secret, message: secret } });
  assert.equal(result.pass, false);
  assert.equal(result.exitCode, null);
  assert.equal(result.failureCode, "check_timed_out");
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(evaluateCheck("status", { stdout: "status_exit_code=1\n" }).pass, false);
  assert.equal(evaluateCheck("status", { stdout: "" }).failureCode, "required_readiness_missing");
  assert.equal(evaluateCheck("status", { stdout: "status_exit_code=0\nlaunch_agent_installed=true\nhealthy=true\nready=true\n" }).pass, false);
  assert.equal(evaluateCheck("status", { stdout: "status_exit_code=0\nbrowser_ready=false\nready=false\n" }).pass, false);
  assert.deepEqual(safeCheckFields(`private_key=true\napi_key=12345\n${secret}=true\nhealthy=true\n`).fields, { healthy: "true" });
});

test("the unchanged status guard rejects a different installed checkout and reports a safe reason", async (t) => {
  const parent = await temporary(t);
  const candidate = await checkout(parent, "candidate", candidateScript);
  const fakeBin = join(parent, "bin");
  await mkdir(fakeBin);
  await copyFile(join(scripts, "status.sh"), join(candidate, "scripts/status.sh"));
  const launcher = join(candidate, "scripts/tunnel-client-current.sh");
  const browser = join(candidate, "scripts/browserjack-discovery-compat.mjs");
  await writeFile(launcher, "#!/bin/sh\nprintf '0.0.14\\n'\n", { mode: 0o700 });
  await writeFile(browser, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await writeFile(join(candidate, "scripts/browserjack-health.mjs"), "// fixture\n");
  await writeFile(join(fakeBin, "launchctl"), "#!/bin/sh\nprintf '/different/installed/scripts/tunnel-client-current.sh\\n'\n", { mode: 0o700 });
  const plist = join(parent, "fixture.plist");
  await writeFile(plist, "fixture only\n");
  let failure;
  try {
    await execute("/bin/bash", [join(candidate, "scripts/status.sh")], {
      env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin`, BROWSERJACK_COMMAND: browser, LOCAL_CHROME_LAUNCH_AGENT_PLIST: plist },
    });
  } catch (error) { failure = error; }
  assert.equal(failure?.code, 1);
  assert.match(failure.stdout, /launch_agent_installed=true/u);
  assert.match(failure.stderr, /not using the checked-in tunnel-client launcher/u);
  const output = await summarize(parent, "status", `${failure.stdout}\n${failure.stderr}\napi_key=${secret}\n`, failure.code);
  assert.match(output, /^status_failure_code=installed_checkout_mismatch$/mu);
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes("/different/installed"), false);
  const evaluated = evaluateCheck("status", { stdout: output, error: failure });
  assert.equal(evaluated.pass, false);
  assert.equal(evaluated.failureCode, "installed_checkout_mismatch");
});

test("service report strips secret keys, paths, raw errors and doctor IDs while keeping safe evidence", async (t) => {
  const parent = await temporary(t);
  const doctor = await summarize(parent, "doctor", JSON.stringify({ ready: true, checks: [{ id: secret, status: "pass", detail: secret }], token: secret }), 0);
  assert.match(doctor, /doctor_ready=true/u);
  assert.match(doctor, /doctor_checks_passed=1/u);
  assert.equal(doctor.includes(secret), false);
  const status = await summarize(parent, "status", `healthy=false\napi_key=${secret}\nprivate_key=true\nsecret_number=123456\nERROR: ${secret}\n/Users/private/person/path\n`, 2);
  assert.equal(status, "status_exit_code=2\nhealthy=false\nstatus_failure_code=check_failed\n");
  const malformed = await summarize(parent, "doctor", "[]", 0);
  assert.match(malformed, /doctor_report_unavailable=true/u);
  assert.equal(evaluateCheck("doctor", { stdout: malformed }).pass, false);
});

test("root selection rejects relative paths, unknown options and scripts escaping the chosen checkout", async (t) => {
  assert.deepEqual(parseArguments([]), {});
  assert.deepEqual(parseArguments(["--installed-service-root", "/known/checkout"]), { installedServiceRoot: "/known/checkout" });
  for (const args of [["--installed-service-root", "relative"], ["--skip-status"], ["--installed-service-root"]]) {
    assert.throws(() => parseArguments(args), /Usage:/u);
  }
  const parent = await temporary(t);
  const candidate = await checkout(parent, "candidate", candidateScript);
  const installed = await checkout(parent, "installed", installedScript);
  await rm(join(installed, "scripts/status.sh"));
  await symlink(join(candidate, "scripts/status.sh"), join(installed, "scripts/status.sh"));
  let invoked = false;
  await assert.rejects(runNativeChecks({
    candidateRoot: candidate, installedServiceRoot: installed,
    run: async () => { invoked = true; }, write: () => {},
  }), /inside the selected checkout/u);
  assert.equal(invoked, false);
});

test("a symlinked checker entry point still validates CLI input without running service checks", async (t) => {
  const parent = await temporary(t);
  const entry = join(parent, "checker.mjs");
  await symlink(join(scripts, "devkit-native-check.mjs"), entry);
  await assert.rejects(execute(process.execPath, [entry, "--unsupported-option"]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Usage: node scripts\/devkit-native-check.mjs/u);
    return true;
  });
});
