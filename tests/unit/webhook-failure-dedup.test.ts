import test from "node:test";
import assert from "node:assert/strict";

const { recordFailureForNotify, resetFailureDedupState } =
  await import("../../src/lib/webhooks/failureNotificationDedup.ts");

const WINDOW_MS = 5 * 60 * 1000;

test("first failure of a key notifies immediately with count 1", () => {
  resetFailureDedupState();
  assert.deepEqual(recordFailureForNotify("auto", "codex", 429, 1000), {
    shouldNotify: true,
    count: 1,
  });
});

test("subsequent failures in the same window are grouped silently", () => {
  resetFailureDedupState();
  const t = 1000;
  assert.equal(recordFailureForNotify("auto", "codex", 429, t).shouldNotify, true);
  assert.deepEqual(recordFailureForNotify("auto", "codex", 429, t + 1000), {
    shouldNotify: false,
    count: 2,
  });
  assert.deepEqual(recordFailureForNotify("auto", "codex", 429, t + 2000), {
    shouldNotify: false,
    count: 3,
  });
});

test("distinct (combo, provider, status) keys are tracked independently", () => {
  resetFailureDedupState();
  const t = 1000;
  assert.equal(recordFailureForNotify("auto", "codex", 429, t).shouldNotify, true);
  assert.equal(recordFailureForNotify("auto", "codex", 500, t).shouldNotify, true);
  assert.equal(recordFailureForNotify("auto", "claude", 429, t).shouldNotify, true);
  assert.equal(recordFailureForNotify("(single)", "codex", 429, t).shouldNotify, true);
  assert.equal(recordFailureForNotify("auto", "codex", 429, t + 100).shouldNotify, false);
});

test("after the window elapses, a rollup notification reports the grouped total", () => {
  resetFailureDedupState();
  const t = 1000;
  recordFailureForNotify("auto", "codex", 429, t); // notify, count 1
  recordFailureForNotify("auto", "codex", 429, t + 1000); // silent, count 2
  recordFailureForNotify("auto", "codex", 429, t + 2000); // silent, count 3
  // Window elapsed → rollup includes the 3 grouped + this one = 4.
  assert.deepEqual(recordFailureForNotify("auto", "codex", 429, t + WINDOW_MS + 1), {
    shouldNotify: true,
    count: 4,
  });
  // Fresh window starts counting again.
  assert.deepEqual(recordFailureForNotify("auto", "codex", 429, t + WINDOW_MS + 2), {
    shouldNotify: false,
    count: 2,
  });
});
