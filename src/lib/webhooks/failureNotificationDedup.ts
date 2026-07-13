/**
 * failureNotificationDedup.ts — coalesces request.failed webhooks.
 *
 * A failing upstream can produce hundreds of identical failures per minute; one
 * webhook per request would flood the channel. This in-memory window groups
 * failures by (combo, provider, status) and emits at most one notification per
 * window, carrying the number of failures observed since the last emit.
 *
 * Contract:
 *   - First failure for a key emits immediately (count 1).
 *   - Subsequent failures in the same window are counted, not emitted.
 *   - After the window elapses, the next failure emits again and reports the
 *     total count accumulated during the silent period.
 *
 * State is process-local; a restart re-arms every key (at worst one extra
 * notification after a restart).
 */

function resolveWindowMs(): number {
  const raw = Number(process.env.WEBHOOK_FAILURE_DEDUP_WINDOW_MINUTES);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : 5;
  return minutes * 60 * 1000;
}

const WINDOW_MS = resolveWindowMs();

interface FailureRecord {
  firstAt: number;
  count: number;
}

const state = new Map<string, FailureRecord>();

function buildKey(combo: string, provider: string, status: number | string): string {
  return `${combo}::${provider}::${status}`;
}

/**
 * Records a failure and decides whether to emit a webhook now. When it returns
 * shouldNotify=true, `count` is the number of failures grouped since the last
 * emit (1 on the first failure of a fresh window; the accumulated total when a
 * window has just elapsed).
 */
export function recordFailureForNotify(
  combo: string,
  provider: string,
  status: number | string,
  now: number = Date.now()
): { shouldNotify: boolean; count: number } {
  const key = buildKey(combo, provider, status);
  const prev = state.get(key);

  // No prior record → first failure of a fresh window, emit immediately.
  if (!prev) {
    state.set(key, { firstAt: now, count: 1 });
    return { shouldNotify: true, count: 1 };
  }

  // Window still open → count silently.
  if (now - prev.firstAt < WINDOW_MS) {
    prev.count += 1;
    return { shouldNotify: false, count: prev.count };
  }

  // Window elapsed → emit a rollup of everything grouped during the silent
  // period (including this failure), then start a fresh window.
  const rolledUp = prev.count + 1;
  state.set(key, { firstAt: now, count: 1 });
  return { shouldNotify: true, count: rolledUp };
}

export function resetFailureDedupState(): void {
  state.clear();
}
