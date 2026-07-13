/**
 * warnNotificationDedup.ts — de-duplicates quota "approaching cutoff" warnings.
 *
 * The quota preflight runs on (potentially) every request, so a connection
 * sitting above its warn threshold would fire a webhook per request. This
 * in-memory guard emits at most one warning per (provider, connectionId,
 * window) until the quota window resets, then re-arms.
 *
 * Re-arm rule: a warning is allowed again once the tracked resetAt advances
 * past the previously-notified resetAt (a new quota cycle), or after
 * REARM_FALLBACK_MS when no resetAt is available.
 *
 * State is process-local; a restart re-arms every key (acceptable — at worst
 * one extra notification after a restart).
 */

const REARM_FALLBACK_MS = 6 * 60 * 60 * 1000;

interface WarnRecord {
  resetAt: number | null;
  notifiedAt: number;
}

const state = new Map<string, WarnRecord>();

function buildKey(provider: string, connectionId: string, window: string | null): string {
  return `${provider}:${connectionId}:${window ?? "_single"}`;
}

function parseResetAt(resetAt: string | null | undefined): number | null {
  if (!resetAt) return null;
  const ms = new Date(resetAt).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Returns true when a warning should be sent now for this
 * (provider, connectionId, window), recording the send. Returns false when a
 * warning was already sent for the current quota cycle.
 */
export function shouldNotifyWarn(
  provider: string,
  connectionId: string,
  window: string | null,
  resetAt: string | null | undefined,
  now: number = Date.now()
): boolean {
  const key = buildKey(provider, connectionId, window);
  const resetAtMs = parseResetAt(resetAt);
  const prev = state.get(key);

  if (prev) {
    const cycleAdvanced = resetAtMs !== null && (prev.resetAt === null || resetAtMs > prev.resetAt);
    const fallbackElapsed = resetAtMs === null && now - prev.notifiedAt < REARM_FALLBACK_MS;
    if (!cycleAdvanced && (resetAtMs !== null || fallbackElapsed)) {
      return false;
    }
  }

  state.set(key, { resetAt: resetAtMs, notifiedAt: now });
  return true;
}

export function resetWarnDedupState(): void {
  state.clear();
}
