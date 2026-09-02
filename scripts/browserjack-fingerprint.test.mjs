import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  approvalMatch,
  baselineMatch,
  fingerprintDigest,
  loadApprovals,
  resolveVerifiedBuildsFile,
  validateIdentity,
  writeApproval,
} from "./browserjack-fingerprint.mjs";

const policy = {
  identity: {
    bundleId: "com.openai.codex",
    teamId: "2DC432GLL2",
    nativeHostName: "com.openai.codexextension",
    preferredExtensionId: "a".repeat(32),
  },
  fingerprints: [{
    label: "test",
    browserClientSha256: "1".repeat(64),
    browserServiceSha256: "2".repeat(64),
    nativeHostSha256: "3".repeat(64),
  }],
};

function snapshot(overrides = {}) {
  return {
    appVersion: "1.0",
    buildVersion: "1",
    pluginVersion: "1.0",
    bundleId: policy.identity.bundleId,
    teamId: policy.identity.teamId,
    nativeHostName: policy.identity.nativeHostName,
    extensionId: policy.identity.preferredExtensionId,
    browserClientSha256: "1".repeat(64),
    browserServiceSha256: "2".repeat(64),
    nativeHostSha256: "3".repeat(64),
    bundledNativeHostSha256: "3".repeat(64),
    ...overrides,
  };
}

test("version and build metadata do not change the content fingerprint", () => {
  assert.equal(
    fingerprintDigest(snapshot()),
    fingerprintDigest(snapshot({ appVersion: "2.0", buildVersion: "99", pluginVersion: "2.0" })),
  );
});

test("verified-build path defaults under CODEX_HOME and rejects invalid overrides", () => {
  assert.equal(
    resolveVerifiedBuildsFile({ env: { CODEX_HOME: "/tmp/codex" }, home: "/Users/example" }),
    "/tmp/codex/chatgpt-browser-bridge/browserjack/verified-builds.json",
  );
  assert.equal(
    resolveVerifiedBuildsFile({ env: { BROWSERJACK_VERIFIED_BUILDS_FILE: "/tmp/custom.json" } }),
    "/tmp/custom.json",
  );
  for (const value of ["", "relative.json", "   "]) {
    assert.throws(
      () => resolveVerifiedBuildsFile({ env: { BROWSERJACK_VERIFIED_BUILDS_FILE: value } }),
      /BROWSERJACK_VERIFIED_BUILDS_FILE must be a non-empty absolute path/,
    );
  }
});

for (const field of ["browserClientSha256", "browserServiceSha256", "nativeHostSha256"]) {
  test(`a changed ${field} is not baseline-approved`, () => {
    assert.equal(baselineMatch(snapshot({ [field]: "f".repeat(64) }), policy), null);
  });
}

test("identity mismatches and divergent native hosts fail closed", () => {
  assert.throws(() => validateIdentity(snapshot({ bundleId: "com.example.fake" }), policy), /bundleId/);
  assert.throws(
    () => validateIdentity(snapshot({ bundledNativeHostSha256: "4".repeat(64) }), policy),
    /native host differs/,
  );
});

test("local approvals are atomic, private, and match exact fingerprints", async () => {
  const root = await mkdtemp(join(tmpdir(), "browserjack-approval-test-"));
  const path = join(root, "nested", "approvals.json");
  const current = snapshot({ browserServiceSha256: "f".repeat(64) });
  await writeApproval(path, current);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const approvals = await loadApprovals(path);
  assert.equal(approvalMatch(current, approvals)?.fingerprint, fingerprintDigest(current));
  assert.equal(approvalMatch(snapshot(), approvals), null);
  assert.equal(JSON.parse(await readFile(path, "utf8")).schemaVersion, 1);
});

test("an approval file with loose permissions fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "browserjack-approval-mode-test-"));
  const path = join(root, "approvals.json");
  await writeFile(path, '{"schemaVersion":1,"fingerprints":[]}\n', { mode: 0o644 });
  await chmod(path, 0o644);
  await assert.rejects(loadApprovals(path), /permissions must be 600/);
});
