/**
 * chatCore thinking-suffix injector (CLIProxyAPI `internal/thinking` port, #thinking-suffix).
 *
 * Generalizes `applyClaudeEffortVariant` to all providers: a model-name suffix
 * (`pool-main-opus[high]`, `[auto]`, `[16384]`, or the legacy `claude-opus-4-8(high)`)
 * is parsed, validated against per-model capability (models.json), and injected
 * into the request body as the provider-native thinking config for the resolved
 * target format — then the suffix is stripped off `body.model` / the returned
 * `effectiveModel`. Square brackets are preferred because OmniRoute combo names
 * reject `(`/`)` but allow `[`/`]`; round brackets stay accepted for single models.
 *
 * Two-point wiring (pools fan out one `handleChatCore` per target):
 *  - Point 1 (chat.ts, before combo lookup): the suffix is stripped off the pool
 *    name so the combo name still matches, and the raw suffix is stashed on the
 *    body via {@link THINKING_SUFFIX_MARKER} so it survives down to each target.
 *  - Point 2 (here, once per target): the stashed suffix (or a suffix on a bare
 *    single-model request) is re-attached to the resolved target model and run
 *    through `applyThinking`, so each target gets its own provider-correct config.
 *
 * Runs BEFORE the `summarizeThinking` display patch (chatCore.ts), so once
 * thinking is enabled that patch can add `display:"summarized"`.
 */

import { applyThinking, hasThinkingSuffix, stripThinkingSuffix } from "../../services/thinking/apply.ts";

/** Hidden body marker carrying the raw thinking suffix from Point 1 → Point 2. */
export const THINKING_SUFFIX_MARKER = "_omnirouteThinkingSuffix";

/**
 * Point 1 helper: split a `[suffix]`/`(suffix)` off a model string. Returns the base model
 * (suffix stripped) plus the raw suffix (empty when none). Stateless — the caller
 * stashes `rawSuffix` on the body and uses `baseModel` for combo/routing lookup.
 */
export function splitThinkingSuffix(modelStr: string): { baseModel: string; rawSuffix: string } {
  if (typeof modelStr !== "string" || !hasThinkingSuffix(modelStr)) {
    return { baseModel: modelStr, rawSuffix: "" };
  }
  const base = stripThinkingSuffix(modelStr);
  // rawSuffix is the text between the final delimiter pair ([ ] or ( )) — recover
  // it from the length difference (both delimiters are single characters).
  const rawSuffix = modelStr.slice(base.length + 1, modelStr.length - 1);
  return { baseModel: base, rawSuffix };
}

/**
 * Point 2: inject thinking config for a single resolved target. Reads a suffix
 * from (a) the stashed marker (pool path) or (b) `effectiveModel` itself
 * (bare single-model path), applies it for the target's format, strips the
 * suffix, and returns the base `effectiveModel`. Mutates `body` in place.
 */
export function applyThinkingSuffixVariant(opts: {
  provider: string | null | undefined;
  effectiveModel: string;
  /** Mutated in place: thinking config injected, marker removed. */
  body: unknown;
  sourceFormat: string;
  targetFormat: string;
}): { effectiveModel: string; log: string | null } {
  let effectiveModel = opts.effectiveModel;
  const { body, sourceFormat, targetFormat } = opts;

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { effectiveModel, log: null };
  }
  const bodyObj = body as Record<string, unknown>;

  // Recover the raw suffix: prefer the stashed pool marker, else a suffix on the
  // target model string itself.
  let rawSuffix = "";
  const marker = bodyObj[THINKING_SUFFIX_MARKER];
  if (typeof marker === "string" && marker !== "") {
    rawSuffix = marker;
  } else if (typeof effectiveModel === "string" && hasThinkingSuffix(effectiveModel)) {
    rawSuffix = effectiveModel.slice(
      stripThinkingSuffix(effectiveModel).length + 1,
      effectiveModel.length - 1
    );
  }

  // Always clear the marker so it never leaks upstream.
  delete bodyObj[THINKING_SUFFIX_MARKER];

  if (rawSuffix === "" || typeof effectiveModel !== "string") {
    // Still strip a bare suffix off the model if present (defensive).
    if (typeof effectiveModel === "string") {
      const base = stripThinkingSuffix(effectiveModel);
      if (base !== effectiveModel) {
        effectiveModel = base;
        bodyObj.model = base;
      }
    }
    return { effectiveModel, log: null };
  }

  const baseModel = stripThinkingSuffix(effectiveModel);
  const modelWithSuffix = `${baseModel}[${rawSuffix}]`;

  const before = JSON.stringify(bodyObj.thinking ?? null);
  const updated = applyThinking(
    bodyObj,
    modelWithSuffix,
    sourceFormat,
    targetFormat,
    opts.provider ?? targetFormat
  );

  // Copy applyThinking's result back into the same body object (mutate in place),
  // replacing thinking-related keys wholesale.
  for (const key of Object.keys(bodyObj)) {
    if (!(key in updated)) delete bodyObj[key];
  }
  Object.assign(bodyObj, updated);

  // Strip the suffix off the model sent upstream.
  effectiveModel = baseModel;
  bodyObj.model = baseModel;

  const after = JSON.stringify(bodyObj.thinking ?? null);
  const log =
    before === after
      ? null
      : `Thinking suffix: [${rawSuffix}] → ${baseModel} (${targetFormat}) thinking=${after}`;
  return { effectiveModel, log };
}
