import test from "node:test";
import assert from "node:assert/strict";

const { shouldNotifyWarn, resetWarnDedupState } =
  await import("../../src/lib/quota/warnNotificationDedup.ts");

test("first warning for a (provider, connection, window) is allowed", () => {
  resetWarnDedupState();
  assert.equal(shouldNotifyWarn("codex", "conn-1", "session", "2026-01-01T00:00:00.000Z"), true);
});

test("second warning in the same reset cycle is suppressed", () => {
  resetWarnDedupState();
  const resetAt = "2026-01-01T00:00:00.000Z";
  assert.equal(shouldNotifyWarn("codex", "conn-1", "session", resetAt), true);
  assert.equal(shouldNotifyWarn("codex", "conn-1", "session", resetAt), false);
  assert.equal(shouldNotifyWarn("codex", "conn-1", "session", resetAt), false);
});

test("a new reset cycle (later resetAt) re-arms the warning", () => {
  resetWarnDedupState();
  assert.equal(shouldNotifyWarn("codex", "conn-1", "session", "2026-01-01T00:00:00.000Z"), true);
  assert.equal(shouldNotifyWarn("codex", "conn-1", "session", "2026-01-01T00:00:00.000Z"), false);
  assert.equal(shouldNotifyWarn("codex", "conn-1", "session", "2026-01-02T00:00:00.000Z"), true);
});

test("sub-second/minute resetAt jitter does NOT re-arm (the spam bug)", () => {
  resetWarnDedupState();
  // Provider reports the same ~08:00 reset with millisecond wobble each poll.
  assert.equal(shouldNotifyWarn("claude", "c1", "weekly (7d)", "2026-07-14T07:59:59.792Z"), true);
  assert.equal(shouldNotifyWarn("claude", "c1", "weekly (7d)", "2026-07-14T08:00:00.151Z"), false);
  assert.equal(shouldNotifyWarn("claude", "c1", "weekly (7d)", "2026-07-14T07:59:59.994Z"), false);
  assert.equal(shouldNotifyWarn("claude", "c1", "weekly (7d)", "2026-07-14T08:00:00.463Z"), false);
  // A jitter within a few minutes also stays silent.
  assert.equal(shouldNotifyWarn("claude", "c1", "weekly (7d)", "2026-07-14T08:03:00.000Z"), false);
  // But a genuinely new cycle (well beyond the tolerance) re-arms.
  assert.equal(shouldNotifyWarn("claude", "c1", "weekly (7d)", "2026-07-14T09:00:00.000Z"), true);
});

test("distinct windows and connections are tracked independently", () => {
  resetWarnDedupState();
  const resetAt = "2026-01-01T00:00:00.000Z";
  assert.equal(shouldNotifyWarn("codex", "conn-1", "session", resetAt), true);
  assert.equal(shouldNotifyWarn("codex", "conn-1", "weekly", resetAt), true);
  assert.equal(shouldNotifyWarn("codex", "conn-2", "session", resetAt), true);
  assert.equal(shouldNotifyWarn("codex", "conn-1", "session", resetAt), false);
});

test("null resetAt re-arms only after the fallback window elapses", () => {
  resetWarnDedupState();
  const base = 1_000_000_000_000;
  assert.equal(shouldNotifyWarn("groq", "conn-9", null, null, base), true);
  assert.equal(shouldNotifyWarn("groq", "conn-9", null, null, base + 60_000), false);
  const afterFallback = base + 6 * 60 * 60 * 1000 + 1;
  assert.equal(shouldNotifyWarn("groq", "conn-9", null, null, afterFallback), true);
});
