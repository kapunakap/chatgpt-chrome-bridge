import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const prepareScript = await readFile(
  new URL("./prepare-browserjack.sh", import.meta.url),
  "utf8",
);

test("MCP instructions use the stable signed-app browser client URL", () => {
  const replacement = prepareScript.match(
    /old = '''  const browserClientUrl = pathToFileURL\(launch\.runtime\.browserClientPath\)\.href;'''\nnew = '''([\s\S]*?)'''\nif old not in server:\n    raise SystemExit\("BrowserJack browser-client instruction URL no longer matches the pinned upstream commit"\)/,
  )?.[1];

  assert.ok(replacement, "missing the BrowserJack instruction URL compatibility transformation");
  assert.match(replacement, /launch\.runtime\.appPath/);
  assert.match(replacement, /Contents[\s\S]*Resources[\s\S]*plugins[\s\S]*openai-bundled[\s\S]*plugins[\s\S]*chrome[\s\S]*scripts[\s\S]*browser-client\.mjs/);
  assert.doesNotMatch(replacement, /launch\.runtime\.browserClientPath/);
});

test("launch environment preserves the signed app TinySky setting", () => {
  assert.match(prepareScript, /BROWSER_USE_TINYSKY_ENABLED: runtime\.tinyskyEnabled/);
});

test("discovery runtime includes the validated TinySky setting", () => {
  const replacement = prepareScript.match(
    /old = '''    codexPath: await realpath\(join\(resourcesRoot, "codex"\)\),[\s\S]*?new = '''([\s\S]*?)'''\nif old not in app:/,
  )?.[1];

  assert.ok(replacement, "missing the BrowserJack discovery runtime transformation");
  assert.match(replacement, /tinyskyEnabled: validatedRuntime\?\.tinyskyEnabled \?\? "0",/);
});
