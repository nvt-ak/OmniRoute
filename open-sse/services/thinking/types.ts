/**
 * Unified thinking-configuration types — TypeScript port of CLIProxyAPI
 * `internal/thinking/types.go`.
 *
 * Canonical model of a request's thinking/reasoning intent, provider-agnostic.
 * A model-name suffix (`claude-opus-4-8(high)`, `(auto)`, `(16384)`) or the
 * request body is parsed into a {@link ThinkingConfig}, validated/clamped against
 * per-model capability (from models.json), then written into the provider-native
 * wire fields by a {@link ProviderApplier}.
 */

/** Thinking mode — mirrors CLIProxyAPI `ThinkingMode` (iota order preserved). */
export enum ThinkingMode {
  /** Numeric budget (Budget > 0). */
  Budget = 0,
  /** Discrete effort level (Level set). */
  Level = 1,
  /** Disabled (Budget = 0). */
  None = 2,
  /** Automatic / dynamic thinking (Budget = -1). */
  Auto = 3,
}

export function thinkingModeString(mode: ThinkingMode): string {
  switch (mode) {
    case ThinkingMode.Budget:
      return "budget";
    case ThinkingMode.Level:
      return "level";
    case ThinkingMode.None:
      return "none";
    case ThinkingMode.Auto:
      return "auto";
    default:
      return "unknown";
  }
}

/** Discrete thinking levels — mirrors CLIProxyAPI `ThinkingLevel`. */
export const ThinkingLevel = {
  None: "none",
  Auto: "auto",
  Minimal: "minimal",
  Low: "low",
  Medium: "medium",
  High: "high",
  XHigh: "xhigh",
  Max: "max",
} as const;

export type ThinkingLevelValue = (typeof ThinkingLevel)[keyof typeof ThinkingLevel];

/**
 * Canonical thinking configuration. Field-effectiveness contract (matches Go):
 *  - Mode=None  → budget = 0
 *  - Mode=Auto  → budget = -1
 *  - Mode=Budget→ budget > 0
 *  - Mode=Level → level set
 */
export interface ThinkingConfig {
  mode: ThinkingMode;
  /** Budget tokens. Positive for Budget; 0 = disabled; -1 = auto. */
  budget: number;
  /** Only for Mode=Level. */
  level: string;
}

/** Empty (zero-value) config == "no thinking config present". */
export function emptyThinkingConfig(): ThinkingConfig {
  return { mode: ThinkingMode.Budget, budget: 0, level: "" };
}

/** Result of parsing a model-name suffix `model(value)`. */
export interface SuffixResult {
  modelName: string;
  hasSuffix: boolean;
  rawSuffix: string;
}

/**
 * Provider applier — writes a validated {@link ThinkingConfig} into the request
 * body using that provider's wire-native field names. Must be idempotent and
 * must not mutate inputs beyond returning a new body object.
 */
export interface ProviderApplier {
  apply(
    body: Record<string, unknown>,
    config: ThinkingConfig,
    modelInfo: ModelInfo | null
  ): Record<string, unknown>;
}

/** Per-model thinking capability — mirrors registry `ThinkingSupport`. */
export interface ThinkingSupport {
  min?: number;
  max?: number;
  zero_allowed?: boolean;
  dynamic_allowed?: boolean;
  levels?: string[];
}

/** Subset of a models.json entry needed for thinking. Mirrors registry `ModelInfo`. */
export interface ModelInfo {
  id: string;
  type?: string;
  max_completion_tokens?: number;
  thinking?: ThinkingSupport | null;
  /** Set at lookup time (never from JSON) — unknown models are user-defined. */
  userDefined?: boolean;
}
