-- Fork-only migration. Fork migrations are named <latest upstream number><letter>
-- (214a, 214b, …) so they sort right after that upstream slot and never take a
-- number upstream will use next; the runner records the version as "214a".
-- Per-request USD cost cached for the per-API-key daily/weekly usage-limit check
-- (src/lib/usage/apiKeyUsageLimits.ts). The check used to re-price every request
-- in its windows on every /v1 call; it now prices each row once, stores the result
-- here, and sums it.
--   limit_cost_status: 0 = not priced yet, 1 = priced (limit_cost_usd holds the cost),
--                      2 = no pricing row (fails the window closed, #12341; re-tried on
--                          every check so adding the price reopens the window).
-- Existing rows start at 0 and are priced lazily by the first check that covers them.
ALTER TABLE usage_history ADD COLUMN limit_cost_usd REAL;
ALTER TABLE usage_history ADD COLUMN limit_cost_status INTEGER NOT NULL DEFAULT 0;
-- Covers both the window SUM and the not-yet-priced lookup without table reads.
CREATE INDEX IF NOT EXISTS idx_uh_key_ts_limit_cost
  ON usage_history(api_key_id, timestamp, success, provider_cost_usd, limit_cost_status, limit_cost_usd);
