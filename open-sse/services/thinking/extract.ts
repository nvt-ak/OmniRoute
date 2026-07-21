/**
 * Per-format extraction of a canonical {@link ThinkingConfig} from a request
 * body — TypeScript port of the `extract*Config` functions in CLIProxyAPI
 * `internal/thinking/apply.go`.
 */

import { getInt, getString, hasPath } from "./json.ts";
import { emptyThinkingConfig, ThinkingMode } from "./types.ts";
import type { ThinkingConfig } from "./types.ts";

/** True when a config carries real intent (not the zero value). */
export function hasThinkingConfig(config: ThinkingConfig): boolean {
  return config.mode !== ThinkingMode.Budget || config.budget !== 0 || config.level !== "";
}

function noneConfig(): ThinkingConfig {
  return { mode: ThinkingMode.None, budget: 0, level: "" };
}
function autoConfig(): ThinkingConfig {
  return { mode: ThinkingMode.Auto, budget: -1, level: "" };
}
function levelConfig(level: string): ThinkingConfig {
  return { mode: ThinkingMode.Level, budget: 0, level };
}
function budgetConfig(budget: number): ThinkingConfig {
  return { mode: ThinkingMode.Budget, budget, level: "" };
}

function budgetToConfig(value: number): ThinkingConfig {
  if (value === 0) return noneConfig();
  if (value === -1) return autoConfig();
  return budgetConfig(value);
}

/** Claude: thinking.type / output_config.effort / thinking.budget_tokens. */
export function extractClaudeConfig(body: unknown): ThinkingConfig {
  const thinkingType = getString(body, "thinking.type");
  if (thinkingType === "disabled") return noneConfig();

  if (thinkingType === "adaptive" || thinkingType === "auto") {
    const effortRaw = getString(body, "output_config.effort");
    if (effortRaw !== undefined) {
      const value = effortRaw.trim().toLowerCase();
      if (value === "") return emptyThinkingConfig();
      if (value === "none") return noneConfig();
      if (value === "auto") return autoConfig();
      return levelConfig(value);
    }
    return emptyThinkingConfig();
  }

  const budget = getInt(body, "thinking.budget_tokens");
  if (budget !== undefined) return budgetToConfig(budget);

  if (thinkingType === "enabled") return autoConfig();
  return emptyThinkingConfig();
}

/** Gemini / Antigravity: generationConfig.thinkingConfig.{thinkingLevel|thinkingBudget}. */
export function extractGeminiConfig(body: unknown, provider: string): ThinkingConfig {
  const prefix =
    provider === "antigravity"
      ? "request.generationConfig.thinkingConfig"
      : "generationConfig.thinkingConfig";

  const level = getString(body, `${prefix}.thinkingLevel`) ?? getString(body, `${prefix}.thinking_level`);
  if (level !== undefined) {
    const value = level;
    if (value === "none") return noneConfig();
    if (value === "auto") return autoConfig();
    return levelConfig(value);
  }

  const budget =
    getInt(body, `${prefix}.thinkingBudget`) ?? getInt(body, `${prefix}.thinking_budget`);
  if (budget !== undefined) return budgetToConfig(budget);

  return emptyThinkingConfig();
}

/** OpenAI Chat Completions: reasoning_effort. */
export function extractOpenAIConfig(body: unknown): ThinkingConfig {
  const effort = getString(body, "reasoning_effort");
  if (effort !== undefined) {
    if (effort === "none") return noneConfig();
    return levelConfig(effort);
  }
  return emptyThinkingConfig();
}

/** Codex / xAI (OpenAI Responses API): reasoning.effort. */
export function extractCodexConfig(body: unknown): ThinkingConfig {
  const effort = getString(body, "reasoning.effort");
  if (effort !== undefined) {
    if (effort === "none") return noneConfig();
    return levelConfig(effort);
  }
  return emptyThinkingConfig();
}

/** Kimi: native thinking object precedence, reasoning_effort fallback. */
export function extractKimiConfig(body: unknown): ThinkingConfig {
  const hasType = hasPath(body, "thinking.type");
  if (hasType) {
    const t = (getString(body, "thinking.type") ?? "").trim().toLowerCase();
    if (t === "disabled") return noneConfig();
    if (t === "enabled" && !hasPath(body, "thinking.effort")) {
      return emptyThinkingConfig();
    }
  }

  if (hasPath(body, "thinking.effort")) {
    const value = (getString(body, "thinking.effort") ?? "").trim().toLowerCase();
    if (value === "") return emptyThinkingConfig();
    if (value === "none") return noneConfig();
    if (value === "auto") return autoConfig();
    return levelConfig(value);
  }

  // Native thinking object without effort → leave for upstream.
  if (hasType) return emptyThinkingConfig();

  return extractOpenAIConfig(body);
}

/** Interactions: generation_config.thinking_level / thinking_budget (many variants). */
export function extractInteractionsConfig(body: unknown): ThinkingConfig {
  const levelPaths = [
    "generation_config.thinking_level",
    "generation_config.thinkingLevel",
    "generation_config.thinking_config.thinking_level",
    "generation_config.thinking_config.thinkingLevel",
    "generation_config.thinkingConfig.thinking_level",
    "generation_config.thinkingConfig.thinkingLevel",
  ];
  for (const p of levelPaths) {
    const raw = getString(body, p);
    if (raw === undefined) continue;
    const value = raw.trim().toLowerCase();
    if (value === "none") return noneConfig();
    if (value === "auto") return autoConfig();
    return levelConfig(value);
  }

  const budgetPaths = [
    "generation_config.thinking_budget",
    "generation_config.thinkingBudget",
    "generation_config.thinking_config.thinking_budget",
    "generation_config.thinking_config.thinkingBudget",
    "generation_config.thinkingConfig.thinking_budget",
    "generation_config.thinkingConfig.thinkingBudget",
  ];
  for (const p of budgetPaths) {
    const value = getInt(body, p);
    if (value === undefined) continue;
    return budgetToConfig(value);
  }

  return emptyThinkingConfig();
}

/** Dispatch by provider/format (matches apply.go extractThinkingConfig). */
export function extractThinkingConfig(body: unknown, provider: string): ThinkingConfig {
  switch (provider) {
    case "claude":
      return extractClaudeConfig(body);
    case "gemini":
    case "antigravity":
      return extractGeminiConfig(body, provider);
    case "interactions":
      return extractInteractionsConfig(body);
    case "openai":
      return extractOpenAIConfig(body);
    case "codex":
    case "xai":
      return extractCodexConfig(body);
    case "kimi":
      return extractKimiConfig(body);
    default:
      return emptyThinkingConfig();
  }
}
