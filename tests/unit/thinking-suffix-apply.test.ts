import test from "node:test";
import assert from "node:assert/strict";

const { applyThinking } = await import("../../open-sse/services/thinking/apply.ts");

// ─── Claude (adaptive-thinking models: opus-4-8 has levels) ──────────────────

test("claude opus-4-8 (high) → adaptive + output_config.effort", () => {
  const out = applyThinking(
    { model: "claude-opus-4-8" },
    "claude-opus-4-8(high)",
    "claude",
    "claude",
    "claude"
  );
  assert.equal((out.thinking as Record<string, unknown>)?.type, "adaptive");
  assert.equal((out.output_config as Record<string, unknown>)?.effort, "high");
  // adaptive must not carry a fixed budget
  assert.equal((out.thinking as Record<string, unknown>)?.budget_tokens, undefined);
});

test("claude opus-4-8 (auto) → adaptive (no effort, upstream default)", () => {
  const out = applyThinking(
    { model: "claude-opus-4-8" },
    "claude-opus-4-8(auto)",
    "claude",
    "claude",
    "claude"
  );
  assert.equal((out.thinking as Record<string, unknown>)?.type, "adaptive");
  assert.equal((out.output_config as Record<string, unknown>)?.effort, undefined);
});

test("claude opus-4-8 (none) → disabled", () => {
  const out = applyThinking(
    { model: "claude-opus-4-8" },
    "claude-opus-4-8(none)",
    "claude",
    "claude",
    "claude"
  );
  assert.equal((out.thinking as Record<string, unknown>)?.type, "disabled");
});

test("claude opus-4-8 (16384) numeric → adaptive + effort (adaptive-only model)", () => {
  // opus-4-8 is level-only + dynamic (adaptive-only): a numeric budget is converted to the
  // nearest level (16384 → high) and written as adaptive + output_config.effort, NEVER as a
  // fixed budget_tokens (which Anthropic rejects with 400 for Opus 4.7+/Fable 5).
  const out = applyThinking(
    { model: "claude-opus-4-8", max_tokens: 40000 },
    "claude-opus-4-8(16384)",
    "claude",
    "claude",
    "claude"
  );
  assert.equal((out.thinking as Record<string, unknown>)?.type, "adaptive");
  assert.equal((out.output_config as Record<string, unknown>)?.effort, "high");
  assert.equal((out.thinking as Record<string, unknown>)?.budget_tokens, undefined);
});

test("adaptive-only claude models never emit a fixed budget_tokens", () => {
  for (const model of ["claude-opus-4-8", "claude-opus-4-7", "claude-fable-5", "claude-sonnet-5"]) {
    for (const suffix of ["high", "auto", "16384", "999999", "low"]) {
      const out = applyThinking({ model }, `${model}(${suffix})`, "claude", "claude", "claude");
      const t = out.thinking as Record<string, unknown> | undefined;
      assert.equal(t?.budget_tokens, undefined, `${model}(${suffix}) must not carry budget_tokens`);
      if (t?.type === "enabled") {
        assert.fail(`${model}(${suffix}) produced type=enabled (would 400 on Anthropic)`);
      }
    }
  }
});

// ─── Gemini (level for gemini-3 models; budget for 2.5) ──────────────────────

test("gemini-3.1-pro (high) → thinkingConfig.thinkingLevel", () => {
  const out = applyThinking(
    { model: "gemini-3-pro" },
    "gemini-3-pro(high)",
    "gemini",
    "gemini",
    "gemini"
  );
  const tc = (out.generationConfig as Record<string, unknown>)?.thinkingConfig as
    | Record<string, unknown>
    | undefined;
  assert.equal(tc?.thinkingLevel, "high");
  assert.equal(tc?.includeThoughts, true);
});

test("gemini-2.5-pro (8192) → thinkingConfig.thinkingBudget", () => {
  const out = applyThinking(
    { model: "gemini-2.5-pro" },
    "gemini-2.5-pro(8192)",
    "gemini",
    "gemini",
    "gemini"
  );
  const tc = (out.generationConfig as Record<string, unknown>)?.thinkingConfig as
    | Record<string, unknown>
    | undefined;
  assert.equal(tc?.thinkingBudget, 8192);
});

test("gemini-2.5-pro budget clamped to model max (32768)", () => {
  const out = applyThinking(
    { model: "gemini-2.5-pro" },
    "gemini-2.5-pro(999999)",
    "gemini",
    "gemini",
    "gemini"
  );
  const tc = (out.generationConfig as Record<string, unknown>)?.thinkingConfig as
    | Record<string, unknown>
    | undefined;
  assert.equal(tc?.thinkingBudget, 32768);
});

// ─── Codex / OpenAI (level-only, reasoning.effort / reasoning_effort) ────────

test("codex gpt-5.5 (high) → reasoning.effort", () => {
  const out = applyThinking({ model: "gpt-5.5" }, "gpt-5.5(high)", "codex", "codex", "codex-pro");
  assert.equal((out.reasoning as Record<string, unknown>)?.effort, "high");
});

// ─── Unknown model → user-defined passthrough (config applied directly) ──────

test("unknown model (high) is applied directly (user-defined)", () => {
  const out = applyThinking(
    { model: "my-custom-model" },
    "my-custom-model(high)",
    "claude",
    "claude",
    "claude"
  );
  // user-defined + claude → adaptive effort
  assert.equal((out.thinking as Record<string, unknown>)?.type, "adaptive");
  assert.equal((out.output_config as Record<string, unknown>)?.effort, "high");
});

// ─── No suffix, no body config → passthrough unchanged ───────────────────────

test("no suffix + no body thinking → unchanged", () => {
  const input = { model: "claude-opus-4-8", messages: [] };
  const out = applyThinking(input, "claude-opus-4-8", "claude", "claude", "claude");
  assert.equal(out.thinking, undefined);
});

// ─── Input body is not mutated ───────────────────────────────────────────────

test("applyThinking does not mutate the input body", () => {
  const input: Record<string, unknown> = { model: "claude-opus-4-8" };
  applyThinking(input, "claude-opus-4-8(high)", "claude", "claude", "claude");
  assert.equal(input.thinking, undefined);
  assert.equal(input.output_config, undefined);
});
