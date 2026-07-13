import test from "node:test";
import assert from "node:assert/strict";

const { shouldNotifyTierDrop, resetComboTierDropState } =
  await import("../../src/lib/webhooks/comboTierDropDedup.ts");

test("serving premium never signals", () => {
  resetComboTierDropState();
  assert.equal(shouldNotifyTierDrop("c1", true), false);
});

test("first drop off premium signals exactly once", () => {
  resetComboTierDropState();
  assert.equal(shouldNotifyTierDrop("c1", true), false); // on premium
  assert.equal(shouldNotifyTierDrop("c1", false), true); // dropped → signal
  assert.equal(shouldNotifyTierDrop("c1", false), false); // still down → silent
  assert.equal(shouldNotifyTierDrop("c1", false), false); // still down → silent
});

test("recovering to premium re-arms; a later drop signals again", () => {
  resetComboTierDropState();
  assert.equal(shouldNotifyTierDrop("c1", false), true); // first drop
  assert.equal(shouldNotifyTierDrop("c1", false), false); // silent
  assert.equal(shouldNotifyTierDrop("c1", true), false); // recovered (re-arm)
  assert.equal(shouldNotifyTierDrop("c1", false), true); // drops again → signal
});

test("combos are tracked independently", () => {
  resetComboTierDropState();
  assert.equal(shouldNotifyTierDrop("c1", false), true);
  assert.equal(shouldNotifyTierDrop("c2", false), true);
  assert.equal(shouldNotifyTierDrop("c1", false), false);
});
