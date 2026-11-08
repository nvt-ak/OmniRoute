/**
 * db/settings/cacheMetrics.ts — Cache control metrics (computed from usage_history on-the-fly).
 */

import { getDbInstance } from "../core";

/**
 * NULL-safe `provider NOT IN (...)` predicate. NULL-provider rows are kept, because a
 * plain `NOT IN` drops NULLs in SQLite. Returns an empty fragment when nothing is excluded.
 */
function buildExcludeClause(excludeProviders: string[] | undefined): {
  sql: string;
  params: string[];
} {
  const providers = (excludeProviders ?? []).filter((p) => typeof p === "string" && p.length > 0);
  if (providers.length === 0) return { sql: "", params: [] };
  const placeholders = providers.map(() => "?").join(", ");
  return {
    sql: `(provider IS NULL OR provider NOT IN (${placeholders}))`,
    params: providers,
  };
}

/**
 * Aggregate row of the provider / provider+model breakdown below.
 *
 * `cacheCreationReported` exists because not every backend has a cache-WRITE
 * counter: OpenAI automatic prefix caching and Gemini implicit caching only
 * report reads (`cached_tokens` / `cachedContentTokenCount`), and OmniRoute
 * stores the missing write leg as `0` (the column is NOT NULL). Rendering that
 * `0` next to a provider that obviously caches (430M cached read tokens and not
 * a single write) claims it wrote zero tokens, when the metric does not exist.
 */
export interface CacheBreakdownStats {
  requests: number;
  totalRequests: number;
  cachedRequests: number;
  inputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  /**
   * False only when the row demonstrably caches (reads > 0) yet never reported a
   * single write token — a read-only/implicit cache backend, where the write
   * column is "not applicable" rather than "0". True when a write was reported,
   * or when there is no cache activity to judge from (a genuine 0).
   *
   * The window is all of `usage_history` (this aggregation has no time filter),
   * so a provider that ever writes keeps reporting numbers in a fully-warm
   * period.
   */
  cacheCreationReported: boolean;
}

/** See {@link CacheBreakdownStats.cacheCreationReported}. */
function isCacheCreationReported(cachedRequests: number, cacheCreationTokens: number): boolean {
  return cacheCreationTokens > 0 || cachedRequests === 0;
}

/**
 * Display-only Cache Rate counts. Excludes `excludeProviders` from both numerator and
 * denominator, leaving the original top-level fields untouched.
 *
 * Failed requests are dropped from both sides as well: a request that errored never got
 * a chance to hit the cache, so counting it reports the upstream's error rate, not cache
 * efficiency. On a real dataset this is not a rounding error — 9,915 of 35,243 rows
 * (28%) are failures, and they dragged the card from ~94% down to 68%.
 */
function getCacheRateCounts(db: ReturnType<typeof getDbInstance>, excludeProviders: string[]) {
  const exclude = buildExcludeClause(excludeProviders);
  // `usage_history.success` is written as 0/1 (never NULL), so `success = 1` is exact.
  const conditions = ["success = 1"];
  if (exclude.sql) conditions.push(exclude.sql);
  const where = ` WHERE ${conditions.join(" AND ")}`;
  const row = db
    .prepare(
      `
      SELECT
        COUNT(*) as totalRequests,
        SUM(CASE WHEN tokens_cache_read > 0 OR tokens_cache_creation > 0 THEN 1 ELSE 0 END) as requestsWithCacheControl
      FROM usage_history${where}
    `
    )
    .get(...exclude.params) as
    { totalRequests: number | null; requestsWithCacheControl: number | null } | undefined;
  return {
    totalRequests: row?.totalRequests || 0,
    requestsWithCacheControl: row?.requestsWithCacheControl || 0,
  };
}

/**
 * @param cacheRateExcludeProviders Providers omitted ONLY from `promptCache.cacheRate`
 *   (the Cache Rate card). Every other field is unfiltered and unchanged.
 */
