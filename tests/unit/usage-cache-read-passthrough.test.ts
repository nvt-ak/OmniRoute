import test from "node:test";
import assert from "node:assert/strict";
import { filterUsageForFormat } from "../../open-sse/utils/usageTracking.ts";

// Regression: Claude→OpenAI streaming dropped prompt-cache read/write tokens.
//
// state.usage (set by extractUsage on Claude `message_start`/`message_delta`)
// is Claude-style flat: { prompt_tokens, completion_tokens,
// cache_read_input_tokens, cache_creation_input_tokens }.
//
// emitTranslatedClientItem overwrites the final chunk's usage with
// filterUsageForFormat(state.usage, "openai"). The OpenAI field whitelist only
// keeps prompt_tokens_details/cached_tokens — so without cross-mapping the
// Claude cache fields, opencode (which reads usage.prompt_tokens_details
// .cached_tokens) recorded cache_read = 0 for every OmniRoute request.

test("filterUsageForFormat(openai) — maps Claude cache_read into prompt_tokens_details.cached_tokens", () => {
  const claudeUsage = {
    prompt_tokens: 153452,
    completion_tokens: 3032,
    total_tokens: 156484,
    cache_read_input_tokens: 151865,
    cache_creation_input_tokens: 568,
  };

  const result = filterUsageForFormat(claudeUsage, "openai") as Record<string, unknown>;
  const details = result.prompt_tokens_details as Record<string, unknown> | undefined;

  assert.equal(result.prompt_tokens, 153452);
  assert.equal(result.completion_tokens, 3032);
  assert.ok(details, "prompt_tokens_details must be present when cache tokens exist");
  assert.equal(details!.cached_tokens, 151865);
  assert.equal(details!.cache_creation_tokens, 568);
});

test("filterUsageForFormat(openai) — flat cached_tokens still exposed for downstream billing", () => {
  const result = filterUsageForFormat(
    { prompt_tokens: 100, completion_tokens: 10, cache_read_input_tokens: 80 },
    "openai"
  ) as Record<string, unknown>;

  assert.equal(result.cached_tokens, 80);
  assert.equal((result.prompt_tokens_details as Record<string, unknown>).cached_tokens, 80);
});

test("filterUsageForFormat(openai) — no cache fields leaves prompt_tokens_details unset", () => {
  const result = filterUsageForFormat(
    { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    "openai"
  ) as Record<string, unknown>;

  assert.equal(result.prompt_tokens, 100);
  assert.equal(result.prompt_tokens_details, undefined);
  assert.equal(result.cached_tokens, undefined);
});

test("filterUsageForFormat(openai) — preexisting prompt_tokens_details is preserved", () => {
  const result = filterUsageForFormat(
    {
      prompt_tokens: 200,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 150 },
    },
    "openai"
  ) as Record<string, unknown>;

  assert.equal((result.prompt_tokens_details as Record<string, unknown>).cached_tokens, 150);
});

test("filterUsageForFormat(claude) — keeps native cache fields untouched", () => {
  const result = filterUsageForFormat(
    {
      input_tokens: 1587,
      output_tokens: 3032,
      cache_read_input_tokens: 151865,
      cache_creation_input_tokens: 568,
    },
    "claude"
  ) as Record<string, unknown>;

  assert.equal(result.cache_read_input_tokens, 151865);
  assert.equal(result.cache_creation_input_tokens, 568);
  // Claude format must NOT gain an OpenAI-only prompt_tokens_details field.
  assert.equal(result.prompt_tokens_details, undefined);
});
