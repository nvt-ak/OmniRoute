/**
 * db/settings/pricing.ts — Pricing data CRUD (user overrides, LiteLLM sync, models.dev sync).
 */

import { getDbInstance } from "../core";
import { backupDbFile } from "../backup";
import { getCachedPricing, getCachedProviderNodes, invalidateDbCache } from "../readCache";
import { PROVIDER_ID_TO_ALIAS } from "@omniroute/open-sse/config/providerModels.ts";
import { invalidateUserPricingMemo } from "@/lib/catalogUserPricing";
import { type JsonRecord, toRecord } from "./shared";
import { isFlatRateProvider } from "@/lib/usage/flatRateProviders";

type PricingModels = Record<string, JsonRecord>;
type PricingByProvider = Record<string, PricingModels>;
export type PricingSource = "default" | "litellm" | "modelsDev" | "user";
export type PricingSourceMap = Record<string, Record<string, PricingSource>>;

// Operator-approved estimate for unknown compatible-node models: Sonnet 5.5
// API rates, not a claim about the upstream model's actual billed price.
// https://platform.claude.com/docs/en/about-claude/pricing (2026-10-08).
const CUSTOM_MODEL_FALLBACK_PRICING = Object.freeze({
  input: 2,
  output: 10,
  cached: 0.1,
  reasoning: 10,
  cache_creation: 2.5,
});

const NON_METERED_PRICING_ALIASES: Record<string, true> = { codex: true, cx: true };
for (const [id, alias] of Object.entries(PROVIDER_ID_TO_ALIAS)) {
  if (isFlatRateProvider(id)) NON_METERED_PRICING_ALIASES[alias.toLowerCase()] = true;
}

async function touchPricing(): Promise<void> {
  invalidateDbCache("pricing");
  invalidateUserPricingMemo();
  try {
    const { clearTierCache } = await import("@omniroute/open-sse/services/tierResolver");
    clearTierCache();
  } catch {
    // fail-open: a missed tier invalidation must never break a price write
  }
}

function readPricingNamespace(
  db: ReturnType<typeof getDbInstance>,
  namespace: string
): PricingByProvider {
  const rows = db.prepare("SELECT key, value FROM key_value WHERE namespace = ?").all(namespace);
  const pricing: PricingByProvider = {};

  for (const row of rows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;

    try {
      pricing[key] = toRecord(JSON.parse(rawValue)) as PricingModels;
    } catch {
      // Corrupted data — skip silently, fallback to lower layers
    }
  }

  return pricing;
}

function mergePricingLayers(layers: PricingByProvider[]): PricingByProvider {
  const mergedPricing: PricingByProvider = {};

  for (const layer of layers) {
    for (const [provider, models] of Object.entries(layer)) {
      if (!mergedPricing[provider]) {
        mergedPricing[provider] = { ...models };
        continue;
      }

      for (const [model, pricing] of Object.entries(models)) {
        mergedPricing[provider][model] = mergedPricing[provider][model]
          ? { ...(mergedPricing[provider][model] || {}), ...toRecord(pricing) }
          : pricing;
      }
    }
  }

  return mergedPricing;
}

function buildPricingSourceMap(layers: {
  defaults: PricingByProvider;
  litellm: PricingByProvider;
  modelsDev: PricingByProvider;
  user: PricingByProvider;
}): PricingSourceMap {
  const sourceMap: PricingSourceMap = {};
  const mergedPricing = mergePricingLayers([
    layers.defaults,
    layers.litellm,
    layers.modelsDev,
    layers.user,
  ]);

  for (const [provider, models] of Object.entries(mergedPricing)) {
    sourceMap[provider] = {};

    for (const model of Object.keys(models)) {
      if (layers.user[provider]?.[model]) {
        sourceMap[provider][model] = "user";
      } else if (layers.modelsDev[provider]?.[model]) {
        sourceMap[provider][model] = "modelsDev";
      } else if (layers.litellm[provider]?.[model]) {
        sourceMap[provider][model] = "litellm";
      } else {
        sourceMap[provider][model] = "default";
      }
    }
  }

  return sourceMap;
}

async function getPricingLayers() {
  const db = getDbInstance();

  // Layer 1: Hardcoded defaults (lowest priority)
  const { getDefaultPricing } = await import("@/shared/constants/pricing");
  return {
    defaults: getDefaultPricing(),
    litellm: readPricingNamespace(db, "pricing_synced"),
    modelsDev: readPricingNamespace(db, "models_dev_pricing"),
    user: readPricingNamespace(db, "pricing"),
  };
}

