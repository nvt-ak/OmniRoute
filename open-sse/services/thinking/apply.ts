/**
 * Unified thinking entry point — TypeScript port of CLIProxyAPI
 * `internal/thinking/apply.go` `ApplyThinking`.
 *
 * Flow: route check → parse suffix → lookup model → capability check →
 * get config (suffix priority over body) → validate/clamp → provider apply.
 *
 * On any validation failure the ORIGINAL body is returned (defensive) — the
 * upstream service decides how to handle an unmodified request.
 */

import { convertLevelToBudget } from "./convert.ts";
import { extractThinkingConfig, hasThinkingConfig } from "./extract.ts";
import { cloneBody } from "./json.ts";
import { isUserDefinedModel } from "./modelHelpers.ts";
import { lookupModelInfo } from "./registry.ts";
import { stripThinkingConfig } from "./strip.ts";
import { parseSuffix, parseSuffixToConfig } from "./suffix.ts";
import { ThinkingMode } from "./types.ts";
import type { ModelInfo, ProviderApplier, SuffixResult, ThinkingConfig } from "./types.ts";
import { validateConfig } from "./validate.ts";

import { ClaudeApplier } from "./providers/claude.ts";
import { AntigravityApplier, GeminiApplier } from "./providers/gemini.ts";
import { CodexApplier, OpenAIApplier, XaiApplier } from "./providers/effort.ts";
import { KimiApplier } from "./providers/kimi.ts";

type Obj = Record<string, unknown>;

const PROVIDER_APPLIERS: Record<string, ProviderApplier> = {
  claude: new ClaudeApplier(),
  gemini: new GeminiApplier(),
  antigravity: new AntigravityApplier(),
  openai: new OpenAIApplier(),
  codex: new CodexApplier(),
  xai: new XaiApplier(),
  kimi: new KimiApplier(),
};

function getProviderApplier(provider: string): ProviderApplier | null {
  return PROVIDER_APPLIERS[provider.trim().toLowerCase()] ?? null;
}

/** Which providers accept a numeric budget (also may support levels). */
function isBudgetCapableProvider(provider: string): boolean {
  return provider === "gemini" || provider === "antigravity" || provider === "claude";
}

function normalizeUserDefinedConfig(
  config: ThinkingConfig,
  toFormat: string
): ThinkingConfig {
  if (config.mode !== ThinkingMode.Level) return config;
  if (toFormat === "claude") return config;
  if (!isBudgetCapableProvider(toFormat)) return config;
  const budget = convertLevelToBudget(config.level);
  if (budget === null) return config;
  return { mode: ThinkingMode.Budget, budget, level: "" };
}

function applyUserDefinedModel(
  body: Obj,
  modelInfo: ModelInfo | null,
  fromFormat: string,
  toFormat: string,
  suffixResult: SuffixResult
): Obj {
  let config: ThinkingConfig;
  if (suffixResult.hasSuffix) {
    config = parseSuffixToConfig(suffixResult.rawSuffix);
  } else {
    config = extractThinkingConfig(body, fromFormat);
    if (!hasThinkingConfig(config) && fromFormat !== toFormat) {
      config = extractThinkingConfig(body, toFormat);
    }
  }

  if (!hasThinkingConfig(config)) return body;

  const applier = getProviderApplier(toFormat);
  if (!applier) return body;

  config = normalizeUserDefinedConfig(config, toFormat);
  return applier.apply(body, config, modelInfo);
}

/**
 * Apply thinking configuration to a request body.
 *
 * @param body       Request body (already translated to `toFormat`).
 * @param model      Requested model, possibly with a `(suffix)`.
 * @param fromFormat Source request format (for validation strictness).
 * @param toFormat   Target/provider wire format (picks the applier + fields).
 * @param providerKey Registry lookup key (defaults to `toFormat`).
 * @returns A new body (input untouched). On unknown provider / no config /
 *          validation failure returns the input unchanged.
 */
export function applyThinking(
  body: Obj,
  model: string,
  fromFormat: string,
  toFormat: string,
  providerKey?: string
): Obj {
  const to = (toFormat ?? "").trim().toLowerCase();
  let key = (providerKey ?? "").trim().toLowerCase();
  if (key === "") key = to;
  let from = (fromFormat ?? "").trim().toLowerCase();
  if (from === "") from = to;

  // 1. Route check.
  const applier = getProviderApplier(to);
  if (!applier) return body;

  // 2. Parse suffix + lookup model.
  const suffixResult = parseSuffix(model);
  const baseModel = suffixResult.modelName;
  const modelInfo = lookupModelInfo(baseModel, key);

  const src = cloneBody(body);

  // 3. Capability check.
  if (isUserDefinedModel(modelInfo)) {
    return applyUserDefinedModel(src, modelInfo, from, to, suffixResult);
  }
  if (!modelInfo?.thinking) {
    const config = extractThinkingConfig(src, to);
    if (hasThinkingConfig(config)) return stripThinkingConfig(src, to);
    return body;
  }

  // 4. Get config: suffix priority over body.
  let config: ThinkingConfig;
  if (suffixResult.hasSuffix) {
    config = parseSuffixToConfig(suffixResult.rawSuffix);
  } else {
    config = extractThinkingConfig(src, to);
  }
  if (!hasThinkingConfig(config)) return body;

  // 5. Validate / normalize.
  let validated: ThinkingConfig;
  try {
    validated = validateConfig(config, modelInfo, from, to, suffixResult.hasSuffix);
  } catch {
    // Defensive: return original body on validation failure.
    return body;
  }

  // 6. Apply.
  return applier.apply(src, validated, modelInfo);
}

/** True when a model name carries a thinking suffix `(...)`. */
export function hasThinkingSuffix(model: string): boolean {
  return parseSuffix(model).hasSuffix;
}

/** Strip a thinking suffix from a model name, returning the base model. */
export function stripThinkingSuffix(model: string): string {
  return parseSuffix(model).modelName;
}
