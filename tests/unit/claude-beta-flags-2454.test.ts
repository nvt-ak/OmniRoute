import test from "node:test";
import assert from "node:assert/strict";

const { selectBetaFlags } = await import("../../open-sse/executors/claudeIdentity.ts");

// Regression for #2454: Haiku with OAuth rejects `context-1m-2025-08-07` with
// 400 "This authentication style is incompatible with the long context beta header".
// The heavy-agent beta tier (effort, advanced-tool-use) must be gated on
// Opus/Sonnet only; Haiku still receives the general full-agent flags.
// context-1m is Opus-only in captured Claude Code traffic.

function fullAgentBody(model: string) {
  return {
    model,
    system: "You are a coding agent.",
    tools: [{ name: "read_file", description: "x", input_schema: { type: "object" } }],
  };
}

test("#2454 Haiku full-agent omits heavy-agent beta flags", () => {
  const flags = selectBetaFlags(fullAgentBody("claude-haiku-4-5-20251001"));
  assert.ok(!flags.includes("context-1m-2025-08-07"), "Haiku must NOT receive context-1m");
  assert.ok(!flags.includes("afk-mode-2026-01-31"), "afk-mode removed — not in any CC capture");
  assert.ok(!flags.includes("effort-2025-11-24"), "Haiku must NOT receive effort");
  assert.ok(
    !flags.includes("advanced-tool-use-2025-11-20"),
    "Haiku must NOT receive advanced-tool-use"
  );
  // General full-agent flags are still present for Haiku.
  assert.ok(flags.includes("oauth-2025-04-20"));
  assert.ok(flags.includes("interleaved-thinking-2025-05-14"));
  assert.ok(flags.includes("claude-code-20250219"));
  assert.ok(flags.includes("extended-cache-ttl-2025-04-11"));
});

test("#2454 Sonnet full-agent includes heavy-agent flags but omits context-1m", () => {
  const flags = selectBetaFlags(fullAgentBody("claude-sonnet-4-6"));
  assert.ok(!flags.includes("context-1m-2025-08-07"), "Sonnet must NOT receive context-1m");
  assert.ok(flags.includes("effort-2025-11-24"));
  assert.ok(flags.includes("advanced-tool-use-2025-11-20"));
  assert.ok(flags.includes("thinking-token-count-2026-05-13"));
  assert.ok(flags.includes("redact-thinking-2026-02-12"), "Sonnet sends redact-thinking");
  assert.ok(!flags.includes("afk-mode-2026-01-31"), "afk-mode removed — not in any CC capture");
  assert.ok(
    !flags.includes("mid-conversation-system-2026-04-07"),
    "Sonnet must NOT receive mid-conversation-system"
  );
});

test("#2454 Opus full-agent includes context-1m and mid-conversation-system", () => {
  const flags = selectBetaFlags(fullAgentBody("claude-opus-4-7"));
  assert.ok(flags.includes("context-1m-2025-08-07"), "Opus should receive context-1m");
  assert.ok(
    flags.includes("mid-conversation-system-2026-04-07"),
    "Opus should receive mid-conversation-system"
  );
});

test("Opus 5 full-agent omits the legacy context-1m beta", () => {
  const flags = selectBetaFlags(fullAgentBody("claude-opus-5"));
  assert.ok(!flags.includes("context-1m-2025-08-07"));
  assert.ok(flags.includes("mid-conversation-system-2026-04-07"));
});

test("#2454 explicit model arg overrides body.model for tiering", () => {
  // body says sonnet, but the resolved upstream model is haiku → must omit context-1m
  const flags = selectBetaFlags(fullAgentBody("claude-sonnet-4-6"), "claude-haiku-4-5-20251001");
  assert.ok(!flags.includes("context-1m-2025-08-07"));
});

// OAuth's captured redact beta is retained by default, even when a negotiated
// client omits it. Readable thinking requires the release's explicit opt-in.
test("negotiated client without redact-thinking retains the default OAuth fingerprint", () => {
  const flags = selectBetaFlags(
    fullAgentBody("claude-opus-5-5"),
    null,
    "effort-2025-11-24,context-management-2025-06-27,interleaved-thinking-2025-05-14"
  ).split(",");
  assert.ok(flags.includes("interleaved-thinking-2025-05-14"));
  assert.ok(flags.includes("redact-thinking-2026-02-12"));
});

test("negotiated client that asks for redact-thinking still gets it", () => {
  const flags = selectBetaFlags(
    fullAgentBody("claude-opus-5-5"),
    null,
    "interleaved-thinking-2025-05-14,redact-thinking-2026-02-12"
  ).split(",");
  assert.ok(flags.includes("redact-thinking-2026-02-12"));
});

test("OAuth readable-thinking opt-in suppresses only unnegotiated redact-thinking", () => {
  const key = "CLAUDE_OAUTH_SUMMARIZED_THINKING_UNREDACTED";
  const previous = process.env[key];
  process.env[key] = "true";
  try {
    const body = {
      ...fullAgentBody("claude-opus-5-5"),
      thinking: { type: "adaptive", display: "summarized" },
    };
    const interleaved = "interleaved-thinking-2025-05-14";
    const redact = "redact-thinking-2026-02-12";
    const visibleFlags = selectBetaFlags(body, null, interleaved).split(",");
    assert.ok(visibleFlags.includes(interleaved));
    assert.ok(!visibleFlags.includes(redact));
    const redactedFlags = selectBetaFlags(body, null, `${interleaved},${redact}`).split(",");
    assert.ok(redactedFlags.includes(redact), "explicit client redaction wins over opt-in");
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});
