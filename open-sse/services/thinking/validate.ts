/**
 * Validate + clamp a canonical {@link ThinkingConfig} against per-model
 * capability — TypeScript port of CLIProxyAPI `internal/thinking/validate.go`.
 */

import {
  convertBudgetToLevel,
  convertLevelToBudget,
  detectModelCapability,
  ModelCapability,
} from "./convert.ts";
import { ThinkingError } from "./errors.ts";
import { ThinkingMode } from "./types.ts";
import type { ModelInfo, ThinkingConfig, ThinkingSupport } from "./types.ts";

const STANDARD_LEVEL_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

function isGeminiFamily(provider: string): boolean {
  return provider === "gemini" || provider === "antigravity";
}
function isOpenAIFamily(provider: string): boolean {
  return provider === "openai" || provider === "openai-response" || provider === "codex";
}
function isSameProviderFamily(from: string, to: string): boolean {
  if (from === to) return true;
  return (
    (isGeminiFamily(from) && isGeminiFamily(to)) || (isOpenAIFamily(from) && isOpenAIFamily(to))
  );
}

function isLevelSupported(level: string, supported: string[] | undefined): boolean {
  if (!supported) return false;
  return supported.some((s) => s.trim().toLowerCase() === level.toLowerCase());
}

function levelIndex(level: string): number {
  return STANDARD_LEVEL_ORDER.findIndex((l) => l.toLowerCase() === level.toLowerCase());
}

function normalizeLevels(levels: string[]): string[] {
  return levels.map((l) => l.trim().toLowerCase());
}

/** Clamp a level to the nearest supported level; ties prefer the lower level. */
function clampLevel(level: string, modelInfo: ModelInfo | null): string {
  const supported = modelInfo?.thinking?.levels ?? [];
  if (supported.length === 0 || isLevelSupported(level, supported)) return level;

  const pos = levelIndex(level);
  if (pos === -1) return level;

  let bestIdx = -1;
  let bestDist = STANDARD_LEVEL_ORDER.length + 1;
  for (const s of supported) {
    const idx = levelIndex(s.trim());
    if (idx === -1) continue;
    const dist = Math.abs(pos - idx);
    if (dist < bestDist || (dist === bestDist && idx < bestIdx)) {
      bestIdx = idx;
      bestDist = dist;
    }
  }
  return bestIdx >= 0 ? STANDARD_LEVEL_ORDER[bestIdx] : level;
}

/** Clamp a budget to the model's supported range. */
function clampBudget(value: number, modelInfo: ModelInfo | null): number {
  const support = modelInfo?.thinking;
  if (!support) return value;
  if (value === -1) return value; // auto passes through

  const min = support.min ?? 0;
  const max = support.max ?? 0;

  if (value === 0 && !support.zero_allowed) return min;
  if (min === 0 && max === 0) return value; // level-only, no numeric range
  if (value < min) {
    if (value === 0 && support.zero_allowed) return 0;
    return min;
  }
  if (value > max) return max;
  return value;
}

/** Auto → mid-range fallback when the model does not allow dynamic thinking. */
function convertAutoToMidRange(config: ThinkingConfig, support: ThinkingSupport): ThinkingConfig {
  const min = support.min ?? 0;
  const max = support.max ?? 0;
  const levels = support.levels ?? [];

  // Level-only model → medium level.
  if (levels.length > 0 && min === 0 && max === 0) {
    return { mode: ThinkingMode.Level, budget: 0, level: "medium" };
  }

  const mid = Math.trunc((min + max) / 2);
  if (mid <= 0 && support.zero_allowed) {
    return { mode: ThinkingMode.None, budget: 0, level: config.level };
  }
  if (mid <= 0) {
    return { mode: ThinkingMode.Budget, budget: min, level: config.level };
  }
  return { mode: ThinkingMode.Budget, budget: mid, level: config.level };
}

/**
 * Validate a config against a model's ThinkingSupport, converting/clamping as
 * needed. Throws {@link ThinkingError} on unsupported level/budget in strict
 * mode. `fromSuffix` disables strict budget validation (clamp instead of error).
 */
