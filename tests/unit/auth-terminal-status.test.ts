import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-auth-terminal-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");
const accountFallback = await import("../../open-sse/services/accountFallback.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

const SYNTHETIC_EMPTY_STREAM_ERROR = "Claude returned an empty response (no content block)";
const CODEX_MODEL = "gpt-5.5";

async function seedCodexConnection(overrides: Record<string, unknown> = {}) {
  return providersDb.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    accessToken: "codex-access-token",
    refreshToken: "codex-refresh-token",
    isActive: true,
    testStatus: "active",
    backoffLevel: 0,
    providerSpecificData: { unrelated: { retained: true } },
    ...overrides,
  });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("getProviderCredentials skips credits_exhausted connections", async () => {
  await resetStorage();

  const exhausted = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "sk-exhausted",
    isActive: true,
    testStatus: "credits_exhausted",
  });

  const healthy = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "sk-healthy",
    isActive: true,
    testStatus: "active",
  });

  const selected = await auth.getProviderCredentials("openai");
  assert.ok(selected);
  assert.equal(selected.connectionId, healthy.id);
  assert.notEqual(selected.connectionId, exhausted.id);
});

test("getProviderCredentials reports allExpired when all active connections are terminal", async () => {
  await resetStorage();

  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "sk-only-exhausted",
    isActive: true,
    testStatus: "credits_exhausted",
  });

  const selected = await auth.getProviderCredentials("openai");
  assert.equal(selected?.allExpired, true);
  assert.equal(selected?.expiredStatus, "credits_exhausted");
  assert.equal(selected?.expiredCount, 1);
});

test("getProviderCredentials reports allExpired for isActive grok-cli with testStatus expired (#7611)", async () => {
  await resetStorage();

  await providersDb.createProviderConnection({
    provider: "grok-cli",
    authType: "oauth",
    accessToken: "gcli-access-token",
    isActive: true,
    testStatus: "expired",
    errorCode: "no_refresh_token",
    lastError: "No refresh token available — re-authenticate this account.",
  });

  const selected = await auth.getProviderCredentials("grok-cli");
  assert.equal(selected?.allExpired, true);
  assert.equal(selected?.expiredStatus, "expired");
  assert.equal(selected?.expiredCount, 1);
  assert.equal("connectionId" in (selected || {}), false);
});

test("getProviderCredentials can reuse a locally suppressed connection for combo live tests", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "sk-live-test",
    isActive: true,
    testStatus: "credits_exhausted",
    rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
  });

  const selected = await auth.getProviderCredentials("openai", null, null, null, {
    allowSuppressedConnections: true,
    bypassQuotaPolicy: true,
  });

  assert.ok(selected);
  assert.equal(selected.connectionId, conn.id);
});

test("markAccountUnavailable does not overwrite terminal status", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "sk-terminal",
    isActive: true,
    testStatus: "credits_exhausted",
    lastError: "insufficient_quota",
  });

  const result = await auth.markAccountUnavailable(
    (conn as any).id,
    503,
    "temporary upstream error",
    "openai",
    "gpt-4.1"
  );

  assert.equal(result.shouldFallback, true);
  assert.equal(result.cooldownMs, 0);

  const after = await providersDb.getProviderConnectionById((conn as any).id);
  assert.equal(after.testStatus, "credits_exhausted");
});

test("markAccountUnavailable marks 401 connections as expired without adding cooldown", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "sk-expired",
    isActive: true,
    testStatus: "active",
  });

  const result = await auth.markAccountUnavailable(
    (conn as any).id,
    401,
    "unauthorized",
    "openai",
    "gpt-4.1"
  );
  const after = await providersDb.getProviderConnectionById((conn as any).id);

  assert.equal(result.shouldFallback, true);
  assert.equal(result.cooldownMs, 0);
  assert.equal(after.testStatus, "expired");
  assert.ok(!after.rateLimitedUntil);
});

test("markAccountUnavailable marks 402 connections as credits_exhausted without adding cooldown", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "sk-credits",
    isActive: true,
    testStatus: "active",
  });

  const result = await auth.markAccountUnavailable(
    (conn as any).id,
    402,
    "payment required",
    "openai",
    "gpt-4.1"
  );
  const after = await providersDb.getProviderConnectionById((conn as any).id);

  assert.equal(result.shouldFallback, true);
  assert.equal(result.cooldownMs, 0);
  assert.equal(after.testStatus, "credits_exhausted");
  assert.ok(!after.rateLimitedUntil);
});

