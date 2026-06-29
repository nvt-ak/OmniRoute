/**
 * Pure helpers for the home-page Provider Topology panel.
 */

/** Minimal shape expected by <ProviderTopology activeRequests={...}> */
export interface TopologyActiveRequest {
  provider: string;
  model: string;
}

/** Minimal in-flight request shape (subset of LiveRequest from useLiveRequests) */
interface InFlightRequest {
  provider: string;
  model: string;
}

/**
 * Maps an array of in-flight LiveRequest entries to the flat
 * { provider, model }[] shape consumed by <ProviderTopology>.
 *
 * The input is expected to contain only pending/running entries — the
 * useLiveRequests hook already filters out completed and failed requests
 * before exposing them via `activeRequests`.
 */
export function selectActiveRequests(requests: InFlightRequest[]): TopologyActiveRequest[] {
  return requests.map(({ provider, model }) => ({ provider, model }));
}

// 9router shows the last-error highlight as a short-lived flash that ages out
// on a timer (10s over its 150ms SSE stream), not a permanent health status.
// OmniRoute polls every 3s instead of streaming, so the window is 30s to
// survive a few poll cycles. Complements the server-side #3619 recovery gate.
export const TOPOLOGY_ERROR_TTL_MS = 30_000;

export interface TopologyProviderMetric {
  lastRequestAt?: string | null;
  lastErrorAt?: string | null;
  lastStatus?: number | null;
}

export interface TopologyStatus {
  lastProvider: string;
  errorProvider: string;
}

function parseTs(value?: string | null): number {
  if (!value) return 0;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : 0;
}

function isCurrentlyInError(lastStatus?: number | null): boolean {
  return typeof lastStatus === "number" && (lastStatus < 200 || lastStatus >= 400);
}

export function computeTopologyStatus(
  metrics: Record<string, TopologyProviderMetric>,
  normalizeProviderId: (id: string) => string = (id) => id,
  now: number = Date.now()
): TopologyStatus {
  let lastProvider = "";
  let lastProviderTs = 0;
  let errorProvider = "";
  let errorProviderTs = 0;

  for (const [provider, metric] of Object.entries(metrics)) {
    const requestTs = parseTs(metric.lastRequestAt);
    if (requestTs > lastProviderTs) {
      lastProvider = normalizeProviderId(provider);
      lastProviderTs = requestTs;
    }

    if (!isCurrentlyInError(metric.lastStatus)) continue;

    const errorTs = parseTs(metric.lastErrorAt);
    const withinTtl = errorTs > 0 && now - errorTs < TOPOLOGY_ERROR_TTL_MS;
    if (withinTtl && errorTs > errorProviderTs) {
      errorProvider = normalizeProviderId(provider);
      errorProviderTs = errorTs;
    }
  }

  return { lastProvider, errorProvider };
}
