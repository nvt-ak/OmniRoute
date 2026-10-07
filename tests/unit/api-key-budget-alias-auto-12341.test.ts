import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-api-key-budget-alias-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "budget-alias-test-secret";

// DB modules intentionally load after DATA_DIR is set so every test uses isolated storage.
const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const usageLimits = await import("../../src/lib/usage/apiKeyUsageLimits.ts");
const nodesDb = await import("../../src/lib/db/providers/nodes.ts");
const pricingDb = await import("../../src/lib/db/settings/pricing.ts");
const costCalculator = await import("../../src/lib/usage/costCalculator.ts");

const NOW = Date.parse("2026-06-19T20:00:00.000Z");

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  usageHistory.clearPendingRequests();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function makeMeteredKey() {
  const created = await apiKeysDb.createApiKey("Budget Alias Key", "machine-budget-01");
  await apiKeysDb.updateApiKeyPermissions(created.id, {
    usageLimitEnabled: true,
    dailyUsageLimitUsd: 10,
    weeklyUsageLimitUsd: 50,
  });
  apiKeysDb.clearApiKeyCaches();
  const metadata = await apiKeysDb.getApiKeyMetadata(created.key);
  assert.ok(metadata);
  return { created, metadata: metadata! };
}

test("BUG #12341: a real, billable completion routed through cursor/auto (unpriced) must not silently pass the daily budget cap as $0", async () => {
  const { created, metadata } = await makeMeteredKey();

  // Cursor's own default routing alias ("Auto (current, default)") has no
  // pricing row anywhere — this is real, mainstream billable traffic, not an
  // edge case.
  await usageHistory.saveRequestUsage({
    provider: "cursor",
    model: "auto",
    apiKeyId: created.id,
    apiKeyName: "Budget Alias Key",
    tokens: { input: 1_000_000, output: 1_000_000 },
    success: true,
    timestamp: "2026-06-19T12:00:00.000Z",
  });

  const status = await usageLimits.getApiKeyUsageLimitStatus(
    { ...metadata, allowedConnections: null },
    { now: () => NOW }
  );

  // Fail closed (#12341): unpriced usage in a window with a configured limit
  // must flip the window to exceeded, even though the naive USD total is $0.
  assert.equal(status.dailySpentUsd, 0, "cost stays $0 — no pricing row exists for cursor/auto");
  assert.equal(
    status.dailyHasUnpricedUsage,
    true,
    "status must flag that unpriced usage was seen in the daily window"
  );
  assert.equal(
    status.dailyExceeded,
    true,
    "enforcement must fail closed instead of silently allowing unlimited unpriced usage"
  );
});

test("control: a priced model routed at the same tokens does NOT trip fail-closed enforcement", async () => {
  const { updatePricing } = await import("@/lib/db/settings");
  await updatePricing({
    openai: {
      "gpt-4o": { input: 1, cached: 1, output: 1, reasoning: 1, cache_creation: 1 },
    },
  });

  const { created, metadata } = await makeMeteredKey();

  await usageHistory.saveRequestUsage({
    provider: "openai",
    model: "gpt-4o",
    apiKeyId: created.id,
    apiKeyName: "Budget Alias Key",
    tokens: { input: 1_000_000, output: 0 },
    success: true,
    timestamp: "2026-06-19T12:00:00.000Z",
  });

  const status = await usageLimits.getApiKeyUsageLimitStatus(
    { ...metadata, allowedConnections: null },
    { now: () => NOW }
  );

  assert.equal(status.dailySpentUsd, 1);
  assert.equal(status.dailyHasUnpricedUsage, false);
  assert.equal(status.dailyExceeded, false);
});

