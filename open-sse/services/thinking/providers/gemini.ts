/**
 * Gemini + Antigravity thinking appliers — TypeScript port of CLIProxyAPI
 * `internal/thinking/provider/gemini/apply.go` and `.../antigravity/apply.go`.
 * They share structure; antigravity prefixes paths with `request.` and adds
 * Claude-model budget normalization.
 *
 *  - len(levels) > 0 → thinkingLevel (Gemini 3.x)
 *  - else            → thinkingBudget (Gemini 2.5)
 */

import { cloneBody, deletePath, getInt, getPath, setPath } from "../json.ts";
import { isUserDefinedModel } from "../modelHelpers.ts";
import { ThinkingMode } from "../types.ts";
import type { ModelInfo, ProviderApplier, ThinkingConfig } from "../types.ts";

type Obj = Record<string, unknown>;

function getBool(body: Obj, path: string): boolean | undefined {
  const v = getPath(body, path);
  if (typeof v === "boolean") return v;
  return undefined;
}

class GeminiFamilyApplier implements ProviderApplier {
  constructor(
    private readonly prefix: string,
    private readonly antigravity: boolean
  ) {}

  private p(suffix: string): string {
    return `${this.prefix}.${suffix}`;
  }

  apply(body: Obj, config: ThinkingConfig, modelInfo: ModelInfo | null): Obj {
    const out = cloneBody(body);
    const isClaude = this.antigravity
      ? (modelInfo?.id ?? "").toLowerCase().includes("claude")
      : false;

    if (isUserDefinedModel(modelInfo)) {
      if (config.mode === ThinkingMode.Auto) return this.applyBudgetFormat(out, config, modelInfo, isClaude);
      if (config.mode === ThinkingMode.Level || (config.mode === ThinkingMode.None && config.level !== "")) {
        return this.applyLevelFormat(out, config);
      }
      return this.applyBudgetFormat(out, config, modelInfo, isClaude);
    }
    if (!modelInfo?.thinking) return out;

    switch (config.mode) {
      case ThinkingMode.Level:
        return this.applyLevelFormat(out, config);
      case ThinkingMode.None:
        if ((modelInfo.thinking.levels?.length ?? 0) > 0) return this.applyLevelFormat(out, config);
        return this.applyBudgetFormat(out, config, modelInfo, isClaude);
      case ThinkingMode.Budget:
      case ThinkingMode.Auto:
        return this.applyBudgetFormat(out, config, modelInfo, isClaude);
      default:
        return out;
    }
  }

  private applyLevelFormat(out: Obj, config: ThinkingConfig): Obj {
    // Read includeThoughts BEFORE deleting conflicting fields.
    const userInclude =
      getBool(out, this.p("thinkingConfig.includeThoughts")) ??
      getBool(out, this.p("thinkingConfig.include_thoughts"));

    deletePath(out, this.p("thinkingConfig.thinkingBudget"));
    deletePath(out, this.p("thinkingConfig.thinking_budget"));
    deletePath(out, this.p("thinkingConfig.thinking_level"));
    deletePath(out, this.p("thinkingConfig.include_thoughts"));

    if (config.mode === ThinkingMode.None) {
      if (config.budget === 0 && config.level === "") {
        deletePath(out, this.p("thinkingConfig"));
        return out;
      }
      setPath(out, this.p("thinkingConfig.includeThoughts"), false);
      if (config.level !== "") setPath(out, this.p("thinkingConfig.thinkingLevel"), config.level);
      return out;
    }

    if (config.mode !== ThinkingMode.Level) return out;

    setPath(out, this.p("thinkingConfig.thinkingLevel"), config.level);
    setPath(out, this.p("thinkingConfig.includeThoughts"), userInclude ?? true);
    return out;
  }

  private applyBudgetFormat(
    out: Obj,
    config: ThinkingConfig,
    modelInfo: ModelInfo | null,
    isClaude: boolean
  ): Obj {
    const userInclude =
      getBool(out, this.p("thinkingConfig.includeThoughts")) ??
      getBool(out, this.p("thinkingConfig.include_thoughts"));

    deletePath(out, this.p("thinkingConfig.thinkingLevel"));
    deletePath(out, this.p("thinkingConfig.thinking_level"));
    deletePath(out, this.p("thinkingConfig.thinking_budget"));
    deletePath(out, this.p("thinkingConfig.include_thoughts"));

    let budget = config.budget;

    if (this.antigravity && isClaude && modelInfo) {
      const res = this.normalizeClaudeBudget(budget, out, modelInfo);
      budget = res.budget;
      if (budget === -2) return out; // thinkingConfig removed
    }

    if (config.mode === ThinkingMode.None) {
      setPath(out, this.p("thinkingConfig.thinkingBudget"), budget);
      setPath(out, this.p("thinkingConfig.includeThoughts"), false);
      return out;
    }

    let includeThoughts: boolean;
    if (userInclude !== undefined) {
      includeThoughts = userInclude;
    } else if (config.mode === ThinkingMode.Auto) {
      includeThoughts = true;
    } else {
      includeThoughts = budget > 0;
    }

    setPath(out, this.p("thinkingConfig.thinkingBudget"), budget);
    setPath(out, this.p("thinkingConfig.includeThoughts"), includeThoughts);
    return out;
  }

  /** Antigravity Claude budget normalization; returns budget=-2 when config removed. */
  private normalizeClaudeBudget(
    budget: number,
    out: Obj,
    modelInfo: ModelInfo
  ): { budget: number } {
    const maxPath = `${this.prefix}.maxOutputTokens`;
    const reqMax = getInt(out, maxPath);
    let effectiveMax = 0;
    let fromModel = false;
    if (reqMax !== undefined && reqMax > 0) {
      effectiveMax = reqMax;
    } else if ((modelInfo.max_completion_tokens ?? 0) > 0) {
      effectiveMax = modelInfo.max_completion_tokens as number;
      fromModel = true;
    }

    let b = budget;
    if (effectiveMax > 0 && b >= effectiveMax) b = effectiveMax - 1;

    const minBudget = modelInfo.thinking?.min ?? 0;
    if (minBudget > 0 && b >= 0 && b < minBudget) {
      deletePath(out, this.p("thinkingConfig"));
      return { budget: -2 };
    }

    if (fromModel && effectiveMax > 0) setPath(out, maxPath, effectiveMax);
    return { budget: b };
  }
}

export class GeminiApplier extends GeminiFamilyApplier {
  constructor() {
    super("generationConfig", false);
  }
}

export class AntigravityApplier extends GeminiFamilyApplier {
  constructor() {
    super("request.generationConfig", true);
  }
}
