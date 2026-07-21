/**
 * Strip provider-native thinking fields when a no-thinking model receives a
 * thinking config — TypeScript port of CLIProxyAPI `internal/thinking/strip.go`.
 */

import { cloneBody, deletePath, pruneEmptyObject } from "./json.ts";

const STRIP_PATHS: Record<string, string[]> = {
  claude: ["thinking", "output_config.effort"],
  gemini: ["generationConfig.thinkingConfig"],
  antigravity: ["request.generationConfig.thinkingConfig"],
  interactions: [
    "generation_config.thinking_level",
    "generation_config.thinkingLevel",
    "generation_config.thinking_budget",
    "generation_config.thinkingBudget",
    "generation_config.thinking_summaries",
    "generation_config.thinkingSummaries",
    "generation_config.thinking_config",
    "generation_config.thinkingConfig",
  ],
  openai: ["reasoning_effort"],
  kimi: ["reasoning_effort", "thinking"],
  codex: ["reasoning.effort"],
  xai: ["reasoning.effort"],
};

/** Remove thinking fields for `provider`; returns a new body (input untouched). */
export function stripThinkingConfig(
  body: Record<string, unknown>,
  provider: string
): Record<string, unknown> {
  const paths = STRIP_PATHS[provider];
  if (!paths) return body;

  const result = cloneBody(body);
  for (const p of paths) deletePath(result, p);

  // Avoid leaving an empty output_config for Claude when effort was the only field.
  if (provider === "claude") pruneEmptyObject(result, "output_config");

  return result;
}