export async function getCacheMetrics(cacheRateExcludeProviders: string[] = []) {
  const db = getDbInstance();

  try {
    // Aggregate totals from usage_history
    const totalsRow = db
      .prepare(
        `
      SELECT
        COUNT(*) as totalRequests,
        SUM(tokens_input) as totalInputTokens,
        SUM(tokens_cache_read) as totalCachedTokens,
        SUM(tokens_cache_creation) as totalCacheCreationTokens
      FROM usage_history
      WHERE tokens_cache_read > 0 OR tokens_cache_creation > 0
    `
      )
      .get() as
      | {
          totalRequests: number;
          totalInputTokens: number | null;
          totalCachedTokens: number | null;
          totalCacheCreationTokens: number | null;
        }
      | undefined;

    // Get all requests count (including those without cache activity)
    const allRequestsRow = db
      .prepare(
        `
      SELECT COUNT(*) as totalRequests
      FROM usage_history
    `
      )
      .get() as { totalRequests: number } | undefined;

    // Aggregate by provider
    const byProviderRows = db
      .prepare(
        `
      SELECT
        provider,
        COUNT(*) as totalRequests,
        SUM(CASE WHEN tokens_cache_read > 0 OR tokens_cache_creation > 0 THEN 1 ELSE 0 END) as cachedRequests,
        SUM(CASE WHEN tokens_cache_read > 0 OR tokens_cache_creation > 0 THEN tokens_input ELSE 0 END) as inputTokens,
        SUM(tokens_cache_read) as cachedTokens,
        SUM(tokens_cache_creation) as cacheCreationTokens
      FROM usage_history
      WHERE provider IS NOT NULL
      GROUP BY provider
      HAVING cachedRequests > 0
    `
      )
      .all() as Array<{
      provider: string;
      totalRequests: number;
      cachedRequests: number;
      inputTokens: number | null;
      cachedTokens: number | null;
      cacheCreationTokens: number | null;
    }>;

    // Aggregate by provider + model so a provider that pools heterogeneous
    // backends (a remote router, a combo target) does not hide them behind one
    // blended number. `haiku 95% + gpt 32%` and `both 73%` are very different
    // stories, and only the split shows which model to fix.
    const byProviderModelRows = db
      .prepare(
        `
      SELECT
        provider,
        COALESCE(model, '') as model,
        COUNT(*) as totalRequests,
        SUM(CASE WHEN tokens_cache_read > 0 OR tokens_cache_creation > 0 THEN 1 ELSE 0 END) as cachedRequests,
        SUM(CASE WHEN tokens_cache_read > 0 OR tokens_cache_creation > 0 THEN tokens_input ELSE 0 END) as inputTokens,
        SUM(tokens_cache_read) as cachedTokens,
        SUM(tokens_cache_creation) as cacheCreationTokens
      FROM usage_history
      WHERE provider IS NOT NULL
      GROUP BY provider, model
      HAVING cachedRequests > 0
    `
      )
      .all() as Array<{
      provider: string;
      model: string;
      totalRequests: number;
      cachedRequests: number;
      inputTokens: number | null;
      cachedTokens: number | null;
      cacheCreationTokens: number | null;
    }>;

    // Aggregate by combo strategy (direct requests stored as 'direct')
    const byStrategyRows = db
      .prepare(
        `
      SELECT
        COALESCE(combo_strategy, 'direct') as strategy,
        COUNT(*) as requests,
        SUM(tokens_input) as inputTokens,
        SUM(tokens_cache_read) as cachedTokens,
        SUM(tokens_cache_creation) as cacheCreationTokens
      FROM usage_history
      WHERE (tokens_cache_read > 0 OR tokens_cache_creation > 0)
      GROUP BY combo_strategy
    `
      )
      .all() as Array<{
      strategy: string;
      requests: number;
      inputTokens: number | null;
      cachedTokens: number | null;
      cacheCreationTokens: number | null;
    }>;

    const tokensSaved = totalsRow?.totalCachedTokens || 0;

    const AVG_INPUT_PRICE_PER_MILLION = 3;
    const CACHE_DISCOUNT = 0.9;
    const estimatedCostSaved =
      Math.round((tokensSaved / 1_000_000) * AVG_INPUT_PRICE_PER_MILLION * CACHE_DISCOUNT * 100) /
      100;

    // Build byProvider object
    const byProvider: Record<string, CacheBreakdownStats> = {};
    for (const row of byProviderRows) {
      const cachedRequests = row.cachedRequests;
      const cacheCreationTokens = row.cacheCreationTokens || 0;
      byProvider[row.provider] = {
        requests: cachedRequests,
        totalRequests: row.totalRequests,
        cachedRequests,
        inputTokens: row.inputTokens || 0,
        cachedTokens: row.cachedTokens || 0,
        cacheCreationTokens,
        cacheCreationReported: isCacheCreationReported(cachedRequests, cacheCreationTokens),
      };
    }

    // Build byProviderModel object (provider → model → stats)
    const byProviderModel: Record<string, Record<string, CacheBreakdownStats>> = {};
    for (const row of byProviderModelRows) {
      const cachedRequests = row.cachedRequests;
      const cacheCreationTokens = row.cacheCreationTokens || 0;
      const perModel = (byProviderModel[row.provider] ??= {});
      perModel[row.model] = {
        requests: cachedRequests,
        totalRequests: row.totalRequests,
        cachedRequests,
        inputTokens: row.inputTokens || 0,
        cachedTokens: row.cachedTokens || 0,
        cacheCreationTokens,
        cacheCreationReported: isCacheCreationReported(cachedRequests, cacheCreationTokens),
      };
    }

    // Build byStrategy object
    const byStrategy: Record<
      string,
      {
        requests: number;
        inputTokens: number;
        cachedTokens: number;
        cacheCreationTokens: number;
      }
    > = {};
    for (const row of byStrategyRows) {
      byStrategy[row.strategy] = {
        requests: row.requests,
        inputTokens: row.inputTokens || 0,
        cachedTokens: row.cachedTokens || 0,
        cacheCreationTokens: row.cacheCreationTokens || 0,
      };
    }

    return {
      totalRequests: allRequestsRow?.totalRequests || totalsRow?.totalRequests || 0,
      requestsWithCacheControl: totalsRow?.totalRequests || 0,
      totalInputTokens: totalsRow?.totalInputTokens || 0,
      totalCachedTokens: totalsRow?.totalCachedTokens || 0,
      totalCacheCreationTokens: totalsRow?.totalCacheCreationTokens || 0,
      tokensSaved,
      estimatedCostSaved,
      byProvider,
      byProviderModel,
      byStrategy,
      // Display-only scope for the Cache Rate card; the label must state the exclusion.
      cacheRate: getCacheRateCounts(db, cacheRateExcludeProviders),
      lastUpdated: new Date().toISOString(),
    };
  } catch (error) {
    console.error("Failed to fetch cache metrics from usage_history:", error);
    return {
      totalRequests: 0,
      requestsWithCacheControl: 0,
      totalInputTokens: 0,
      totalCachedTokens: 0,
      totalCacheCreationTokens: 0,
      tokensSaved: 0,
      estimatedCostSaved: 0,
      byProvider: {},
      byProviderModel: {},
      byStrategy: {},
      cacheRate: {
        totalRequests: 0,
        requestsWithCacheControl: 0,
      },
      lastUpdated: new Date().toISOString(),
    };
  }
}

