/**
 * Provider Topology "active" (green) state is driven by pendingRequests.byProvider.
 * This bucket must mirror byModel's +1/-1 lifecycle exactly: increment on start,
 * decrement on end, drop the key at zero, aggregate concurrent requests across
 * models/accounts under one provider, and self-heal via the stale sweep — so a
 * provider stops being "active" the moment its last in-flight request ends.
 */
import test from "node:test";
import assert from "node:assert/strict";

const {
  trackPendingRequest,
  getPendingProviderCounts,
  getPendingById,
  sweepStalePendingRequests,
  clearPendingRequests,
} = await import("../../src/lib/usage/usageHistory.ts");

const HOUR_MS = 60 * 60 * 1000;

test("byProvider increments on start and clears the key on end", () => {
  clearPendingRequests();

  trackPendingRequest("gpt-x", "openai", "conn-1", true);
  assert.equal(getPendingProviderCounts().openai, 1);

  trackPendingRequest("gpt-x", "openai", "conn-1", false);
  assert.equal(getPendingProviderCounts().openai, undefined, "key removed at zero");

  clearPendingRequests();
});

test("byProvider aggregates concurrent requests across models and accounts", () => {
  clearPendingRequests();

  trackPendingRequest("gpt-x", "openai", "conn-1", true);
  trackPendingRequest("gpt-y", "openai", "conn-2", true);
  trackPendingRequest("claude", "anthropic", "conn-3", true);

  const counts = getPendingProviderCounts();
  assert.equal(counts.openai, 2);
  assert.equal(counts.anthropic, 1);

  trackPendingRequest("gpt-x", "openai", "conn-1", false);
  assert.equal(getPendingProviderCounts().openai, 1, "still active while one remains");

  clearPendingRequests();
});

test("provider key is normalized to lowercase", () => {
  clearPendingRequests();
  trackPendingRequest("m", "OpenAI", "conn-1", true);
  assert.equal(getPendingProviderCounts().openai, 1);
  clearPendingRequests();
});

test("getPendingProviderCounts returns a copy (callers cannot mutate internal state)", () => {
  clearPendingRequests();
  trackPendingRequest("m", "openai", "conn-1", true);

  const snapshot = getPendingProviderCounts();
  snapshot.openai = 999;
  assert.equal(getPendingProviderCounts().openai, 1, "internal count unchanged");

  clearPendingRequests();
});

test("stale sweep decrements byProvider so a leaked request stops being active", () => {
  clearPendingRequests();

  const staleId = trackPendingRequest("gpt-x", "openai", "conn-stale", true);
  assert.ok(staleId);
  assert.equal(getPendingProviderCounts().openai, 1);

  const stale = getPendingById().get(staleId as string);
  assert.ok(stale);
  stale.startedAt = Date.now() - 2 * HOUR_MS;

  // The sweep is two-phase: the first pass marks the detail stale (still visible),
  // a pass one sweep interval later physically removes it and decrements counters.
  const now = Date.now();
  sweepStalePendingRequests(now, HOUR_MS);
  assert.equal(getPendingProviderCounts().openai, 1, "marked stale, still visible");
  sweepStalePendingRequests(now + 5 * 60 * 1000, HOUR_MS);
  assert.equal(getPendingProviderCounts().openai, undefined, "leaked active cleared by sweep");

  clearPendingRequests();
});