export async function getPricing() {
  const layers = await getPricingLayers();
  // Merge: defaults → LiteLLM → models.dev → user (each layer overrides the previous)
  return mergePricingLayers([layers.defaults, layers.litellm, layers.modelsDev, layers.user]);
}

export async function getPricingWithSources(): Promise<{
  pricing: PricingByProvider;
  sourceMap: PricingSourceMap;
}> {
  const layers = await getPricingLayers();
  return {
    pricing: mergePricingLayers([layers.defaults, layers.litellm, layers.modelsDev, layers.user]),
    sourceMap: buildPricingSourceMap(layers),
  };
}

/** Case-insensitive key lookup; returns the first matching key in insertion order. */
type PricingKeyFinder = <T>(
  obj: Record<string, T> | undefined | null,
  key: string
) => T | undefined;

function findKeyInsensitive<T>(obj: Record<string, T> | undefined | null, key: string) {
  if (!obj || !key) return undefined;
  const lowerKey = key.toLowerCase();
  for (const [k, v] of Object.entries(obj)) {
    if (k.toLowerCase() === lowerKey) return v;
  }
  return undefined;
}

/**
 * Provider half of {@link getPricingForModel}: the provider's model table in a merged
 * pricing table, matched by id, alias, reverse alias, then without a `-cn` suffix.
 * Pure, so the `/v1/models` catalog can resolve prices with the same rules from one
 * in-memory table (`find` lets it pass an indexed finder with identical semantics).
 */
export function findProviderPricing(
  pricing: PricingByProvider,
  provider: string,
  find: PricingKeyFinder = findKeyInsensitive
): PricingModels | null {
  const pLower = (provider || "").toLowerCase();
  let providerPricing = find<PricingModels>(pricing, pLower);

  if (!providerPricing) {
    const alias = find<string>(PROVIDER_ID_TO_ALIAS, pLower);
    if (alias) providerPricing = find(pricing, alias);
  }

  if (!providerPricing) {
    for (const [id, mappedAlias] of Object.entries(PROVIDER_ID_TO_ALIAS)) {
      if (typeof mappedAlias === "string" && mappedAlias.toLowerCase() === pLower) {
        providerPricing = find(pricing, id);
        if (providerPricing) break;
      }
    }
  }

  if (!providerPricing) {
    const np = pLower.replace(/-cn$/, "");
    if (np && np !== pLower) {
      providerPricing = find(pricing, np);
    }
  }

  return providerPricing || null;
}

/** Model half of {@link getPricingForModel}: exact id, then dots replaced by hyphens. */
export function findModelPricing(
  providerPricing: PricingModels,
  model: string,
  find: PricingKeyFinder = findKeyInsensitive
): JsonRecord | null {
  const mLower = (model || "").toLowerCase();
  return (
    find<JsonRecord>(providerPricing, mLower) ||
    find<JsonRecord>(providerPricing, mLower.replace(/\./g, "-")) ||
    null
  );
}