export async function updateCacheMetrics(_metrics: Record<string, unknown>) {
  // No-op: metrics are now computed from usage_history on-the-fly
  // The usage_history table is the single source of truth
  return getCacheMetrics();
}

export interface CacheTrendPoint {
  timestamp: string;
  requests: number;
  cachedRequests: number;
  inputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
}

export async function getCacheTrend(hours = 24): Promise<CacheTrendPoint[]> {
  const db = getDbInstance();

  try {
    const rows = db
      .prepare(
        `
        SELECT
          strftime('%Y-%m-%dT%H:00:00Z', timestamp) as hour,
          COUNT(*) as requests,
          SUM(CASE WHEN tokens_cache_read > 0 OR tokens_cache_creation > 0 THEN 1 ELSE 0 END) as cachedRequests,
          SUM(tokens_input) as inputTokens,
          SUM(tokens_cache_read) as cachedTokens,
          SUM(tokens_cache_creation) as cacheCreationTokens
        FROM usage_history
        WHERE timestamp >= datetime('now', ?)
        GROUP BY hour
        ORDER BY hour ASC
      `
      )
      .all(`-${hours} hours`) as Array<{
      hour: string;
      requests: number;
      cachedRequests: number;
      inputTokens: number | null;
      cachedTokens: number | null;
      cacheCreationTokens: number | null;
    }>;

    return rows.map((r) => ({
      timestamp: r.hour,
      requests: r.requests,
      cachedRequests: r.cachedRequests,
      inputTokens: r.inputTokens || 0,
      cachedTokens: r.cachedTokens || 0,
      cacheCreationTokens: r.cacheCreationTokens || 0,
    }));
  } catch (error) {
    console.error("Failed to fetch cache trend:", error);
    return [];
  }
}

export async function resetCacheMetrics() {
  // No-op: cache metrics are computed from usage_history.
  console.warn(
    "resetCacheMetrics is deprecated - cache metrics are now computed from usage_history"
  );
  return getCacheMetrics();
}
