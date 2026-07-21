/**
 * Level ⇄ budget conversion + model-capability detection — TypeScript port of
 * CLIProxyAPI `internal/thinking/convert.go`.
 */

import type { ModelInfo } from "./types.ts";

/**
 * Standard Level → Budget mapping. Keys lowercase; lookups lowercase first.
 * `max` maps to a large budget and relies on per-model clamping when converting
 * to budget-only providers.
 */
const levelToBudgetMap: Record<string, number> = {
  none: 0,
  auto: -1,
  minimal: 512,
  low: 1024,
  medium: 8192,
  high: 24576,
  xhigh: 32768,
  max: 128000,
};

/** Convert a thinking level → budget. Case-insensitive. Returns null if invalid. */
export function convertLevelToBudget(level: string): number | null {
  const budget = levelToBudgetMap[level.toLowerCase()];
  return budget === undefined ? null : budget;
}

// Upper bounds for each level, used by convertBudgetToLevel.
const THRESHOLD_MINIMAL = 512;
const THRESHOLD_LOW = 1024;
const THRESHOLD_MEDIUM = 8192;
const THRESHOLD_HIGH = 24576;

/**
 * Convert a budget → nearest thinking level (threshold-based).
 * Returns null for invalid negatives (< -1).
 *   -1 → auto, 0 → none, 1..512 → minimal, 513..1024 → low,
 *   1025..8192 → medium, 8193..24576 → high, 24577+ → xhigh
 */
export function convertBudgetToLevel(budget: number): string | null {
  if (budget < -1) return null;
  if (budget === -1) return "auto";
  if (budget === 0) return "none";
  if (budget <= THRESHOLD_MINIMAL) return "minimal";
  if (budget <= THRESHOLD_LOW) return "low";
  if (budget <= THRESHOLD_MEDIUM) return "medium";
  if (budget <= THRESHOLD_HIGH) return "high";
  return "xhigh";
}

/** Case-insensitive, trimmed membership test. */
export function hasLevel(levels: string[] | undefined, target: string): boolean {
  if (!levels) return false;
  const t = target.trim().toLowerCase();
  return levels.some((lvl) => lvl.trim().toLowerCase() === t);
}

/**
 * Map a generic level → Claude adaptive effort (low/medium/high/max).
 * `supportsMax` toggles whether xhigh/max collapse to "max" or "high".
 * Present for parity with CLIProxy; the Claude applier writes the level directly.
 */
export function mapToClaudeEffort(level: string, supportsMax: boolean): string | null {
  const l = level.trim().toLowerCase();
  switch (l) {
    case "":
      return null;
    case "minimal":
      return "low";
    case "low":
    case "medium":
    case "high":
      return l;
    case "xhigh":
    case "max":
      return supportsMax ? "max" : "high";
    case "auto":
      return "high";
    default:
      return null;
  }
}

/** Thinking-format capability of a model. */
export enum ModelCapability {
  /** modelInfo is null (passthrough sentinel). */
  Unknown = -1,
  /** No thinking support (thinking is null/absent). */
  None = 0,
  /** Numeric budgets only (Claude older, Gemini 2.5). */
  BudgetOnly = 1,
  /** Discrete levels only (OpenAI, Codex, Kimi). */
  LevelOnly = 2,
  /** Both budgets and levels (Gemini 3, Claude 4.6+). */
  Hybrid = 3,
}

/** Classify a model's thinking capability. */
export function detectModelCapability(modelInfo: ModelInfo | null): ModelCapability {
  if (modelInfo == null) return ModelCapability.Unknown;
  const support = modelInfo.thinking;
  if (support == null) return ModelCapability.None;
  const hasBudget = (support.min ?? 0) > 0 || (support.max ?? 0) > 0;
  const hasLevels = (support.levels?.length ?? 0) > 0;
  if (hasBudget && hasLevels) return ModelCapability.Hybrid;
  if (hasBudget) return ModelCapability.BudgetOnly;
  if (hasLevels) return ModelCapability.LevelOnly;
  return ModelCapability.None;
}
