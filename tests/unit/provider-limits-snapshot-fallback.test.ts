import test from "node:test";
import assert from "node:assert/strict";

import { snapshotRowsToQuotas } from "../../src/lib/usage/providerLimits";

// Regression lock for the "Refresh now shows hours-old data" bug: the DB helper
// getLatestQuotaSnapshotsForConnection runs rows through rowToCamel, so at
// runtime the fields are camelCase (windowKey/remainingPercentage/...) even
// though QuotaSnapshotRow is typed snake_case. Reading only snake_case dropped
// every window, so the snapshot fallback returned nothing and the card kept the
// stale key_value cache. These tests assert both shapes are honored.

test("snapshotRowsToQuotas reads camelCase rows (the real rowToCamel runtime shape)", () => {
  const rows = [
    {
      windowKey: "session (5h)",
      remainingPercentage: 64,
      nextResetAt: "2026-07-08T11:30:00Z",
      createdAt: "2026-07-08T15:35:12Z",
    },
    {
      windowKey: "weekly fable (7d)",
      remainingPercentage: 72,
      nextResetAt: "2026-07-14T08:00:00Z",
      createdAt: "2026-07-08T15:35:12Z",
    },
  ];

  const { quotas, newestMs } = snapshotRowsToQuotas(rows as never);

  assert.deepEqual(Object.keys(quotas).sort(), ["session (5h)", "weekly fable (7d)"]);
  const session = quotas["session (5h)"] as { used: number; remaining: number; resetAt: string };
  assert.equal(session.used, 36);
  assert.equal(session.remaining, 64);
  assert.equal(session.resetAt, "2026-07-08T11:30:00Z");
  assert.equal(newestMs, Date.parse("2026-07-08T15:35:12Z"));
});

test("snapshotRowsToQuotas still reads snake_case rows (defensive fallback)", () => {
  const rows = [
    {
      window_key: "session (5h)",
      remaining_percentage: 40,
      next_reset_at: "2026-07-08T11:30:00Z",
      created_at: "2026-07-08T15:00:00Z",
    },
  ];

  const { quotas, newestMs } = snapshotRowsToQuotas(rows as never);

  assert.deepEqual(Object.keys(quotas), ["session (5h)"]);
  const session = quotas["session (5h)"] as { used: number; remaining: number };
  assert.equal(session.used, 60);
  assert.equal(session.remaining, 40);
  assert.equal(newestMs, Date.parse("2026-07-08T15:00:00Z"));
});

test("snapshotRowsToQuotas clamps remaining percentage into 0-100", () => {
  const rows = [
    { windowKey: "a", remainingPercentage: 150, createdAt: "2026-07-08T15:00:00Z" },
    { windowKey: "b", remainingPercentage: -10, createdAt: "2026-07-08T15:00:00Z" },
  ];

  const { quotas } = snapshotRowsToQuotas(rows as never);

  assert.equal((quotas["a"] as { remaining: number }).remaining, 100);
  assert.equal((quotas["b"] as { remaining: number }).remaining, 0);
});

test("snapshotRowsToQuotas skips rows without a window key", () => {
  const rows = [
    { remainingPercentage: 50, createdAt: "2026-07-08T15:00:00Z" },
    { windowKey: "weekly (7d)", remainingPercentage: 80, createdAt: "2026-07-08T15:00:00Z" },
  ];

  const { quotas } = snapshotRowsToQuotas(rows as never);

  assert.deepEqual(Object.keys(quotas), ["weekly (7d)"]);
});

test("snapshotRowsToQuotas returns empty for null/empty input", () => {
  assert.deepEqual(snapshotRowsToQuotas(null), { quotas: {}, newestMs: 0 });
  assert.deepEqual(snapshotRowsToQuotas([]), { quotas: {}, newestMs: 0 });
});

test("snapshotRowsToQuotas tracks the newest createdAt across rows", () => {
  const rows = [
    { windowKey: "a", remainingPercentage: 50, createdAt: "2026-07-08T15:00:00Z" },
    { windowKey: "b", remainingPercentage: 50, createdAt: "2026-07-08T15:35:12Z" },
    { windowKey: "c", remainingPercentage: 50, createdAt: "2026-07-08T15:10:00Z" },
  ];

  const { newestMs } = snapshotRowsToQuotas(rows as never);

  assert.equal(newestMs, Date.parse("2026-07-08T15:35:12Z"));
});
