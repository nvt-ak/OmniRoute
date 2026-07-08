import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// Regression lock for the "Refresh now shows fresh time, tab reload reverts to old
// time" bug. In fetchQuota() the card previously stamped `new Date().toISOString()`
// onto lastRefreshedAt unconditionally. But when the upstream fetch is rate-limited
// (429) the server returns the last-known cached data with its ORIGINAL (older)
// fetchedAt plus _stale=true and does NOT persist to the key_value cache. Stamping
// "now" made the card show e.g. 16:48 while the DB (and thus a tab reload via
// applyCachedQuotaState, which reads cached.fetchedAt) still held 15:55. The fix
// threads the server-reported data.fetchedAt through, matching applyCachedQuotaState.

const indexPath = path.join(
  process.cwd(),
  "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.tsx"
);
const source = readFileSync(indexPath, "utf8");

test("fetchQuota derives lastRefreshedAt from server data.fetchedAt, not client now()", () => {
  const marker = "[connectionId]: data.fetchedAt || new Date().toISOString(),";
  assert.ok(
    source.includes(marker),
    "fetchQuota must set lastRefreshedAt from data.fetchedAt (with a now() fallback), " +
      "so a rate-limited refresh does not show a timestamp the DB/reload cannot reproduce"
  );
});

test("fetchQuota does not unconditionally stamp client wall-clock time", () => {
  // The buggy form set the timestamp straight to new Date() inside the setLastRefreshedAt
  // updater with no server value. Assert that exact bad shape is gone.
  const buggy = /\[connectionId\]:\s*new Date\(\)\.toISOString\(\),\s*\}\)\);/;
  const setLastRefreshedBlocks = source.split("setLastRefreshedAt");
  const fetchQuotaBlock = setLastRefreshedBlocks.find((chunk) => chunk.includes("data.fetchedAt"));
  assert.ok(fetchQuotaBlock, "expected a setLastRefreshedAt call that reads data.fetchedAt");
  // The reload path (applyCachedQuotaState) legitimately has no now() fallback; the
  // refresh path must always prefer the server value before falling back.
  assert.ok(
    !buggy.test(fetchQuotaBlock.slice(0, 120)),
    "fetchQuota must not stamp bare new Date() as the refresh timestamp"
  );
});
