/**
 * Shared model-info helpers for the thinking module — ported from CLIProxyAPI
 * `internal/thinking/apply.go` (IsUserDefinedModel).
 */

import type { ModelInfo } from "./types.ts";

/**
 * True when the model should have its thinking config applied directly, without
 * capability validation. Unknown models (null) are treated as user-defined so the
 * upstream service validates — matching CLIProxyAPI behavior.
 */
export function isUserDefinedModel(modelInfo: ModelInfo | null): boolean {
  if (modelInfo == null) return true;
  return modelInfo.userDefined === true;
}
