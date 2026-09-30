import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";

import {
  parseLegacyExtensionMetadata,
  parsePluralExtensionMetadata,
} from "./browserjack-fingerprint.mjs";
import { resolveSignedCodexPath, selectV2RuntimeEntry } from "./browserjack-runtime.mjs";

const chromeId = "hehggadaopoacecdllhhajmbjkdcmajg";
const edgeId = "odlomjlbamekndcpllcnffbgeohgkmjh";

async function withResources(setup) {
  const root = await mkdtemp(join(process.cwd(), ".browserjack-runtime-test-"));
  try {
    const expected = await setup(root);
    return { expected, resolved: await resolveSignedCodexPath(root) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("resolves the current nested signed Codex executable", async () => {
  const { expected, resolved } = await withResources(async (root) => {
    const directory = join(root, "codex-cli/CodexCLI.app/Contents/MacOS");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "codex");
    await writeFile(path, "current");
    await writeFile(join(root, "codex"), "legacy");
    return path;
  });
  assert.equal(resolved, expected);
});

test("retains the legacy top-level Codex layout", async () => {
  const { expected, resolved } = await withResources(async (root) => {
    const path = join(root, "codex");
    await writeFile(path, "legacy");
    return path;
  });
  assert.equal(resolved, expected);
});

test("rejects a Codex candidate that escapes the signed app resources", async () => {
  const root = await mkdtemp(join(process.cwd(), ".browserjack-runtime-test-"));
  const outside = await mkdtemp(join(process.cwd(), ".browserjack-runtime-outside-"));
  try {
    const target = join(outside, "codex");
    await writeFile(target, "outside");
    const directory = join(root, "codex-cli/CodexCLI.app/Contents/MacOS");
    await mkdir(directory, { recursive: true });
    await symlink(target, join(directory, "codex"));
    await assert.rejects(
      () => resolveSignedCodexPath(root),
      /ChatGPT codex binary escapes its trusted root/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("plural extension metadata selects the signed Chrome store ID", () => {
  const value = parsePluralExtensionMetadata({
    extensionHostName: "com.openai.codexextension",
    extensionIds: [edgeId, chromeId],
    browserExtensions: [
      { browserFamily: "edge", extensionIds: [edgeId, chromeId], storeExtensionId: edgeId },
      { browserFamily: "chrome", extensionIds: [chromeId, edgeId], storeExtensionId: chromeId },
    ],
  });
  assert.equal(value.extensionId, chromeId);
  assert.deepEqual(value.extensionIds, [edgeId, chromeId]);
});

test("legacy singular extension metadata remains supported", () => {
  assert.deepEqual(
    parseLegacyExtensionMetadata({ extensionId: chromeId, extensionHostName: "com.openai.codexextension" }).extensionIds,
    [chromeId],
  );
});

test("plural metadata fails closed when Chrome and Edge cannot be distinguished", () => {
  assert.throws(
    () => parsePluralExtensionMetadata({
      extensionHostName: "com.openai.codexextension",
      extensionIds: [chromeId, edgeId],
      browserExtensions: [
        { browserFamily: "edge", extensionIds: [edgeId], storeExtensionId: edgeId },
      ],
    }),
    /exactly one Chrome browser entry/,
  );
  assert.throws(
    () => parsePluralExtensionMetadata({
      extensionHostName: "com.openai.codexextension",
      extensionIds: [chromeId, edgeId],
      browserExtensions: [
        { browserFamily: "chrome", extensionIds: [chromeId, edgeId] },
      ],
    }),
    /storeExtensionId/,
  );
});

test("v2 registry selects the current signed app entry", () => {
  const entry = { schemaVersion: 2, appVersion: "26.831.21537", channel: "prod", appServerProtocolVersion: 2, nativeHostProtocolVersion: 2, extensionBuildChannels: ["prod"], nativeHostNames: ["com.openai.codexextension"], extensionIds: [chromeId, edgeId], paths: {} };
  assert.equal(
    selectV2RuntimeEntry({ schemaVersion: 2, entries: [entry] }, {
      appVersion: "26.831.21537",
      nativeHostName: "com.openai.codexextension",
      extensionIds: [chromeId, edgeId],
    }),
    entry,
  );
});

test("v2 registry rejects a stale app or protocol entry", () => {
  const entry = { schemaVersion: 2, appVersion: "26.831.21537", channel: "prod", appServerProtocolVersion: 1, nativeHostProtocolVersion: 2, extensionBuildChannels: ["prod"], nativeHostNames: ["com.openai.codexextension"], extensionIds: [chromeId], paths: {} };
  assert.throws(
    () => selectV2RuntimeEntry({ schemaVersion: 2, entries: [entry] }, { appVersion: "26.831.21537", nativeHostName: "com.openai.codexextension", extensionIds: [chromeId] }),
    /found 0/,
  );
});

test("v2 entries expose the paths needed by trusted browser RPC", () => {
  const entry = { schemaVersion: 2, appVersion: "26.831.21537", channel: "prod", appServerProtocolVersion: 2, nativeHostProtocolVersion: 2, extensionBuildChannels: ["prod"], nativeHostNames: ["com.openai.codexextension"], extensionIds: [chromeId], paths: {
    nodeReplPath: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl",
    nodePath: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
    nodeModuleDirs: ["/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules"],
    codexCliPath: "/tmp/example/.codex/plugins/.plugin-appserver/codex",
    browserClientPath: "/tmp/example/.codex/plugins/cache/openai-bundled/chrome/latest/scripts/browser-client.mjs",
    browserServicePath: "/tmp/example/.codex/plugins/cache/openai-bundled/chrome/latest/scripts/browser-service.mjs",
    extensionHostPath: "/tmp/example/.codex/plugins/cache/openai-bundled/chrome/latest/extension-host/macos/arm64/ChatGPT for Chrome",
  } };
  const selected = selectV2RuntimeEntry({ schemaVersion: 2, entries: [entry] }, {
    appVersion: "26.831.21537",
    nativeHostName: "com.openai.codexextension",
    extensionIds: [chromeId],
  });
  assert.equal(selected.paths.browserServicePath.endsWith("browser-service.mjs"), true);
  assert.equal(selected.paths.nodeReplPath.endsWith("node_repl"), true);
});
