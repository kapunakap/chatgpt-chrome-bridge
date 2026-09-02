import assert from "node:assert/strict";
import test from "node:test";

import { requireChromeBackend } from "./browserjack-live-probe.mjs";

test("zero browser backends fail the live probe", () => {
  assert.throws(() => requireChromeBackend([]), /No browser backends are connected/);
});

test("live probe requires a Chrome backend", () => {
  assert.throws(() => requireChromeBackend([{ family: "iab" }]), /Chrome backend is not connected/);
  assert.deepEqual(requireChromeBackend([{ family: "chrome", id: "1" }]), { family: "chrome", id: "1" });
});