test("USAGE_LIMIT_IGNORE_UNPRICED=true: unpriced usage counts as $0 instead of failing the quota closed", async () => {
  const previous = process.env.USAGE_LIMIT_IGNORE_UNPRICED;
  process.env.USAGE_LIMIT_IGNORE_UNPRICED = "true";
  try {
    const { created, metadata } = await makeMeteredKey();

    await usageHistory.saveRequestUsage({
      provider: "cursor",
      model: "auto",
      apiKeyId: created.id,
      apiKeyName: "Budget Alias Key",
      tokens: { input: 1_000_000, output: 1_000_000 },
      success: true,
      timestamp: "2026-06-19T12:00:00.000Z",
    });

    const status = await usageLimits.getApiKeyUsageLimitStatus(
      { ...metadata, allowedConnections: null },
      { now: () => NOW }
    );

    assert.equal(status.dailySpentUsd, 0);
    assert.equal(status.dailyHasUnpricedUsage, true, "the unpriced usage is still reported");
    assert.equal(status.dailyExceeded, false, "an operator opt-in skips the fail-closed rule");
    assert.equal(status.weeklyExceeded, false);
  } finally {
    if (previous === undefined) delete process.env.USAGE_LIMIT_IGNORE_UNPRICED;
    else process.env.USAGE_LIMIT_IGNORE_UNPRICED = previous;
  }
});

test("USAGE_LIMIT_IGNORE_UNPRICED=true still enforces priced spend over the limit", async () => {
  const previous = process.env.USAGE_LIMIT_IGNORE_UNPRICED;
  process.env.USAGE_LIMIT_IGNORE_UNPRICED = "true";
  try {
    const { updatePricing } = await import("@/lib/db/settings");
    await updatePricing({
      openai: {
        "gpt-4o": { input: 20, cached: 20, output: 20, reasoning: 20, cache_creation: 20 },
      },
    });
    const { created, metadata } = await makeMeteredKey();

    await usageHistory.saveRequestUsage({
      provider: "openai",
      model: "gpt-4o",
      apiKeyId: created.id,
      apiKeyName: "Budget Alias Key",
      tokens: { input: 1_000_000, output: 0 },
      success: true,
      timestamp: "2026-06-19T12:00:00.000Z",
    });

    const status = await usageLimits.getApiKeyUsageLimitStatus(
      { ...metadata, allowedConnections: null },
      { now: () => NOW }
    );

    assert.equal(status.dailySpentUsd, 20);
    assert.equal(status.dailyExceeded, true, "$20 spent against a $10 daily limit");
  } finally {
    if (previous === undefined) delete process.env.USAGE_LIMIT_IGNORE_UNPRICED;
    else process.env.USAGE_LIMIT_IGNORE_UNPRICED = previous;
  }
});

test("official Anthropic-compatible nodes inherit API model pricing, including normalized model paths", async () => {
  const node = await nodesDb.createProviderNode({
    id: "anthropic-compatible-priced-test",
    type: "anthropic-compatible",
    name: "Official Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
  });
  assert.ok(typeof node.id === "string");
  const expectedPricing = await pricingDb.getPricingForModel("anthropic", "claude-sonnet-5");
  assert.ok(expectedPricing);
  assert.deepEqual(await pricingDb.getPricingForModel(node.id, "CLAUDE-SONNET-5"), expectedPricing);
  const tokens = { input: 1_000_000, output: 100_000, cacheRead: 200_000 };
  const expectedCost = costCalculator.computeCostFromPricing(expectedPricing, tokens);
  const result = await costCalculator.calculateCostDetailed(
    node.id,
    "official/claude-sonnet-5",
    tokens
  );
  assert.deepEqual(result, { costUsd: expectedCost, priced: true });

  const { created, metadata } = await makeMeteredKey();
  await usageHistory.saveRequestUsage({
    provider: node.id,
    model: "official/claude-sonnet-5",
    apiKeyId: created.id,
    tokens,
    success: true,
    timestamp: "2026-06-19T12:00:00.000Z",
  });
  const status = await usageLimits.getApiKeyUsageLimitStatus(metadata, { now: () => NOW });
  assert.equal(status.dailySpentUsd, Math.round(expectedCost * 1_000_000) / 1_000_000);
  assert.equal(status.dailyHasUnpricedUsage, false);
  assert.equal(status.weeklyHasUnpricedUsage, false);
  assert.equal(status.dailyExceeded, false);
});

