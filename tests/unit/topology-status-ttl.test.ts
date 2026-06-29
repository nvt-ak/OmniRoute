/**
 * Provider Topology status derivation (ported from 9router): "Error" red is a
 * short-lived flash gated on the provider's MOST RECENT request being a failure
 * AND that failure being within TOPOLOGY_ERROR_TTL_MS. A provider that errored
 * long ago — or recovered since — must not stay red. "Recent" is the provider
 * whose latest request is newest.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  computeTopologyStatus,
  TOPOLOGY_ERROR_TTL_MS,
} from "../../src/app/(dashboard)/home/topologyUtils.ts";

const NOW = Date.parse("2026-06-29T12:00:00.000Z");
const isoAgo = (ms: number) => new Date(NOW - ms).toISOString();

test("lastProvider is the provider with the newest lastRequestAt", () => {
  const { lastProvider } = computeTopologyStatus(
    {
      openai: { lastRequestAt: isoAgo(60_000), lastStatus: 200 },
      anthropic: { lastRequestAt: isoAgo(5_000), lastStatus: 200 },
    },
    (id) => id,
    NOW
  );
  assert.equal(lastProvider, "anthropic");
});

test("errorProvider flashes when latest request failed within the TTL window", () => {
  const { errorProvider } = computeTopologyStatus(
    {
      firecrawl: { lastRequestAt: isoAgo(2_000), lastErrorAt: isoAgo(2_000), lastStatus: 500 },
    },
    (id) => id,
    NOW
  );
  assert.equal(errorProvider, "firecrawl");
});

test("errorProvider ages out: a failure older than the TTL is no longer red", () => {
  const { errorProvider } = computeTopologyStatus(
    {
      firecrawl: {
        lastRequestAt: isoAgo(TOPOLOGY_ERROR_TTL_MS + 5_000),
        lastErrorAt: isoAgo(TOPOLOGY_ERROR_TTL_MS + 5_000),
        lastStatus: 500,
      },
    },
    (id) => id,
    NOW
  );
  assert.equal(errorProvider, "");
});

test("a provider that errored long ago but recovered (lastStatus 200) is not red", () => {
  const { errorProvider } = computeTopologyStatus(
    {
      providerA: { lastRequestAt: isoAgo(1_000), lastErrorAt: isoAgo(1_000), lastStatus: 200 },
    },
    (id) => id,
    NOW
  );
  assert.equal(errorProvider, "");
});

test("when several providers are within the window, the most recent failure wins", () => {
  const { errorProvider } = computeTopologyStatus(
    {
      providerA: { lastRequestAt: isoAgo(10_000), lastErrorAt: isoAgo(10_000), lastStatus: 503 },
      providerB: { lastRequestAt: isoAgo(3_000), lastErrorAt: isoAgo(3_000), lastStatus: 500 },
    },
    (id) => id,
    NOW
  );
  assert.equal(errorProvider, "providerB");
});

test("normalizeProviderId is applied to both outputs", () => {
  const { lastProvider, errorProvider } = computeTopologyStatus(
    {
      "openai-alias": { lastRequestAt: isoAgo(2_000), lastErrorAt: isoAgo(2_000), lastStatus: 500 },
    },
    (id) => id.replace("-alias", ""),
    NOW
  );
  assert.equal(lastProvider, "openai");
  assert.equal(errorProvider, "openai");
});

test("empty metrics yields empty status", () => {
  const result = computeTopologyStatus({}, (id) => id, NOW);
  assert.deepEqual(result, { lastProvider: "", errorProvider: "" });
});
