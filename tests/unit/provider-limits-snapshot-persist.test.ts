import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// DB modules read DATA_DIR/API_KEY_SECRET at load time, so they must be imported
// dynamically after the env is set; static imports would be hoisted above it.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-snapshot-persist-"));
process.env.API_KEY_SECRET ??= "test-snapshot-persist-secret";

const { snapshotCacheEntry, syncAllProviderLimits, fetchAndPersistProviderLimits } =
  await import("../../src/lib/usage/providerLimits.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { setProviderLimitsCache, getProviderLimitsCache } =
  await import("../../src/lib/db/providerLimits.ts");
const { saveQuotaSnapshot } = await import("../../src/lib/db/quotaSnapshots.ts");

const CONN = "snapshot-persist-conn-1";

// Core bug being locked: quota_snapshots keeps advancing (background writer, ~5min)
// but the key_value providerLimitsCache — the ONLY thing a tab reload reads — stayed
// frozen whenever "Refresh now" hit a 429, because the fallback path served the fresh
// snapshot to the UI without ever writing it back. snapshotCacheEntry is the freshness
// gate the persist decision relies on: it must return the newer snapshot (so the caller
// persists it) and must reject a snapshot that is not strictly newer than key_value.

test("snapshotCacheEntry returns the snapshot when it is strictly newer than key_value", () => {
  const oldFetchedAt = "2026-07-08T08:55:00.000Z";
  setProviderLimitsCache(CONN, {
    quotas: {
      "session (5h)": {
        used: 46,
        total: 100,
        remaining: 54,
        remainingPercentage: 54,
        resetAt: "2026-07-08T11:30:00.000Z",
        unlimited: false,
      },
    },
    plan: null,
    message: null,
    fetchedAt: oldFetchedAt,
    source: "manual",
  });

  saveQuotaSnapshot({
    provider: "claude",
    connection_id: CONN,
    window_key: "session (5h)",
    remaining_percentage: 33,
    is_exhausted: 0,
    next_reset_at: "2026-07-08T11:30:00.000Z",
    window_duration_ms: null,
    raw_data: null,
  });

  const previous = getProviderLimitsCache(CONN);
  const snapshot = snapshotCacheEntry(CONN, previous);

  assert.ok(snapshot, "a strictly-newer snapshot must be returned so the caller can persist it");
  assert.equal(
    (snapshot!.quotas as Record<string, { remainingPercentage: number }>)["session (5h)"]
      .remainingPercentage,
    33,
    "the returned entry must carry the fresh snapshot percentage, not the stale 54"
  );
  assert.ok(
    Date.parse(snapshot!.fetchedAt) > Date.parse(previous!.fetchedAt),
    "the returned entry's fetchedAt must be newer than the frozen key_value entry"
  );
});

test("snapshotCacheEntry rejects a snapshot that is not strictly newer than key_value", () => {
  const conn2 = "snapshot-persist-conn-2";
  saveQuotaSnapshot({
    provider: "claude",
    connection_id: conn2,
    window_key: "session (5h)",
    remaining_percentage: 40,
    is_exhausted: 0,
    next_reset_at: "2026-07-08T11:30:00.000Z",
    window_duration_ms: null,
    raw_data: null,
  });

  // key_value stamped far in the future → newer than any snapshot we just wrote.
  setProviderLimitsCache(conn2, {
    quotas: {
      "session (5h)": {
        used: 20,
        total: 100,
        remaining: 80,
        remainingPercentage: 80,
        resetAt: "2026-07-08T11:30:00.000Z",
        unlimited: false,
      },
    },
    plan: null,
    message: null,
    fetchedAt: "2030-01-01T00:00:00.000Z",
    source: "manual",
  });

  const previous = getProviderLimitsCache(conn2);
  const snapshot = snapshotCacheEntry(conn2, previous);
  assert.equal(
    snapshot,
    null,
    "a snapshot older than key_value must be rejected so persist never overwrites fresher data"
  );
});

// Both "Refresh now" and "Refresh All" receive a cache that the merge already
// swapped back to the prior entry when the live fetch fails, so the failure must
// be classified on the raw fetch result or the snapshot fallback never runs.
for (const entryPoint of ["fetchAndPersistProviderLimits", "syncAllProviderLimits"] as const) {
  test(`${entryPoint}: a 429 with a usable prior cache persists the fresher snapshot`, async () => {
    // Context7 surfaces any upstream failure as an error-only `{ message }` result
    // (no quotas) — the same shape a rate-limited Claude/Codex usage fetch yields.
    const connection = (await providersDb.createProviderConnection({
      provider: "context7",
      authType: "apikey",
      name: `Snapshot fallback ${entryPoint}`,
      apiKey: `ctx7-snapshot-${entryPoint}`,
    })) as { id: string };
    setProviderLimitsCache(connection.id, {
      quotas: {
        session: {
          used: 10,
          total: 100,
          remaining: 90,
          remainingPercentage: 90,
          resetAt: null,
          unlimited: false,
        },
      },
      plan: null,
      message: null,
      fetchedAt: "2026-07-08T08:55:00.000Z",
      source: "manual",
    });
    saveQuotaSnapshot({
      provider: "context7",
      connection_id: connection.id,
      window_key: "session",
      remaining_percentage: 25,
      is_exhausted: 0,
      next_reset_at: null,
      window_duration_ms: null,
      raw_data: null,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })) as typeof fetch;
    try {
      if (entryPoint === "fetchAndPersistProviderLimits") {
        await fetchAndPersistProviderLimits(connection.id, "manual");
      } else {
        const result = await syncAllProviderLimits({ source: "manual" });
        const served = result.caches[connection.id]?.quotas as Record<
          string,
          { remainingPercentage: number }
        >;
        assert.equal(served.session.remainingPercentage, 25, "Refresh All must serve the snapshot");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    const persisted = getProviderLimitsCache(connection.id)?.quotas as Record<
      string,
      { remainingPercentage: number }
    >;
    assert.equal(persisted.session.remainingPercentage, 25, "the snapshot must reach key_value");
  });
}