test("canonical API overrides apply to official nodes but exact node overrides and explicit free models win", async () => {
  const node = await nodesDb.createProviderNode({
    id: "anthropic-compatible-override-test",
    type: "anthropic-compatible",
    name: "Official Anthropic",
    baseUrl: "https://api.anthropic.com",
  });
  assert.ok(typeof node.id === "string");
  await pricingDb.updatePricing({
    anthropic: { "claude-sonnet-5": { input: 12, output: 25 } },
  });
  assert.equal((await pricingDb.getPricingForModel(node.id, "claude-sonnet-5"))?.input, 12);
  await pricingDb.updatePricing({
    [node.id]: { "claude-sonnet-5": { input: 2, output: 4 } },
  });
  assert.equal((await pricingDb.getPricingForModel(node.id, "claude-sonnet-5"))?.input, 2);
  // A provider-specific override for one model must not hide canonical prices for another.
  assert.deepEqual(
    await pricingDb.getPricingForModel(node.id, "claude-opus-4-8"),
    await pricingDb.getPricingForModel("anthropic", "claude-opus-4-8")
  );
  await pricingDb.updatePricing({
    [node.id]: { "claude-sonnet-5": { input: 0, output: 0, cached: 0, reasoning: 0 } },
  });
  assert.deepEqual(
    await costCalculator.calculateCostDetailed(node.id, "claude-sonnet-5", {
      input: 1_000_000,
      output: 1_000_000,
    }),
    { costUsd: 0, priced: true }
  );
});

test("configured compatible nodes use canonical model estimates independently of proxy host identity", async () => {
  const urls = [
    "https://api.anthropic.com.evil.example/v1",
    "https://proxy.example/v1",
    "http://api.anthropic.com/v1",
    "https://api.anthropic.com:8443/v1",
    "https://api.anthropic.com/proxy",
    "https://user:pass@api.anthropic.com/v1",
    "https://api.anthropic.com/v1?target=proxy",
    "https://api.anthropic.com/v1#proxy",
    "not-a-url",
  ];
  const expected = await costCalculator.calculateCostDetailed("anthropic", "claude-sonnet-5", {
    input: 1_000_000,
  });
  for (const [index, baseUrl] of urls.entries()) {
    const node = await nodesDb.createProviderNode({
      id: `anthropic-compatible-untrusted-${index}`,
      type: "anthropic-compatible",
      name: "Untrusted pricing target",
      baseUrl,
    });
    assert.ok(typeof node.id === "string");
    const result = await costCalculator.calculateCostDetailed(node.id, "claude-sonnet-5", {
      input: 1_000_000,
    });
    assert.deepEqual(result, expected, baseUrl);
  }
  const wrongProtocolNode = await nodesDb.createProviderNode({
    id: "openai-compatible-official-host",
    type: "openai-compatible",
    name: "Different protocol",
    baseUrl: "https://api.anthropic.com/v1",
  });
  assert.ok(typeof wrongProtocolNode.id === "string");
  assert.ok(await pricingDb.getPricingForModel(wrongProtocolNode.id, "claude-sonnet-5"));
  assert.equal(
    await pricingDb.getPricingForModel("anthropic-compatible-missing-node", "claude-sonnet-5"),
    null
  );
});

test("compatible-node estimates survive a host change but stop immediately after node deletion", async () => {
  const node = await nodesDb.createProviderNode({
    id: "anthropic-compatible-changing-host",
    type: "anthropic-compatible",
    name: "Changing target",
    baseUrl: "https://api.anthropic.com/v1/",
  });
  assert.ok(typeof node.id === "string");
  assert.ok(await pricingDb.getPricingForModel(node.id, "claude-sonnet-5"));
  await nodesDb.updateProviderNode(node.id, { baseUrl: "https://proxy.example/v1" });
  assert.ok(await pricingDb.getPricingForModel(node.id, "claude-sonnet-5"));
  await nodesDb.updateProviderNode(node.id, { baseUrl: "https://api.anthropic.com/" });
  assert.ok(await pricingDb.getPricingForModel(node.id, "claude-sonnet-5"));
  await nodesDb.deleteProviderNode(node.id);
  assert.equal(await pricingDb.getPricingForModel(node.id, "claude-sonnet-5"), null);
});

