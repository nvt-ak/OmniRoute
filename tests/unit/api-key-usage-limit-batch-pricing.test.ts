import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-usage-limit-batch-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "usage-limit-batch-test-secret";

// DB modules intentionally load after DATA_DIR is set so every test uses isolated storage.
const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const usageLimits = await import("../../src/lib/usage/apiKeyUsageLimits.ts");
const pricingDb = await import("../../src/lib/db/settings/pricing.ts");

const NOW = Date.parse("2026-06-19T20:00:00.000Z");

test.beforeEach(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  usageHistory.clearPendingRequests();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function makeMeteredKey() {
  const created = await apiKeysDb.createApiKey("Batch Pricing Key", "machine-batch-01");
  await apiKeysDb.updateApiKeyPermissions(created.id, {
    usageLimitEnabled: true,
    dailyUsageLimitUsd: 1_000,
    weeklyUsageLimitUsd: 5_000,
  });
  apiKeysDb.clearApiKeyCaches();
  const metadata = await apiKeysDb.getApiKeyMetadata(created.key);
  assert.ok(metadata);
  return { created, metadata: { ...metadata!, allowedConnections: null } };
}

async function saveUsage(apiKeyId: string, provider: string, model: string, input: number) {
  await usageHistory.saveRequestUsage({
    provider,
    model,
    apiKeyId,
    apiKeyName: "Batch Pricing Key",
    tokens: { input, output: 0 },
    success: true,
    timestamp: "2026-06-19T12:00:00.000Z",
  });
}

test("spend over many distinct-size usage groups prices every group, priced and unpriced alike", async () => {
  await pricingDb.updatePricing({
    openai: { "gpt-4o": { input: 1, cached: 1, output: 1, reasoning: 1, cache_creation: 1 } },
    anthropic: {
      "claude-sonnet-5": { input: 2, cached: 2, output: 2, reasoning: 2, cache_creation: 2 },
    },
  });
  const { created, metadata } = await makeMeteredKey();

  // Every row has a distinct prompt size, so each one is its own pricing group —
  // the shape that made per-group pricing lookups block the event loop.
  let expectedUsd = 0;
  for (let i = 1; i <= 40; i++) {
    await saveUsage(created.id, "openai", "gpt-4o", i * 1_000);
    await saveUsage(created.id, "anthropic", "claude-sonnet-5", i * 1_000 + 1);
    expectedUsd += (i * 1_000 * 1 + (i * 1_000 + 1) * 2) / 1_000_000;
  }

  const priced = await usageLimits.getApiKeyUsageLimitStatus(metadata, { now: () => NOW });
  assert.equal(priced.dailySpentUsd, Math.round(expectedUsd * 1_000_000) / 1_000_000);
  assert.equal(priced.dailyHasUnpricedUsage, false);

  await saveUsage(created.id, "cursor", "auto", 5_000);
  const withUnpriced = await usageLimits.getApiKeyUsageLimitStatus(metadata, { now: () => NOW });
  assert.equal(withUnpriced.dailySpentUsd, priced.dailySpentUsd, "unpriced usage adds $0");
  assert.equal(withUnpriced.dailyHasUnpricedUsage, true, "and still fails the window closed");
  assert.equal(withUnpriced.dailyExceeded, true);
});

test("a counted request keeps its price after a pricing edit; later requests use the new price", async () => {
  await pricingDb.updatePricing({
    openai: { "gpt-4o": { input: 1, cached: 1, output: 1, reasoning: 1, cache_creation: 1 } },
  });
  const { created, metadata } = await makeMeteredKey();
  await saveUsage(created.id, "openai", "gpt-4o", 1_000_000);

  const before = await usageLimits.getApiKeyUsageLimitStatus(metadata, { now: () => NOW });
  assert.equal(before.dailySpentUsd, 1);

  await pricingDb.updatePricing({
    openai: { "gpt-4o": { input: 3, cached: 3, output: 3, reasoning: 3, cache_creation: 3 } },
  });
  const afterEdit = await usageLimits.getApiKeyUsageLimitStatus(metadata, { now: () => NOW });
  assert.equal(afterEdit.dailySpentUsd, 1, "already-counted spend is not re-priced");

  await saveUsage(created.id, "openai", "gpt-4o", 2_000_000);
  const withNew = await usageLimits.getApiKeyUsageLimitStatus(metadata, { now: () => NOW });
  assert.equal(withNew.dailySpentUsd, 7);
  assert.equal(withNew.weeklySpentUsd, 7);
});

test("adding the missing price reopens a window that failed closed on unpriced usage", async () => {
  await pricingDb.updatePricing({
    openai: { "gpt-4o": { input: 1, cached: 1, output: 1, reasoning: 1, cache_creation: 1 } },
  });
  const { created, metadata } = await makeMeteredKey();
  await saveUsage(created.id, "openai", "gpt-4o", 1_000_000);
  await saveUsage(created.id, "cursor", "auto", 2_000_000);

  const closed = await usageLimits.getApiKeyUsageLimitStatus(metadata, { now: () => NOW });
  assert.equal(closed.dailyHasUnpricedUsage, true);
  assert.equal(closed.dailyExceeded, true);
  assert.equal(closed.dailySpentUsd, 1);

  await pricingDb.updatePricing({
    cursor: { auto: { input: 2, cached: 2, output: 2, reasoning: 2, cache_creation: 2 } },
  });
  const reopened = await usageLimits.getApiKeyUsageLimitStatus(metadata, { now: () => NOW });
  assert.equal(reopened.dailyHasUnpricedUsage, false);
  assert.equal(reopened.weeklyHasUnpricedUsage, false);
  assert.equal(reopened.dailyExceeded, false);
  assert.equal(reopened.dailySpentUsd, 5);
});

test("each request is billed at its own long-context tier when one model spans both sides", async () => {
  await pricingDb.updatePricing({
    openai: {
      "gpt-4o": {
        input: 1,
        cached: 1,
        output: 1,
        reasoning: 1,
        cache_creation: 1,
        long_context: { threshold: 200_000, input: 10 },
      },
    },
  });
  const { created, metadata } = await makeMeteredKey();
  await saveUsage(created.id, "openai", "gpt-4o", 100_000);
  await saveUsage(created.id, "openai", "gpt-4o", 300_000);
  await saveUsage(created.id, "openai", "gpt-4o", 150_000);

  const status = await usageLimits.getApiKeyUsageLimitStatus(metadata, { now: () => NOW });
  // 250k tokens below the tier at $1/M, 300k above it at $10/M.
  assert.equal(status.dailySpentUsd, 3.25);
});
