import test from "node:test";
import assert from "node:assert/strict";

import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.tsx";

test("T13: parseQuotaData zeroes usage on a genuine rollover (past resetAt + fresh fetch)", () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const parsed = parseQuotaData("codex", {
    fetchedAt: new Date().toISOString(),
    quotas: {
      session: { used: 83, total: 100, resetAt: past },
    },
  });

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].used, 0);
  assert.equal(parsed[0].staleAfterReset, true);
  assert.equal(parsed[0].remainingPercentage, 100);
});

test("T13: parseQuotaData keeps usage unchanged when resetAt is in the future", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const parsed = parseQuotaData("codex", {
    fetchedAt: new Date().toISOString(),
    quotas: {
      session: { used: 42, total: 100, resetAt: future },
    },
  });

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].used, 42);
  assert.equal(parsed[0].staleAfterReset, false);
});

test("T13: parseQuotaData does NOT force 100% when a past resetAt comes from a stale fetch", () => {
  // Regression: a 7h-old cache whose session reset already lapsed must show the
  // real remaining %, not a fake 100% (Claude Code session showed 100% instead of 82%).
  const past = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const parsed = parseQuotaData("claude", {
    fetchedAt: new Date(Date.now() - 7 * 3_600_000).toISOString(),
    quotas: {
      "session (5h)": { used: 18, total: 100, remainingPercentage: 82, resetAt: past },
    },
  });

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].used, 18);
  assert.equal(parsed[0].staleAfterReset, false);
  assert.equal(parsed[0].remainingPercentage, 82);
});

test("T13: parseQuotaData without fetchedAt does not fabricate 100% on a past resetAt", () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const parsed = parseQuotaData("claude", {
    quotas: {
      "session (5h)": { used: 40, total: 100, remainingPercentage: 60, resetAt: past },
    },
  });

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].staleAfterReset, false);
  assert.equal(parsed[0].remainingPercentage, 60);
});