test("one tiny unknown native Anthropic model blocks both quota windows with a truthful actionable error until priced", async () => {
  // OAuth/subscription pricing is not Anthropic API-credit pricing.
  await pricingDb.updatePricing({
    cc: { "claude-unknown-model": { input: 0, output: 0 } },
  });
  assert.ok(await pricingDb.getPricingForModel("claude", "claude-unknown-model"));
  assert.equal(await pricingDb.getPricingForModel("anthropic", "claude-unknown-model"), null);
  assert.equal(
    await pricingDb.getPricingForModel("missing-provider-node", "claude-unknown-model"),
    null
  );
  const { created, metadata } = await makeMeteredKey();
  await usageHistory.saveRequestUsage({
    provider: "anthropic",
    model: "claude-unknown-model",
    apiKeyId: created.id,
    tokens: { input: 11, output: 1 },
    success: true,
    timestamp: "2026-06-19T12:00:00.000Z",
  });
  const status = await usageLimits.getApiKeyUsageLimitStatus(metadata, { now: () => NOW });
  assert.equal(status.dailySpentUsd, 0);
  assert.equal(status.weeklySpentUsd, 0);
  assert.equal(status.dailyExceeded, true);
  assert.equal(status.weeklyExceeded, true);
  assert.equal(status.dailyHasUnpricedUsage, true);
  assert.equal(status.weeklyHasUnpricedUsage, true);
  for (const [endpoint, expectedStatus] of [
    ["/v1/chat/completions", 429],
    ["/v1/messages", 400],
  ] as const) {
    const response = usageLimits.buildApiKeyUsageLimitRejection(
      new Request(`http://localhost${endpoint}`),
      status,
      NOW,
      { showUsd: false }
    );
    assert.equal(response.status, expectedStatus);
    const body = await response.json();
    assert.equal(body.error.reason, "missing_pricing");
    assert.match(body.error.message, /pricing is missing.*daily and weekly/);
    assert.match(body.error.message, /administrator to configure pricing/);
    assert.doesNotMatch(body.error.message, /reached.*quota|Resets in|\$|0%/);
    assert.equal(body.error.reset_at, undefined);
    assert.equal(body.error.retry_after, undefined);
    assert.equal(response.headers.get("Retry-After"), null);
  }
  await pricingDb.updatePricing({
    anthropic: { "claude-unknown-model": { input: 1, output: 5 } },
  });
  const corrected = await usageLimits.getApiKeyUsageLimitStatus(metadata, { now: () => NOW });
  assert.equal(corrected.dailySpentUsd, 0.000016);
  assert.equal(corrected.dailyExceeded, false);
  assert.equal(corrected.weeklyExceeded, false);
  assert.equal(corrected.dailyHasUnpricedUsage, false);
});

