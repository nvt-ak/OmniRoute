/**
 * Kimi thinking applier — TypeScript port of CLIProxyAPI
 * `internal/thinking/provider/kimi/apply.go`. Kimi uses a native
 * `thinking.type` + `thinking.effort` object and drops legacy `reasoning_effort`.
 */

import { convertBudgetToLevel } from "../convert.ts";
import { cloneBody, deletePath, setPath } from "../json.ts";
import { isUserDefinedModel } from "../modelHelpers.ts";
import { ThinkingMode } from "../types.ts";
import type { ModelInfo, ProviderApplier, ThinkingConfig } from "../types.ts";

type Obj = Record<string, unknown>;

function applyEnabledThinking(out: Obj, effort: string): Obj {
  deletePath(out, "reasoning_effort");
  setPath(out, "thinking.type", "enabled");
  setPath(out, "thinking.effort", effort);
  return out;
}

function applyDisabledThinking(out: Obj): Obj {
  deletePath(out, "thinking");
  deletePath(out, "reasoning_effort");
  setPath(out, "thinking.type", "disabled");
  return out;
}

export class KimiApplier implements ProviderApplier {
  apply(body: Obj, config: ThinkingConfig, modelInfo: ModelInfo | null): Obj {
    const out = cloneBody(body);

    if (isUserDefinedModel(modelInfo)) {
      return this.applyCompatible(out, config);
    }
    if (!modelInfo?.thinking) return out;

    let effort = "";
    switch (config.mode) {
      case ThinkingMode.Level:
        if (config.level === "") return out;
        effort = config.level;
        break;
      case ThinkingMode.None:
        if (config.level !== "" && config.level !== "none") {
          effort = config.level;
          break;
        }
        return applyDisabledThinking(out);
      case ThinkingMode.Budget: {
        const level = convertBudgetToLevel(config.budget);
        if (level === null) return out;
        effort = level;
        break;
      }
      case ThinkingMode.Auto:
        effort = "auto";
        break;
      default:
        return out;
    }

    if (effort === "") return out;
    return applyEnabledThinking(out, effort);
  }

  private applyCompatible(out: Obj, config: ThinkingConfig): Obj {
    let effort = "";
    switch (config.mode) {
      case ThinkingMode.Level:
        if (config.level === "") return out;
        effort = config.level;
        break;
      case ThinkingMode.None:
        if (config.level === "" || config.level === "none") return applyDisabledThinking(out);
        effort = config.level;
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
    return applyEnabledThinking(out, effort);
  }
}
