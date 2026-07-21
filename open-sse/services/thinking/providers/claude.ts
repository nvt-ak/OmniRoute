/**
 * Claude thinking applier — TypeScript port of CLIProxyAPI
 * `internal/thinking/provider/claude/apply.go`.
 *
 * Claude supports two thinking styles:
 *  - manual:   thinking.type="enabled" + thinking.budget_tokens
 *  - adaptive: thinking.type="adaptive" + output_config.effort (models with levels)
 *  - disabled: thinking.type="disabled"
 */

import { convertLevelToBudget } from "../convert.ts";
import { cloneBody, deletePath, getInt, pruneEmptyObject, setPath } from "../json.ts";
import { isUserDefinedModel } from "../modelHelpers.ts";
import { ThinkingMode } from "../types.ts";
import type { ModelInfo, ProviderApplier, ThinkingConfig } from "../types.ts";

type Obj = Record<string, unknown>;

function setDisabled(body: Obj): Obj {
  setPath(body, "thinking.type", "disabled");
  deletePath(body, "thinking.budget_tokens");
  deletePath(body, "output_config.effort");
  pruneEmptyObject(body, "output_config");
  return body;
}

function effectiveMaxTokens(
  body: Obj,
  modelInfo: ModelInfo | null
): { max: number; fromModel: boolean } {
  const maxTok = getInt(body, "max_tokens");
  if (maxTok !== undefined && maxTok > 0) return { max: maxTok, fromModel: false };
  const modelMax = modelInfo?.max_completion_tokens ?? 0;
  if (modelMax > 0) return { max: modelMax, fromModel: true };
  return { max: 0, fromModel: false };
}

/** Ensure max_tokens > thinking.budget_tokens (Anthropic constraint). */
function normalizeClaudeBudget(body: Obj, budgetTokens: number, modelInfo: ModelInfo | null): Obj {
  if (budgetTokens <= 0) return body;

  const { max: effectiveMax, fromModel } = effectiveMaxTokens(body, modelInfo);
  if (fromModel && effectiveMax > 0) setPath(body, "max_tokens", effectiveMax);

  let adjusted = budgetTokens;
  if (effectiveMax > 0 && adjusted >= effectiveMax) adjusted = effectiveMax - 1;

  const minBudget = modelInfo?.thinking?.min ?? 0;
  if (minBudget > 0 && adjusted > 0 && adjusted < minBudget) return body;

  if (adjusted !== budgetTokens) setPath(body, "thinking.budget_tokens", adjusted);
  return body;
}

function applyCompatibleClaude(body: Obj, config: ThinkingConfig): Obj {
  switch (config.mode) {
    case ThinkingMode.None:
      return setDisabled(body);
    case ThinkingMode.Auto:
      setPath(body, "thinking.type", "enabled");
      deletePath(body, "thinking.budget_tokens");
      deletePath(body, "output_config.effort");
      pruneEmptyObject(body, "output_config");
      return body;
    case ThinkingMode.Level:
      if (config.level === "") return body;
      setPath(body, "thinking.type", "adaptive");
      deletePath(body, "thinking.budget_tokens");
      setPath(body, "output_config.effort", config.level);
      return body;
    default:
      setPath(body, "thinking.type", "enabled");
      setPath(body, "thinking.budget_tokens", config.budget);
      deletePath(body, "output_config.effort");
      pruneEmptyObject(body, "output_config");
      return body;
  }
}

export class ClaudeApplier implements ProviderApplier {
  apply(body: Obj, config: ThinkingConfig, modelInfo: ModelInfo | null): Obj {
    const out = cloneBody(body);

    if (isUserDefinedModel(modelInfo)) {
      return applyCompatibleClaude(out, config);
    }
    if (!modelInfo?.thinking) return out;

    const supportsAdaptive = (modelInfo.thinking.levels?.length ?? 0) > 0;
    const cfg: ThinkingConfig = { ...config };

    switch (cfg.mode) {
      case ThinkingMode.None:
        return setDisabled(out);

      case ThinkingMode.Level: {
        if (supportsAdaptive && cfg.level !== "") {
          setPath(out, "thinking.type", "adaptive");
          deletePath(out, "thinking.budget_tokens");
          setPath(out, "output_config.effort", cfg.level);
          return out;
        }
        // Fallback: level → budget for non-adaptive Claude.
        const budget = convertLevelToBudget(cfg.level);
        if (budget === null) return out;
        cfg.mode = ThinkingMode.Budget;
        cfg.budget = budget;
        cfg.level = "";
        // fall through to Budget
        return this.applyBudget(out, cfg, modelInfo);
      }

      case ThinkingMode.Budget:
        return this.applyBudget(out, cfg, modelInfo);

      case ThinkingMode.Auto:
        if (supportsAdaptive) {
          setPath(out, "thinking.type", "adaptive");
          deletePath(out, "thinking.budget_tokens");
          deletePath(out, "output_config.effort");
          pruneEmptyObject(out, "output_config");
          return out;
        }
        setPath(out, "thinking.type", "enabled");
        deletePath(out, "thinking.budget_tokens");
        deletePath(out, "output_config.effort");
        pruneEmptyObject(out, "output_config");
        return out;

      default:
        return out;
    }
  }

  private applyBudget(out: Obj, cfg: ThinkingConfig, modelInfo: ModelInfo | null): Obj {
    if (cfg.budget === 0) return setDisabled(out);
    setPath(out, "thinking.type", "enabled");
    setPath(out, "thinking.budget_tokens", cfg.budget);
    deletePath(out, "output_config.effort");
    pruneEmptyObject(out, "output_config");
    return normalizeClaudeBudget(out, cfg.budget, modelInfo);
  }
}