test("unpriced prior-day usage blocks only the enforced weekly window and cannot claim a daily reset fixes it", async () => {
  const { created, metadata } = await makeMeteredKey();
  await usageHistory.saveRequestUsage({
    provider: "cursor",
    model: "auto",
    apiKeyId: created.id,
    tokens: { input: 11, output: 1 },
    success: true,
    timestamp: "2026-06-18T12:00:00.000Z",
  });
  const status = await usageLimits.getApiKeyUsageLimitStatus(metadata, { now: () => NOW });
  assert.equal(status.dailyHasUnpricedUsage, false);
  assert.equal(status.dailyExceeded, false);
  assert.equal(status.weeklyHasUnpricedUsage, true);
  assert.equal(status.weeklyExceeded, true);
  const response = usageLimits.buildApiKeyUsageLimitRejection(
    new Request("http://localhost/v1/chat/completions"),
    status,
    NOW
  );
  const body = await response.json();
  assert.match(body.error.message, /pricing is missing.*weekly quota window/);
  assert.equal(body.error.reason, "missing_pricing");
  assert.equal(body.error.reset_at, undefined);

  const noWeeklyLimit = await usageLimits.getApiKeyUsageLimitStatus(
    { ...metadata, weeklyUsageLimitUsd: null },
    { now: () => NOW }
  );
  assert.equal(noWeeklyLimit.dailyExceeded, false);
  assert.equal(noWeeklyLimit.weeklyExceeded, false);
  const disabled = await usageLimits.getApiKeyUsageLimitStatus(
    { ...metadata, usageLimitEnabled: false },
    { now: () => NOW }
  );
  assert.equal(disabled.dailyExceeded, false);
  assert.equal(disabled.weeklyExceeded, false);
});

test("failed or expired unknown usage cannot poison an enforced window", async () => {
  const { created, metadata } = await makeMeteredKey();
  for (const [timestamp, success] of [
    ["2026-06-19T12:00:00.000Z", false],
    ["2026-06-12T19:59:59.999Z", true],
  ] as const) {
    await usageHistory.saveRequestUsage({
      provider: "cursor",
      model: "auto",
      apiKeyId: created.id,
      tokens: { input: 11, output: 1 },
      success,
      timestamp,
    });
  }
  const status = await usageLimits.getApiKeyUsageLimitStatus(metadata, { now: () => NOW });
  assert.equal(status.dailyHasUnpricedUsage, false);
  assert.equal(status.weeklyHasUnpricedUsage, false);
  assert.equal(status.dailyExceeded, false);
  assert.equal(status.weeklyExceeded, false);
});

test("an explicit proxy-node price wins before canonical model estimates", async () => {
  const node = await nodesDb.createProviderNode({
    id: "anthropic-compatible-explicit-proxy-price",
    type: "anthropic-compatible",
    name: "Custom proxy",
    baseUrl: "https://proxy.example/v1",
  });
  assert.ok(typeof node.id === "string");
  await pricingDb.updatePricing({
    [node.id]: { "claude-sonnet-5": { input: 7, output: 21 } },
  });
  assert.deepEqual(
    await costCalculator.calculateCostDetailed(node.id, "claude-sonnet-5", { input: 1_000_000 }),
    { costUsd: 7, priced: true }
  );
  assert.deepEqual(
    await pricingDb.getPricingForModel(node.id, "claude-opus-4-8"),
    await pricingDb.getPricingForModel("anthropic", "claude-opus-4-8")
  );
});

test("known spend exactly at the daily limit still reports a real quota exhaustion, not missing pricing", async () => {
  const { created, metadata } = await makeMeteredKey();
  await pricingDb.updatePricing({
    openai: { "gpt-4o": { input: 10, output: 30 } },
  });
  await usageHistory.saveRequestUsage({
    provider: "openai",
    model: "gpt-4o",
    apiKeyId: created.id,
    tokens: { input: 1_000_000, output: 0 },
    success: true,
    timestamp: "2026-06-19T12:00:00.000Z",
  });
  const status = await usageLimits.getApiKeyUsageLimitStatus(metadata, { now: () => NOW });
  assert.equal(status.dailySpentUsd, 10);
  assert.equal(status.dailyExceeded, true);
  assert.equal(status.weeklyExceeded, false);
  assert.equal(status.dailyHasUnpricedUsage, false);
  const response = usageLimits.buildApiKeyUsageLimitRejection(
    new Request("http://localhost/v1/chat/completions"),
    status,
    NOW,
    { showUsd: false }
  );
  const body = await response.json();
  assert.equal(response.status, 429);
  assert.equal(body.error.code, "usage_limit_exceeded");
  assert.equal(body.error.reason, undefined);
  assert.match(body.error.message, /reached its daily usage quota \(100%\)/);
  assert.match(body.error.message, /Resets in 7h 0m/);
});

