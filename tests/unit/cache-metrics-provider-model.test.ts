import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-cache-model-"));

const { getDbInstance, resetDbInstance } = await import("../../src/lib/db/core.ts");
const { getCacheMetrics } = await import("../../src/lib/db/settings/cacheMetrics.ts");

test.after(() => resetDbInstance());

interface UsageRow {
  provider: string;
  model: string | null;
  tokensInput: number;
  tokensCacheRead: number;
  tokensCacheCreation: number;
  comboStrategy?: string | null;
}

function seed(rows: UsageRow[]) {
  const db = getDbInstance();
  // Migrations create usage_history on a fresh DATA_DIR; the IF NOT EXISTS keeps
  // this test honest if the table is missing (same pattern as cache-metrics.test.ts).
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT,
      model TEXT,
      connection_id TEXT,
      api_key_id TEXT,
      api_key_name TEXT,
      tokens_input INTEGER DEFAULT 0,
      tokens_output INTEGER DEFAULT 0,
      tokens_cache_read INTEGER DEFAULT 0,
      tokens_cache_creation INTEGER DEFAULT 0,
      tokens_reasoning INTEGER DEFAULT 0,
      status TEXT,
      success INTEGER,
      latency_ms INTEGER,
      ttft_ms INTEGER,
      error_code TEXT,
      combo_strategy TEXT,
      timestamp TEXT
    );
  `);
  db.prepare("DELETE FROM usage_history").run();
  const insert = db.prepare(
    `
    INSERT INTO usage_history (provider, model, tokens_input, tokens_output,
      tokens_cache_read, tokens_cache_creation, combo_strategy, status, success, timestamp)
    VALUES (?, ?, ?, 0, ?, ?, ?, '200', 1, ?)
  `
  );
  const now = new Date().toISOString();
  for (const row of rows) {
    insert.run(
      row.provider,
      row.model,
      row.tokensInput,
      row.tokensCacheRead,
      row.tokensCacheCreation,
      row.comboStrategy ?? null,
      now
    );
  }
}

test("getCacheMetrics splits a provider into per-model rows", async () => {
  seed([
    // Claude: writes a prefix on the first turn, then reads it back.
    {
      provider: "router-node",
      model: "claude-opus",
      tokensInput: 1000,
      tokensCacheRead: 800,
      tokensCacheCreation: 200,
    },
    {
      provider: "router-node",
      model: "claude-opus",
      tokensInput: 500,
      tokensCacheRead: 400,
      tokensCacheCreation: 0,
    },
    // OpenAI-style implicit cache: reads only, no write counter.
    {
      provider: "router-node",
      model: "gpt-sol",
      tokensInput: 600,
      tokensCacheRead: 640,
      tokensCacheCreation: 0,
    },
    {
      provider: "router-node",
      model: "gpt-sol",
      tokensInput: 600,
      tokensCacheRead: 640,
      tokensCacheCreation: 0,
    },
    // Cold call: no cache activity at all — counted in totalRequests, not in inputTokens.
    {
      provider: "router-node",
      model: "gpt-sol",
      tokensInput: 300,
      tokensCacheRead: 0,
      tokensCacheCreation: 0,
    },
  ]);

  const metrics = await getCacheMetrics();
  const perModel = metrics.byProviderModel["router-node"];

  assert.ok(perModel, "router-node should expose a per-model breakdown");
  assert.deepEqual(Object.keys(perModel).sort(), ["claude-opus", "gpt-sol"]);

  // Blending these two is exactly the bug: 88% and 53% average out to a number
  // that describes neither model.
  const opus = perModel["claude-opus"];
  assert.equal(opus.totalRequests, 2);
  assert.equal(opus.cachedRequests, 2);
  assert.equal(opus.inputTokens, 1500, "only cache-active rows contribute inputTokens");
  assert.equal(opus.cachedTokens, 1200);
  assert.equal(opus.cacheCreationTokens, 200);
  assert.equal(opus.cacheCreationReported, true);

  const sol = perModel["gpt-sol"];
  assert.equal(sol.totalRequests, 3, "cold calls still count as requests");
  assert.equal(sol.cachedRequests, 2);
  assert.equal(sol.inputTokens, 1200, "the cold call's tokens must not inflate the ratio");
  assert.equal(sol.cachedTokens, 1280);
  assert.equal(sol.cacheCreationTokens, 0);
  assert.equal(
    sol.cacheCreationReported,
    false,
    "reads without a single write means the backend has no write counter — render N/A, not 0"
  );

  // Provider row: a mixed pool reports writes (opus did), so the provider total
  // keeps a real number while the write-silent model shows N/A.
  const provider = metrics.byProvider["router-node"];
  assert.equal(provider.totalRequests, 5);
  assert.equal(provider.cachedRequests, 4);
  assert.equal(provider.inputTokens, 2700);
  assert.equal(provider.cachedTokens, 2480);
  assert.equal(provider.cacheCreationTokens, 200);
  assert.equal(provider.cacheCreationReported, true);
});

test("a provider whose every model is write-silent reports no write counter", async () => {
  seed([
    {
      provider: "implicit-only",
      model: "gemini-flash",
      tokensInput: 900,
      tokensCacheRead: 700,
      tokensCacheCreation: 0,
    },
    {
      provider: "implicit-only",
      model: "gemini-flash",
      tokensInput: 100,
      tokensCacheRead: 0,
      tokensCacheCreation: 0,
    },
    // Rows without a model must not disappear from the breakdown.
    {
      provider: "implicit-only",
      model: null,
      tokensInput: 100,
      tokensCacheRead: 60,
      tokensCacheCreation: 0,
    },
  ]);

  const metrics = await getCacheMetrics();
  const provider = metrics.byProvider["implicit-only"];

  assert.equal(provider.cachedRequests, 2);
  assert.equal(provider.cacheCreationTokens, 0);
  assert.equal(provider.cacheCreationReported, false);

  const perModel = metrics.byProviderModel["implicit-only"];
  assert.equal(perModel["gemini-flash"].cacheCreationReported, false);
  assert.equal(
    perModel[""].cachedTokens,
    60,
    "a NULL model is keyed as an empty string rather than dropped"
  );
});

test("a provider with no cache activity gets no breakdown row at all", async () => {
  // Nothing to judge from: the HAVING clause drops it, so the table never has to
  // decide between "0" and "N/A" for a provider that has not cached anything.
  seed([
    {
      provider: "cold-provider",
      model: "never-cached",
      tokensInput: 400,
      tokensCacheRead: 0,
      tokensCacheCreation: 0,
    },
  ]);

  const metrics = await getCacheMetrics();

  assert.equal(metrics.byProvider["cold-provider"], undefined, "no cache activity, no row");
  assert.equal(metrics.byProviderModel["cold-provider"], undefined);
});

test("providers below the cache-activity threshold are excluded from the breakdown", async () => {
  seed([
    {
      provider: "writes-only",
      model: "claude-sonnet",
      tokensInput: 500,
      tokensCacheRead: 0,
      tokensCacheCreation: 500,
    },
  ]);

  const metrics = await getCacheMetrics();
  const row = metrics.byProvider["writes-only"];

  assert.ok(row, "a write-only provider is still cache activity");
  assert.equal(row.cachedRequests, 1);
  assert.equal(row.inputTokens, 500);
  assert.equal(row.cacheCreationReported, true);
  assert.equal(metrics.byProviderModel["writes-only"]["claude-sonnet"].cacheCreationReported, true);
});
