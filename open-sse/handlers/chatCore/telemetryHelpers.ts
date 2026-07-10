import { fetchLiveProviderLimits } from "@/lib/usage/providerLimits";
import { isClaudeExtraUsageBlockEnabled } from "@/lib/providers/claudeExtraUsage";

// #4604 — Lazy backoff for the best-effort live-WS sidecar bridge. In single-port
// deployments the sidecar (port 20132) is not running, so every compression event
// POST failed with ECONNREFUSED; because the global fetch is proxyFetch, each
// failure logged a "[ProxyFetch] Undici dispatcher failed" warning (272× in 42min).
// After a few consecutive failures we stop attempting for a cooldown window (then
// probe once), mirroring the project's lazy circuit-breaker recovery. A success
// clears the backoff so a sidecar that comes up later is picked back up.
const LIVE_WS_MAX_CONSECUTIVE_FAILURES = 3;
const LIVE_WS_DISABLE_MS = 60_000;
let liveWsConsecutiveFailures = 0;
let liveWsDisabledUntil = 0;

/** Test-only: reset the live-WS forwarding backoff state. */
export function __resetLiveWsForwardingState(): void {
  liveWsConsecutiveFailures = 0;
  liveWsDisabledUntil = 0;
}

export async function forwardDashboardEventToLiveWs(
  event: string,
  payload: unknown,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now
): Promise<void> {
  // Skip while the bridge is in a cooldown window after repeated failures.
  if (liveWsDisabledUntil > now()) return;

  const port = process.env.LIVE_WS_PORT || "20132";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    await fetchImpl(`http://127.0.0.1:${port}/__omniroute_event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event, payload, timestamp: now() }),
      signal: controller.signal,
    });
    // Success → the sidecar is reachable; clear any accumulated backoff.
    liveWsConsecutiveFailures = 0;
    liveWsDisabledUntil = 0;
  } catch {
    // Best-effort sidecar bridge; do not affect the chat hot path. Trip the
    // cooldown once failures pile up so a missing sidecar stops spamming logs.
    liveWsConsecutiveFailures += 1;
    if (liveWsConsecutiveFailures >= LIVE_WS_MAX_CONSECUTIVE_FAILURES) {
      liveWsDisabledUntil = now() + LIVE_WS_DISABLE_MS;
      liveWsConsecutiveFailures = 0;
    }
  } finally {
    clearTimeout(timeout);
  }
}

// Post-stream live sync of Claude's OAuth-usage plan window, gated behind an
// opt-in env var (default OFF). `/api/oauth/usage` is a non-official,
// aggressively rate-limited endpoint (Anthropic 429s it under sustained load);
// calling it live after EVERY successful Claude stream/response compounds with
// the per-token 429 cooldown (claudeUsageCooldown.ts) into a self-sustaining
// 429 loop — the cooldown expires, the very next chat re-triggers this sync,
// 429s again, and repeats indefinitely (never converges to a quiet steady
// state). The background provider-limits sync (providerLimits.ts, ~5-7min
// cadence) plus manual dashboard refresh already keep the extra-usage block
// state fresh enough for its purpose (surfacing a stale-but-recent block
// signal), so live post-stream sync is opt-in rather than always-on.
function isClaudeExtraUsagePostStreamSyncEnabled(): boolean {
  return process.env.CLAUDE_EXTRA_USAGE_LIVE_SYNC_ENABLED === "true";
}

export async function maybeSyncClaudeExtraUsageState({
  provider,
  connectionId,
  providerSpecificData,
  log,
}: {
  provider: string | null | undefined;
  connectionId: string | null | undefined;
  providerSpecificData: unknown;
  log?: { debug?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void } | null;
}) {
  if (
    !connectionId ||
    !isClaudeExtraUsagePostStreamSyncEnabled() ||
    !isClaudeExtraUsageBlockEnabled(provider, providerSpecificData)
  ) {
    return;
  }

  try {
    await fetchLiveProviderLimits(connectionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log?.debug?.("CLAUDE_USAGE", `Failed to sync Claude extra-usage state: ${message}`);
  }
}
