/**
 * #12398 — decides whether a Claude-format stream must be aborted with an
 * upstream error at flush time because the client got no usable content.
 *
 * Covers three shapes:
 *  - "clean empty turn": a real message_stop after end_turn or stop_sequence
 *    is valid for native Claude, but never for Codex without usable content.
 *  - "partial lifecycle": lifecycle events arrived but no content block or
 *    clean completion did.
 *  - "truly empty": the upstream connection closed having sent literally
 *    zero bytes (HTTP 200, not even a message_start). The lifecycle flags
 *    above can never catch this shape since none of them are ever set — the
 *    caller must additionally know whether ANY upstream chunk ever arrived.
 *
 * Callers must additionally require a Claude-format client (this function
 * does not take that flag — both call sites in stream.ts only ever reach
 * here already scoped to a Claude-format response).
 */

import { isEstimatedUsage } from "./usageTracking.ts";
import { isTrustedEmptyStop } from "../services/errorClassifier.ts";

type ClaudeEmptyLifecycleLike = {
  hasError: boolean;
  hasContentBlock: boolean;
  hasMessageStart: boolean;
  hasMessageDelta: boolean;
  hasMessageStop: boolean;
  stopReason?: string | null;
  usage?: unknown;
};

const CLEAN_EMPTY_STOP_REASONS: Record<string, true> = {
  end_turn: true,
  stop_sequence: true,
  refusal: true,
};

/**
 * Claude SSE clean-stop policy, not a non-streaming or OpenAI exemption.
 * Translated Codex turns only reach a clean stop after stream.ts confirmed a
 * successful upstream Responses completion; estimated usage is never trusted.
 */
export function isCleanEmptyClaudeStop(
  stopReason: unknown,
  provider?: string | null,
  usage?: unknown
): boolean {
  if (provider === "antigravity" && isEstimatedUsage(usage)) return false;
  if (provider === "codex" && !isTrustedEmptyStop(provider, stopReason, usage)) return false;
  return typeof stopReason === "string" && CLEAN_EMPTY_STOP_REASONS[stopReason] === true;
}

export function shouldAbortEmptyClaudeStream(
  lifecycle: ClaudeEmptyLifecycleLike,
  sawAnyUpstreamPayload: boolean,
  provider?: string | null
): boolean {
  if (lifecycle.hasError || lifecycle.hasContentBlock) return false;
  if (
    sawAnyUpstreamPayload &&
    lifecycle.hasMessageStop &&
    isCleanEmptyClaudeStop(lifecycle.stopReason, provider, lifecycle.usage)
  ) {
    return false;
  }
  const hasPartialLifecycle =
    lifecycle.hasMessageStart || lifecycle.hasMessageDelta || lifecycle.hasMessageStop;
  return hasPartialLifecycle || !sawAnyUpstreamPayload;
}
