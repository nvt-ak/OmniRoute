/**
 * Model-name thinking-suffix parsing — TypeScript port of CLIProxyAPI
 * `internal/thinking/suffix.go` + `parseSuffixToConfig` (apply.go).
 *
 * Suffix format: `model-name[value]` (preferred) or `model-name(value)`, e.g.
 *   - "claude-sonnet-4-5[16384]" → modelName="claude-sonnet-4-5", rawSuffix="16384"
 *   - "pool-main-opus[high]"     → modelName="pool-main-opus", rawSuffix="high"
 *   - "gpt-5.2(high)"            → modelName="gpt-5.2", rawSuffix="high"
 *   - "gemini-2.5-pro"           → hasSuffix=false
 *
 * Square brackets `[...]` are the preferred delimiter because OmniRoute's combo
 * name validation (src/shared/validation/schemas/combo.ts) allows `[` and `]`
 * but rejects `(` and `)` — so a suffixed POOL name like "pool-main-opus[high]"
 * survives combo creation/lookup, whereas "pool-main-opus(high)" would not.
 * Round brackets `(...)` are still accepted for backward compatibility with
 * single-model requests (`claude-opus-4-8(high)`), matching the original
 * CLIProxyAPI syntax.
 */

import { emptyThinkingConfig, ThinkingMode } from "./types.ts";
import type { SuffixResult, ThinkingConfig } from "./types.ts";

/**
 * Extract a thinking suffix from a model name. Accepts either `[...]` (preferred)
 * or `(...)` (legacy); the string must END with the matching close bracket, and
 * the LAST matching open bracket is used. Only extraction — no content validation
 * here. Both delimiters are single characters, so downstream slice offsets that
 * assume a 1-char delimiter (thinkingSuffixVariant.ts) stay correct.
 */
export function parseSuffix(model: string): SuffixResult {
  if (typeof model !== "string") {
    return { modelName: model, hasSuffix: false, rawSuffix: "" };
  }

  // Prefer square brackets `[...]`; fall back to round brackets `(...)`.
  // Each candidate requires the string to end with its close bracket AND to
  // contain its open bracket, so a stray unmatched bracket never mis-parses.
  const delimiters: Array<{ open: string; close: string }> = [
    { open: "[", close: "]" },
    { open: "(", close: ")" },
  ];

  for (const { open, close } of delimiters) {
    if (!model.endsWith(close)) continue;
    const lastOpen = model.lastIndexOf(open);
    if (lastOpen === -1 || lastOpen >= model.length - 1) continue;
    return {
      modelName: model.slice(0, lastOpen),
      hasSuffix: true,
      rawSuffix: model.slice(lastOpen + 1, model.length - 1),
    };
  }

  return { modelName: model, hasSuffix: false, rawSuffix: "" };
}

/**
 * Parse a raw suffix as a non-negative integer budget. Leading zeros OK
 * ("08192"→8192); "0"→0; negatives rejected (→ null). "-1" is handled by
 * parseSpecialSuffix as auto, not here.
 */
export function parseNumericSuffix(rawSuffix: string): number | null {
  if (rawSuffix === "") return null;
  // Match Go strconv.Atoi semantics: whole string must be an integer.
  if (!/^[+-]?\d+$/.test(rawSuffix)) return null;
  const value = Number.parseInt(rawSuffix, 10);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

/**
 * Parse a raw suffix as a special mode: "none"→None, "auto"|"-1"→Auto.
 * Case-insensitive. Returns null if not special.
 */
export function parseSpecialSuffix(rawSuffix: string): ThinkingMode | null {
  if (rawSuffix === "") return null;
  switch (rawSuffix.toLowerCase()) {
    case "none":
      return ThinkingMode.None;
    case "auto":
    case "-1":
      return ThinkingMode.Auto;
    default:
      return null;
  }
}

const VALID_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Parse a raw suffix as a discrete level (minimal/low/medium/high/xhigh/max).
 * Case-insensitive. Special values (none/auto) and numerics return null.
 */
export function parseLevelSuffix(rawSuffix: string): string | null {
  if (rawSuffix === "") return null;
  const l = rawSuffix.toLowerCase();
  return VALID_LEVELS.has(l) ? l : null;
}

/**
 * Convert a raw suffix → ThinkingConfig. Priority (matches apply.go):
 *   1. special (none/auto/-1)
 *   2. level
 *   3. numeric (0 → none, else budget)
 *   4. no match → empty config
 */
export function parseSuffixToConfig(rawSuffix: string): ThinkingConfig {
  const special = parseSpecialSuffix(rawSuffix);
  if (special === ThinkingMode.None) {
    return { mode: ThinkingMode.None, budget: 0, level: "" };
  }
  if (special === ThinkingMode.Auto) {
    return { mode: ThinkingMode.Auto, budget: -1, level: "" };
  }

  const level = parseLevelSuffix(rawSuffix);
  if (level !== null) {
    return { mode: ThinkingMode.Level, budget: 0, level };
  }

  const budget = parseNumericSuffix(rawSuffix);
  if (budget !== null) {
    if (budget === 0) return { mode: ThinkingMode.None, budget: 0, level: "" };
    return { mode: ThinkingMode.Budget, budget, level: "" };
  }

  return emptyThinkingConfig();
}