test("the observed 11-input/1-output Haiku 5.5 request has authoritative API cost and no quota blockade", async () => {
  const node = await nodesDb.createProviderNode({
    id: "anthropic-compatible-observed-haiku",
    type: "anthropic-compatible",
    name: "Official Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
  });
  assert.ok(typeof node.id === "string");
  const tokens = { input: 11, output: 1 };
  const expectedCost = (11 * 0.1 + 0.5) / 1_000_000;
  for (const provider of ["anthropic", node.id]) {
    const cost = await costCalculator.calculateCostDetailed(provider, "claude-haiku-5-5", tokens);
    assert.equal(cost.priced, true);
    assert.ok(Math.abs(cost.costUsd - expectedCost) < 1e-12);
  }
  const { created, metadata } = await makeMeteredKey();
  await usageHistory.saveRequestUsage({
    provider: node.id,
    model: "claude-haiku-5-5",
    apiKeyId: created.id,
    tokens,
    success: true,
    timestamp: "2026-06-19T12:00:00.000Z",
  });
  const status = await usageLimits.getApiKeyUsageLimitStatus(metadata, { now: () => NOW });
  assert.equal(status.dailySpentUsd, 0.000002);
  assert.equal(status.dailyHasUnpricedUsage, false);
  assert.equal(status.weeklyHasUnpricedUsage, false);
  assert.equal(status.dailyExceeded, false);
  assert.equal(status.weeklyExceeded, false);
});

test("Haiku 5.5 selects the exact 100000-token prompt tier including cache reads and writes", async () => {
  for (const [input, inputPrice, outputPrice, cacheReadPrice, cacheWritePrice] of [
    [99_999, 0.1, 0.5, 0.01, 0.125],
    [100_000, 0.1, 0.5, 0.01, 0.125],
    [100_001, 0.5, 2.5, 0.05, 0.625],
  ] as const) {
    // Inclusive input is mostly cached; uncached tokens alone would choose the wrong tier.
    const cacheRead = 90_000;
    const cacheCreation = 9_999;
    const output = 1_000;
    const expectedCost =
      ((input - cacheRead - cacheCreation) * inputPrice +
        cacheRead * cacheReadPrice +
        cacheCreation * cacheWritePrice +
        output * outputPrice) /
      1_000_000;
    for (const tokens of [
      { input, output, cacheRead, cacheCreation },
      {
        prompt_tokens: input,
        completion_tokens: output,
        cached_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
      },
    ]) {
      const result = await costCalculator.calculateCostDetailed(
        "anthropic",
        "claude-haiku-5.5",
        tokens
      );
      assert.equal(result.priced, true);
      assert.ok(Math.abs(result.costUsd - expectedCost) < 1e-12, String(input));
    }
  }
});

test("quota accounting preserves each Haiku prompt tier rather than repricing a sum of short requests", async () => {
  const { created, metadata } = await makeMeteredKey();
  for (const [index, input] of [100_000, 100_000, 100_001].entries()) {
    await usageHistory.saveRequestUsage({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      apiKeyId: created.id,
      tokens: { input, output: 101, cacheRead: 90_000, cacheCreation: 9_999 },
      success: true,
      // Identical tokens at the same timestamp are deliberately deduplicated
      // by saveRequestUsage; these are three distinct successful requests.
      timestamp: `2026-06-19T12:00:0${index}.000Z`,
    });
  }
  const shortRequestCost = (0.1 + 90_000 * 0.01 + 9_999 * 0.125 + 101 * 0.5) / 1_000_000;
  const longRequestCost = (2 * 0.5 + 90_000 * 0.05 + 9_999 * 0.625 + 101 * 2.5) / 1_000_000;
  const expectedCost = Math.round((2 * shortRequestCost + longRequestCost) * 1_000_000) / 1_000_000;
  const status = await usageLimits.getApiKeyUsageLimitStatus(metadata, { now: () => NOW });
  assert.equal(status.dailySpentUsd, expectedCost);
  assert.equal(status.weeklySpentUsd, expectedCost);
  assert.equal(status.dailyHasUnpricedUsage, false);
  assert.equal(status.dailyExceeded, false);
});