export function validateConfig(
  input: ThinkingConfig,
  modelInfo: ModelInfo | null,
  fromFormat: string,
  toFormat: string,
  fromSuffix: boolean
): ThinkingConfig {
  const from = fromFormat.trim().toLowerCase();
  const to = toFormat.trim().toLowerCase();
  const model = modelInfo?.id || "unknown";
  const support = modelInfo?.thinking ?? null;

  // Work on a copy.
  const config: ThinkingConfig = { ...input };

  if (support == null) {
    if (config.mode !== ThinkingMode.None) {
      throw new ThinkingError(
        "THINKING_NOT_SUPPORTED",
        "thinking not supported for this model",
        model
      );
    }
    return config;
  }

  const toCapability = detectModelCapability(modelInfo);
  const toHasLevelSupport =
    toCapability === ModelCapability.LevelOnly || toCapability === ModelCapability.Hybrid;

  let modelFamilyMismatch = false;
  const modelType = (modelInfo?.type ?? "").trim().toLowerCase();
  if (modelType) {
    if (
      (from !== "" && !isSameProviderFamily(from, modelType)) ||
      (to !== "" && !isSameProviderFamily(to, modelType))
    ) {
      modelFamilyMismatch = true;
    }
  }
  const allowClampUnsupported =
    toHasLevelSupport && (!isSameProviderFamily(from, to) || modelFamilyMismatch);

  const strictBudget =
    !fromSuffix && from !== "" && isSameProviderFamily(from, to) && !modelFamilyMismatch;
  let budgetDerivedFromLevel = false;

  const capability = detectModelCapability(modelInfo);
  if (capability === ModelCapability.BudgetOnly) {
    if (config.mode === ThinkingMode.Level && config.level !== "auto") {
      const budget = convertLevelToBudget(config.level);
      if (budget === null) {
        throw new ThinkingError("UNKNOWN_LEVEL", `unknown level: ${config.level}`);
      }
      config.mode = ThinkingMode.Budget;
      config.budget = budget;
      config.level = "";
      budgetDerivedFromLevel = true;
    }
  } else if (capability === ModelCapability.LevelOnly) {
    if (config.mode === ThinkingMode.Budget) {
      const level = convertBudgetToLevel(config.budget);
      if (level === null) {
        throw new ThinkingError(
          "UNKNOWN_LEVEL",
          `budget ${config.budget} cannot be converted to a valid level`
        );
      }
      config.mode = ThinkingMode.Level;
      config.level = clampLevel(level, modelInfo);
      config.budget = 0;
    }
  }

  // Special-value normalization.
  if (config.mode === ThinkingMode.Level && config.level === "none") {
    config.mode = ThinkingMode.None;
    config.budget = 0;
    config.level = "";
  }
  if (config.mode === ThinkingMode.Level && config.level === "auto") {
    config.mode = ThinkingMode.Auto;
    config.budget = -1;
    config.level = "";
  }
  if (config.mode === ThinkingMode.Budget && config.budget === 0) {
    config.mode = ThinkingMode.None;
    config.level = "";
  }

  // Level validation.
  if ((support.levels?.length ?? 0) > 0 && config.mode === ThinkingMode.Level) {
    if (!isLevelSupported(config.level, support.levels)) {
      if (allowClampUnsupported) {
        config.level = clampLevel(config.level, modelInfo);
      }
      if (!isLevelSupported(config.level, support.levels)) {
        const validLevels = normalizeLevels(support.levels ?? []);
        throw new ThinkingError(
          "LEVEL_NOT_SUPPORTED",
          `level "${config.level.toLowerCase()}" not supported, valid levels: ${validLevels.join(", ")}`
        );
      }
    }
  }

  // Strict budget range.
  if (strictBudget && config.mode === ThinkingMode.Budget && !budgetDerivedFromLevel) {
    const min = support.min ?? 0;
    const max = support.max ?? 0;
    if (min !== 0 || max !== 0) {
      if (
        config.budget < min ||
        config.budget > max ||
        (config.budget === 0 && !support.zero_allowed)
      ) {
        throw new ThinkingError(
          "BUDGET_OUT_OF_RANGE",
          `budget ${config.budget} out of range [${min},${max}]`
        );
      }
    }
  }

  // Auto → mid-range if dynamic not allowed.
  if (config.mode === ThinkingMode.Auto && !support.dynamic_allowed) {
    const converted = convertAutoToMidRange(config, support);
    config.mode = converted.mode;
    config.budget = converted.budget;
    config.level = converted.level;
    if (
      config.mode === ThinkingMode.Level &&
      (support.levels?.length ?? 0) > 0 &&
      !isLevelSupported(config.level, support.levels)
    ) {
      config.level = clampLevel(config.level, modelInfo);
    }
  }

  if (config.mode === ThinkingMode.None && to === "claude") {
    config.budget = 0;
    config.level = "";
  } else {
    if (
      config.mode === ThinkingMode.Budget ||
      config.mode === ThinkingMode.Auto ||
      config.mode === ThinkingMode.None
    ) {
      config.budget = clampBudget(config.budget, modelInfo);
    }

    const cannotDisableLevelModel =
      !support.zero_allowed && !isLevelSupported("none", support.levels);
    if (
      config.mode === ThinkingMode.None &&
      (support.levels?.length ?? 0) > 0 &&
      (config.budget > 0 || cannotDisableLevelModel)
    ) {
      config.level = (support.levels ?? [])[0];
    }
  }

  return config;
}