test("markAccountUnavailable treats API-key 403 as a recoverable cooldown", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "glm",
    authType: "apikey",
    apiKey: "sk-recoverable",
    isActive: true,
    testStatus: "active",
  });

  const result = await auth.markAccountUnavailable(
    (conn as any).id,
    403,
    "forbidden",
    "glm",
    "glm-5.1"
  );
  const after = await providersDb.getProviderConnectionById((conn as any).id);

  assert.equal(result.shouldFallback, true);
  assert.ok(result.cooldownMs > 0);
  assert.equal(after.testStatus, "unavailable");
  assert.ok(after.rateLimitedUntil);
  assert.equal(after.lastErrorType ?? null, null);
});

test("markAccountUnavailable keeps Grok Web alias 403 errors mode-local", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "grok-web",
    authType: "cookie",
    apiKey: "sso=grok-cookie",
    isActive: true,
    testStatus: "active",
  });

  const result = await auth.markAccountUnavailable(
    (conn as any).id,
    403,
    "forbidden",
    "gw",
    "heavy"
  );
  const after = await providersDb.getProviderConnectionById((conn as any).id);
  const lockout = accountFallback.getModelLockoutInfo("gw", (conn as any).id, "heavy");

  assert.equal(result.shouldFallback, true);
  assert.ok(result.cooldownMs > 0);
  assert.equal(after.testStatus, "active");
  assert.equal(after.lastErrorType, "forbidden");
  assert.ok(!after.rateLimitedUntil);
  assert.equal(lockout?.reason, "forbidden");
});

test("markAccountUnavailable keeps project-route 403 errors non-terminal", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "sk-project-route",
    isActive: true,
    testStatus: "active",
  });

  const result = await auth.markAccountUnavailable(
    (conn as any).id,
    403,
    "The service has not been used in project",
    "openai",
    "gpt-4.1"
  );
  const after = await providersDb.getProviderConnectionById((conn as any).id);

  assert.equal(result.shouldFallback, true);
  assert.equal(result.cooldownMs, 0);
  assert.equal(after.testStatus, "active");
  assert.equal(after.lastErrorType, "project_route_error");
  assert.ok(!after.rateLimitedUntil);
});

test("markAccountUnavailable keeps oauth-invalid 401 errors non-terminal", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "sk-oauth-invalid",
    isActive: true,
    testStatus: "active",
  });

  const result = await auth.markAccountUnavailable(
    (conn as any).id,
    401,
    "Invalid authentication credentials provided",
    "openai",
    "gpt-4.1"
  );
  const after = await providersDb.getProviderConnectionById((conn as any).id);

  assert.equal(result.shouldFallback, true);
  assert.equal(result.cooldownMs, 0);
  assert.equal(after.testStatus, "active");
  assert.equal(after.lastErrorType, "oauth_invalid_token");
  assert.ok(!after.rateLimitedUntil);
});

test("markAccountUnavailable keeps Codex selectable after a synthetic empty-stream 502", async () => {
  await resetStorage();
  const conn = await seedCodexConnection();
  const connectionId = conn.id;
  assert.ok(typeof connectionId === "string");
  const before = await providersDb.getProviderConnectionById(connectionId);

  const result = await auth.markAccountUnavailable(
    connectionId,
    502,
    SYNTHETIC_EMPTY_STREAM_ERROR,
    "codex",
    CODEX_MODEL
  );
  const after = await providersDb.getProviderConnectionById(connectionId);

  assert.equal(result.shouldFallback, true);
  assert.equal(result.cooldownMs, 0);
  assert.equal(after.testStatus, "active");
  assert.ok(!after.rateLimitedUntil);
  assert.equal(after.backoffLevel, before.backoffLevel);
  assert.deepEqual(after.providerSpecificData, before.providerSpecificData);
  assert.equal(accountFallback.getModelLockoutInfo("codex", connectionId, CODEX_MODEL), null);
  assert.equal(accountFallback.isModelLocked("codex", connectionId, CODEX_MODEL), false);
  assert.equal(
    accountFallback.getModelLockoutInfo("codex", connectionId, "gpt-5.3-codex-spark"),
    null
  );

  const selected = await auth.getProviderCredentials("codex", null, null, CODEX_MODEL);
  assert.ok(selected);
  assert.equal(selected.connectionId, connectionId);
});

test("markAccountUnavailable still cools Codex after a genuine Bad gateway 502", async () => {
  await resetStorage();
  const conn = await seedCodexConnection();
  const connectionId = conn.id;
  assert.ok(typeof connectionId === "string");

  const result = await auth.markAccountUnavailable(
    connectionId,
    502,
    "Bad gateway",
    "codex",
    CODEX_MODEL
  );
  const after = await providersDb.getProviderConnectionById(connectionId);

  assert.equal(result.shouldFallback, true);
  assert.ok(result.cooldownMs > 0);
  assert.equal(after.testStatus, "unavailable");
  assert.ok(new Date(String(after.rateLimitedUntil)).getTime() > Date.now());
  assert.ok(Number(after.backoffLevel) > 0);
});