test("unknown configured compatible models use the fixed Sonnet 5.5 estimate, never subscription or mutable reference prices", async () => {
  await pricingDb.updatePricing({
    anthropic: {
      "claude-sonnet-5-5": { input: 0, output: 0, cached: 0, reasoning: 0 },
      "unlisted-custom-model": { input: 0, output: 0 },
    },
    openai: { "unlisted-custom-model": { input: 0, output: 0 } },
    cc: { "unlisted-custom-model": { input: 100, output: 100 } },
    codex: { "unlisted-custom-model": { input: 100, output: 100 } },
    cx: { "unlisted-custom-model": { input: 100, output: 100 } },
  });
  for (const type of ["anthropic-compatible", "openai-compatible", "openai-compatible-responses"]) {
    const node = await nodesDb.createProviderNode({
      id: `${type}-fallback-estimate`,
      type,
      name: "Unknown custom upstream",
      baseUrl: "https://custom-upstream.example/v1",
    });
    assert.ok(typeof node.id === "string");
    const pricing = await pricingDb.getPricingForModel(node.id, "unlisted-custom-model");
    assert.deepEqual(pricing, {
      input: 2,
      output: 10,
      cached: 0.1,
      reasoning: 10,
      cache_creation: 2.5,
    });
    const result = await costCalculator.calculateCostDetailed(node.id, "unlisted-custom-model", {
      input: 1_000_000,
      output: 100_000,
      cacheRead: 200_000,
      cacheCreation: 100_000,
      reasoning: 50_000,
    });
    assert.equal(result.priced, true);
    assert.ok(Math.abs(result.costUsd - 2.67) < 1e-12);
  }
});

test("custom model-name mapping normalizes prefixes/case/dots, merges DB overrides, and chooses metered collisions deterministically", async () => {
  const node = await nodesDb.createProviderNode({
    id: "openai-compatible-model-name-mapping",
    type: "openai-compatible",
    name: "Custom model mapping",
    baseUrl: "https://custom-upstream.example/v1",
  });
  assert.ok(typeof node.id === "string");
  core
    .getDbInstance()
    .prepare("INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)")
    .run(
      "models_dev_pricing",
      "metered-test-a",
      JSON.stringify({ "vendor/special.model": { input: 1, output: 2, cached: 0.1 } })
    );
  await pricingDb.updatePricing({
    "metered-test-a": { "vendor/special.model": { input: 6, output: 12 } },
    "metered-test-b": { "special-model": { input: 3, output: 9 } },
    cc: { "special-model": { input: 100, output: 100 } },
  });
  assert.deepEqual(await pricingDb.getPricingForModel(node.id, "client/SPECIAL.MODEL"), {
    input: 6,
    output: 12,
    cached: 0.1,
  });
  await pricingDb.updatePricing({
    "metered-test-b": { "special-model": { input: 10, output: 20 } },
  });
  assert.deepEqual(await pricingDb.getPricingForModel(node.id, "special-model"), {
    input: 10,
    output: 20,
  });
  await pricingDb.updatePricing({
    [node.id]: { "SPECIAL.MODEL": { input: 0, output: 0 } },
  });
  assert.deepEqual(
    await costCalculator.calculateCostDetailed(node.id, "client/special-model", {
      input: 1_000_000,
    }),
    { costUsd: 0, priced: true }
  );
});

