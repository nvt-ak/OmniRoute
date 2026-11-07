import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The suite's DATA_DIR may be shared; create a private child before any app import.
const dataDir = process.env.DATA_DIR;
assert.ok(dataDir && path.isAbsolute(dataDir), "explicit absolute DATA_DIR is required");
const realTmp = fs.realpathSync(os.tmpdir());
const suiteDataDir = fs.realpathSync(dataDir);
assert.ok(
  suiteDataDir.startsWith(`${realTmp}${path.sep}`),
  `DATA_DIR must live under the OS temp dir, got ${suiteDataDir}`
);
const realDataDir = fs.realpathSync(fs.mkdtempSync(path.join(suiteDataDir, "cache-rate-")));
assert.deepEqual(fs.readdirSync(realDataDir), [], "DATA_DIR must be fresh and empty");
process.env.DATA_DIR = realDataDir;

const { getCacheMetrics } = await import("../../src/lib/db/settings/cacheMetrics.ts");
const core = await import("../../src/lib/db/core.ts");
assert.ok(core.SQLITE_FILE, "SQLITE_FILE must be set");
assert.equal(
  fs.realpathSync(path.dirname(core.SQLITE_FILE)),
  realDataDir,
  "DB must be inside the temp DATA_DIR"
);
const db = core.getDbInstance();

const insert = db.prepare(
  "INSERT INTO usage_history (provider, tokens_input, tokens_cache_read, tokens_cache_creation, timestamp) VALUES (?, ?, ?, ?, ?)"
);
const ts = new Date().toISOString();

test("empty table: cacheRate is 0/0 and exclusion does not throw", async () => {
  const m = await getCacheMetrics(["deepseek-web"]);
  assert.deepEqual(m.cacheRate, { totalRequests: 0, requestsWithCacheControl: 0 });
});

test("deepseek-web with positive cache is removed from cacheRate only", async () => {
  insert.run("deepseek-web", 100, 50, 0, ts);
  insert.run("deepseek-web", 100, 0, 0, ts);
  const raw = await getCacheMetrics();
  const filtered = await getCacheMetrics(["deepseek-web"]);
  assert.deepEqual(filtered.cacheRate, { totalRequests: 0, requestsWithCacheControl: 0 });
  assert.equal(raw.totalRequests, 2);
  assert.equal(raw.requestsWithCacheControl, 1);
});

test("NULL provider rows (cached and uncached) are included in cacheRate", async () => {
  db.prepare("DELETE FROM usage_history").run();
  insert.run(null, 300, 20, 0, ts);
  insert.run(null, 300, 0, 0, ts);
  insert.run("deepseek-web", 100, 50, 0, ts);
  insert.run("claude", 200, 80, 0, ts);
  const filtered = await getCacheMetrics(["deepseek-web"]);
  assert.deepEqual(filtered.cacheRate, { totalRequests: 3, requestsWithCacheControl: 2 });
});

test("original top-level fields are unchanged by the display-only exclusion", async () => {
  const raw = await getCacheMetrics();
  const filtered = await getCacheMetrics(["deepseek-web"]);
  const { cacheRate: _r1, lastUpdated: _t1, ...rawRest } = raw;
  const { cacheRate: _r2, lastUpdated: _t2, ...filteredRest } = filtered;
  assert.deepEqual(filteredRest, rawRest);
});
