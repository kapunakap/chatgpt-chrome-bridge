import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shim = resolve(repoRoot, "scripts/tunnel-client-current.sh");

test("tunnel-client shim accepts 0.0.14 and rejects the previous current version", async (t) => {
  const directory = await mkdtemp(join(repoRoot, ".git", "tunnel-client-current-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fake = join(directory, "tunnel-client");
  await writeFile(fake, `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf '%s\\n' "\${FAKE_TUNNEL_CLIENT_VERSION}"
  exit 0
fi
printf 'initialized=%s\\n' "\${MCP_STDIO_SEND_INITIALIZED_NOTIFICATION:-false}"
`);
  await chmod(fake, 0o755);
  const env = { ...process.env, PATH: `${directory}:${process.env.PATH}` };

  const expected = spawnSync(shim, ["--expected-version"], { encoding: "utf8", env });
  assert.equal(expected.status, 0, expected.stderr);
  assert.equal(expected.stdout, "0.0.14\n");

  const accepted = spawnSync(shim, ["run"], {
    encoding: "utf8",
    env: { ...env, FAKE_TUNNEL_CLIENT_VERSION: "0.0.14+test-build" },
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout, "initialized=true\n");

  const rejected = spawnSync(shim, ["run"], {
    encoding: "utf8",
    env: { ...env, FAKE_TUNNEL_CLIENT_VERSION: "0.0.13+old-build" },
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Unsupported tunnel-client version: 0\.0\.13\+old-build \(expected 0\.0\.14\)/u);
});