test("custom unknown-model quota uses estimates immediately and replaces them after an operator price write", async () => {
  const node = await nodesDb.createProviderNode({
    id: "anthropic-compatible-quota-fallback",
    type: "anthropic-compatible",
    name: "Unknown custom model",
    baseUrl: "https://custom-upstream.example/v1",
  });
  assert.ok(typeof node.id === "string");
  const { created, metadata } = await makeMeteredKey();
  await usageHistory.saveRequestUsage({
    provider: node.id,
    model: "unlisted-custom-model",
    apiKeyId: created.id,
    tokens: { input: 11, output: 1 },
    success: true,
    timestamp: "2026-06-19T12:00:00.000Z",
  });
  const estimated = await usageLimits.getApiKeyUsageLimitStatus(metadata, { now: () => NOW });
  assert.equal(estimated.dailySpentUsd, 0.000032);
  assert.equal(estimated.dailyExceeded, false);
  assert.equal(estimated.weeklyExceeded, false);
  assert.equal(estimated.dailyHasUnpricedUsage, false);
  await pricingDb.updatePricing({
    [node.id]: { "unlisted-custom-model": { input: 1, output: 5 } },
  });
  const corrected = await usageLimits.getApiKeyUsageLimitStatus(metadata, { now: () => NOW });
  assert.equal(corrected.dailySpentUsd, 0.000016);
  await pricingDb.resetPricing(node.id);
  const restoredEstimate = await usageLimits.getApiKeyUsageLimitStatus(metadata, {
    now: () => NOW,
  });
  assert.equal(restoredEstimate.dailySpentUsd, 0.000032);
  const exactBoundary = await usageLimits.getApiKeyUsageLimitStatus(
    { ...metadata, dailyUsageLimitUsd: 0.000032 },
    { now: () => NOW }
  );
  assert.equal(exactBoundary.dailyExceeded, true);
  assert.equal(exactBoundary.dailyHasUnpricedUsage, false);
});

test("custom canonical matching honors an exact hyphen-key price override before an equivalent dot default", async () => {
  const node = await nodesDb.createProviderNode({
    id: "anthropic-compatible-exact-canonical-override",
    type: "anthropic-compatible",
    name: "Canonical override priority",
    baseUrl: "https://custom-upstream.example/v1",
  });
  assert.ok(typeof node.id === "string");
  const dotDefault = await pricingDb.getPricingForModel("anthropic", "claude-opus-4.6");
  assert.ok(dotDefault);
  await pricingDb.updatePricing({
    anthropic: { "claude-opus-4-6": { input: 7, output: 21 } },
  });
  const nativeHyphenPrice = await pricingDb.getPricingForModel("anthropic", "claude-opus-4-6");
  assert.ok(nativeHyphenPrice);
  assert.equal(nativeHyphenPrice.input, 7);
  assert.equal(nativeHyphenPrice.output, 21);
  assert.deepEqual(await pricingDb.getPricingForModel(node.id, "claude-opus-4.6"), dotDefault);
  const { created, metadata } = await makeMeteredKey();
  for (const [index, model] of ["claude-opus-4-6", "custom/CLAUDE-OPUS-4-6"].entries()) {
    assert.deepEqual(await pricingDb.getPricingForModel(node.id, model), nativeHyphenPrice);
    const cost = await costCalculator.calculateCostDetailed(node.id, model, {
      input: 100_000,
      output: 10_000,
    });
    assert.equal(cost.priced, true);
    assert.ok(Math.abs(cost.costUsd - 0.91) < 1e-12);
    await usageHistory.saveRequestUsage({
      provider: node.id,
      model,
      apiKeyId: created.id,
      tokens: { input: 100_000, output: 10_000 },
      success: true,
      timestamp: `2026-06-19T12:00:0${index}.000Z`,
    });
  }
  const status = await usageLimits.getApiKeyUsageLimitStatus(metadata, { now: () => NOW });
  assert.equal(status.dailySpentUsd, 1.82);
  assert.equal(status.weeklySpentUsd, 1.82);
  assert.equal(status.dailyHasUnpricedUsage, false);
  assert.equal(status.dailyExceeded, false);
});