test("markAccountUnavailable still scope-cools Codex for the same empty-stream message with 429", async () => {
  await resetStorage();
  const conn = await seedCodexConnection();
  const connectionId = conn.id;
  assert.ok(typeof connectionId === "string");

  const result = await auth.markAccountUnavailable(
    connectionId,
    429,
    SYNTHETIC_EMPTY_STREAM_ERROR,
    "codex",
    CODEX_MODEL
  );
  const after = await providersDb.getProviderConnectionById(connectionId);
  const providerSpecificData = after.providerSpecificData;
  assert.ok(providerSpecificData && typeof providerSpecificData === "object");
  assert.ok("codexScopeRateLimitedUntil" in providerSpecificData);
  const scopeCooldowns = providerSpecificData.codexScopeRateLimitedUntil;
  assert.ok(scopeCooldowns && typeof scopeCooldowns === "object" && "codex" in scopeCooldowns);

  assert.equal(result.shouldFallback, true);
  assert.ok(result.cooldownMs > 0);
  assert.ok(new Date(String(scopeCooldowns.codex)).getTime() > Date.now());
  assert.equal(accountFallback.isModelLocked("codex", connectionId, CODEX_MODEL), true);
});

test("markAccountUnavailable preserves terminal Codex state on a synthetic empty-stream 502", async () => {
  await resetStorage();
  const conn = await seedCodexConnection({
    testStatus: "credits_exhausted",
    lastError: "insufficient_quota",
    lastErrorType: "quota_exhausted",
    errorCode: 402,
    backoffLevel: 2,
  });
  const connectionId = conn.id;
  assert.ok(typeof connectionId === "string");
  const before = await providersDb.getProviderConnectionById(connectionId);

  const result = await auth.markAccountUnavailable(
    connectionId,
    502,
    SYNTHETIC_EMPTY_STREAM_ERROR,
    "codex",
    CODEX_MODEL
  );
  const after = await providersDb.getProviderConnectionById(connectionId);

  assert.equal(result.shouldFallback, true);
  assert.equal(result.cooldownMs, 0);
  assert.deepEqual(after, before);
  assert.equal(accountFallback.getModelLockoutInfo("codex", connectionId, CODEX_MODEL), null);
});

test("markAccountUnavailable preserves an existing Codex connection cooldown on a synthetic 502", async () => {
  await resetStorage();
  const conn = await seedCodexConnection({
    testStatus: "unavailable",
    rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
    lastError: "Bad gateway",
    lastErrorType: "server_error",
    errorCode: 502,
    backoffLevel: 2,
  });
  const connectionId = conn.id;
  assert.ok(typeof connectionId === "string");
  const before = await providersDb.getProviderConnectionById(connectionId);

  const result = await auth.markAccountUnavailable(
    connectionId,
    502,
    SYNTHETIC_EMPTY_STREAM_ERROR,
    "codex",
    CODEX_MODEL
  );
  const after = await providersDb.getProviderConnectionById(connectionId);

  assert.equal(result.shouldFallback, true);
  assert.ok(result.cooldownMs > 0);
  assert.deepEqual(after, before);
  assert.equal(accountFallback.getModelLockoutInfo("codex", connectionId, CODEX_MODEL), null);
});

test("markAccountUnavailable preserves an existing Codex child cooldown on a synthetic 502", async () => {
  await resetStorage();
  const conn = await seedCodexConnection({
    providerSpecificData: {
      unrelated: { retained: true },
      codexScopeRateLimitedUntil: { codex: new Date(Date.now() + 60_000).toISOString() },
      codexScopeRateLimitSource: { codex: "429" },
    },
    lastError: "rate limit exceeded",
    lastErrorType: "rate_limited",
    errorCode: 429,
    backoffLevel: 2,
  });
  const connectionId = conn.id;
  assert.ok(typeof connectionId === "string");
  const before = await providersDb.getProviderConnectionById(connectionId);

  const result = await auth.markAccountUnavailable(
    connectionId,
    502,
    SYNTHETIC_EMPTY_STREAM_ERROR,
    "codex",
    CODEX_MODEL
  );
  const after = await providersDb.getProviderConnectionById(connectionId);

  assert.equal(result.shouldFallback, true);
  assert.ok(result.cooldownMs > 0);
  assert.deepEqual(after, before);
  assert.equal(accountFallback.getModelLockoutInfo("codex", connectionId, CODEX_MODEL), null);
});
