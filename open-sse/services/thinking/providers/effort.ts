/**
 * Level-only effort appliers (OpenAI / Codex / xAI) — TypeScript port of
 * CLIProxyAPI `internal/thinking/provider/{openai,codex,xai}/apply.go`.
 * They differ only in the wire field: OpenAI writes `reasoning_effort`,
 * Codex/xAI write `reasoning.effort`.
 */

import { convertBudgetToLevel, hasLevel } from "../convert.ts";
import { cloneBody, setPath } from "../json.ts";
import { isUserDefinedModel } from "../modelHelpers.ts";
import { ThinkingMode } from "../types.ts";
import type { ModelInfo, ProviderApplier, ThinkingConfig } from "../types.ts";

type Obj = Record<string, unknown>;

class EffortApplier implements ProviderApplier {
  constructor(private readonly effortPath: string) {}

  apply(body: Obj, config: ThinkingConfig, modelInfo: ModelInfo | null): Obj {
    const out = cloneBody(body);

    if (isUserDefinedModel(modelInfo)) {
      return this.applyCompatible(out, config);
    }
    if (!modelInfo?.thinking) return out;

    // Only ModeLevel and ModeNone alter the body; others pass through.
    if (config.mode !== ThinkingMode.Level && config.mode !== ThinkingMode.None) return out;

    if (config.mode === ThinkingMode.Level) {
      setPath(out, this.effortPath, config.level);
      return out;
    }

    // ModeNone
    const support = modelInfo.thinking;
    let effort = "";
    if (config.budget === 0) {
      if (support.zero_allowed || hasLevel(support.levels, "none")) effort = "none";
    }
    if (effort === "" && config.level !== "") effort = config.level;
    if (effort === "" && (support.levels?.length ?? 0) > 0) effort = (support.levels as string[])[0];
    if (effort === "") return out;

    setPath(out, this.effortPath, effort);
    return out;
  }

  private applyCompatible(out: Obj, config: ThinkingConfig): Obj {
    let effort = "";
    switch (config.mode) {
      case ThinkingMode.Level:
        if (config.level === "") return out;
        effort = config.level;
        break;
      case ThinkingMode.None:
        effort = config.level !== "" ? config.level : "none";
        break;
      case ThinkingMode.Auto:
        effort = "auto";
        break;
      case ThinkingMode.Budget: {
        const level = convertBudgetToLevel(config.budget);
        if (level === null) return out;
        effort = level;
        break;
      }
      default:
        return out;
    }
    setPath(out, this.effortPath, effort);
    return out;
  }
}

export class OpenAIApplier extends EffortApplier {
  constructor() {
    super("reasoning_effort");
  }
}

/** Codex and xAI share the nested `reasoning.effort` field. */
export class CodexApplier extends EffortApplier {
  constructor() {
    super("reasoning.effort");
  }
}

export class XaiApplier extends EffortApplier {
  constructor() {
    super("reasoning.effort");
  }
}