export async function getPricingForModel(provider: string, model: string) {
  const pricing = (await getCachedPricing()) as PricingByProvider;
  const providerPricing = findProviderPricing(pricing, provider);
  const modelPricing = providerPricing ? findModelPricing(providerPricing, model) : null;
  if (modelPricing) return modelPricing;
  const mLower = (model || "").toLowerCase();

  // Compatible nodes use operator-approved estimates when no node-specific
  // price exists. Only configured nodes qualify; native/deleted IDs fail closed.
  const nodes = await getCachedProviderNodes();
  const node = nodes.find((entry) => entry?.id === provider);
  const nodeType = typeof node?.type === "string" ? node.type : "";
  if (
    !node ||
    (nodeType !== "anthropic-compatible" &&
      nodeType !== "openai-compatible" &&
      nodeType !== "openai-compatible-responses")
  ) {
    return null;
  }
  const basename = mLower.split("/").at(-1) || "";
  const normalizedModel = basename.replace(/\./g, "-");
  if (!normalizedModel) return null;
  // Normalize custom override names before trying estimates, so a public path
  // prefix never hides an explicit node price (including an explicit $0 price).
  if (providerPricing) {
    for (const [candidate, entry] of Object.entries(providerPricing)) {
      if (candidate.toLowerCase().split("/").at(-1)?.replace(/\./g, "-") === normalizedModel) {
        return entry;
      }
    }
  }

  const canonicalProvider = nodeType === "anthropic-compatible" ? "anthropic" : "openai";
  const canonicalPricing = findKeyInsensitive<PricingModels>(pricing, canonicalProvider);
  if (canonicalPricing) {
    // An exact requested basename is authoritative before equivalent spellings:
    // a hyphen-key operator override must not be hidden by an earlier dot default.
    const exactPrice = findKeyInsensitive<JsonRecord>(canonicalPricing, basename);
    const exactRate = exactPrice ? Number(exactPrice.input) + Number(exactPrice.output) : 0;
    if (exactPrice && Number.isFinite(exactRate) && exactRate > 0) return exactPrice;
    const hyphenPrice =
      basename !== normalizedModel
        ? findKeyInsensitive<JsonRecord>(canonicalPricing, normalizedModel)
        : undefined;
    const hyphenRate = hyphenPrice ? Number(hyphenPrice.input) + Number(hyphenPrice.output) : 0;
    if (hyphenPrice && Number.isFinite(hyphenRate) && hyphenRate > 0) return hyphenPrice;
    for (const [candidate, entry] of Object.entries(canonicalPricing)) {
      const score = Number(entry.input) + Number(entry.output);
      if (
        Number.isFinite(score) &&
        score > 0 &&
        candidate.toLowerCase().split("/").at(-1)?.replace(/\./g, "-") === normalizedModel
      ) {
        return entry;
      }
    }
  }

  // Name collisions across metered catalogs choose the highest combined rate;
  // ties use a stable lexical identity. Subscription estimates are never used
  // as prices for custom API-credit traffic, even if their row claims $0.
  let matchedPricing: JsonRecord | null = null;
  let highestRate = 0;
  let matchedIdentity = "";
  for (const [pricingProvider, models] of Object.entries(pricing)) {
    const providerKey = pricingProvider.toLowerCase();
    if (
      isFlatRateProvider(providerKey) ||
      Object.hasOwn(NON_METERED_PRICING_ALIASES, providerKey)
    ) {
      continue;
    }
    for (const [candidate, entry] of Object.entries(models)) {
      if (candidate.toLowerCase().split("/").at(-1)?.replace(/\./g, "-") !== normalizedModel) {
        continue;
      }
      const score = Number(entry.input) + Number(entry.output);
      const identity = `${providerKey}/${candidate.toLowerCase()}`;
      if (
        Number.isFinite(score) &&
        score > 0 &&
        (score > highestRate || (score === highestRate && identity < matchedIdentity))
      ) {
        matchedPricing = entry;
        highestRate = score;
        matchedIdentity = identity;
      }
    }
  }
  return matchedPricing || CUSTOM_MODEL_FALLBACK_PRICING;
}

export async function updatePricing(pricingData: PricingByProvider) {
  const db = getDbInstance();
  const insert = db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('pricing', ?, ?)"
  );

  const rows = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'pricing'").all();
  const existing: PricingByProvider = {};
  for (const row of rows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    existing[key] = toRecord(JSON.parse(rawValue)) as PricingModels;
  }

  const tx = db.transaction(() => {
    for (const [provider, models] of Object.entries(pricingData)) {
      insert.run(provider, JSON.stringify({ ...(existing[provider] || {}), ...models }));
    }
  });
  tx();
  backupDbFile("pre-write");
  await touchPricing();
  const updated: PricingByProvider = {};
  const allRows = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'pricing'").all();
  for (const row of allRows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    updated[key] = toRecord(JSON.parse(rawValue)) as PricingModels;
  }
  return updated;
}

export async function resetPricing(provider: string, model?: string) {
  const db = getDbInstance();

  if (model) {
    const row = db
      .prepare("SELECT value FROM key_value WHERE namespace = 'pricing' AND key = ?")
      .get(provider);
    if (row) {
      const rowRecord = toRecord(row);
      const value = typeof rowRecord.value === "string" ? rowRecord.value : "{}";
      const models = toRecord(JSON.parse(value));
      delete models[model];
      if (Object.keys(models).length === 0) {
        db.prepare("DELETE FROM key_value WHERE namespace = 'pricing' AND key = ?").run(provider);
      } else {
        db.prepare("UPDATE key_value SET value = ? WHERE namespace = 'pricing' AND key = ?").run(
          JSON.stringify(models),
          provider
        );
      }
    }
  } else {
    db.prepare("DELETE FROM key_value WHERE namespace = 'pricing' AND key = ?").run(provider);
  }

  backupDbFile("pre-write");
  await touchPricing();
  const allRows = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'pricing'").all();
  const result: Record<string, unknown> = {};
  for (const row of allRows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    result[key] = JSON.parse(rawValue);
  }
  return result;
}

export async function resetAllPricing() {
  const db = getDbInstance();
  db.prepare("DELETE FROM key_value WHERE namespace = 'pricing'").run();
  backupDbFile("pre-write");
  await touchPricing();
  return {};
}
