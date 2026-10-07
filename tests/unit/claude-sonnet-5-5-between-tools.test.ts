import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// DATA_DIR must be set before the DB-backed modules load, so they are imported dynamically.
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-sonnet-5-5-test-"));
process.env.DATA_DIR = testDataDir;

const coreDb = await import("../../src/lib/db/core.ts");
const { prepareUpstreamBody } = await import("../../open-sse/handlers/chatCore/upstreamBody.ts");
const { buildClaudeCodeCompatibleRequest } =
  await import("../../open-sse/services/claudeCodeCompatible.ts");
const { applyClaudeCodeCompatibleThinkingDisplay } =
  await import("../../open-sse/services/claudeCodeCompatibleThinkingDisplay.ts");
const { translateRequest } = await import("../../open-sse/translator/index.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");
const { applyNoThinkingAlias } = await import("../../open-sse/utils/noThinkingAlias.ts");
const { getModelSpec } = await import("../../src/shared/constants/modelSpecs.ts");

before(async () => {
  await coreDb.ensureDbInitialized();
});

after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(testDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// Claude Sonnet 5.5 rejects `thinking:{type:"disabled"}` with
//   400 "thinking.type.disabled" is not supported for this model.
//       Use "thinking.type.between_tools" for the lowest thinking setting
// `between_tools` is accepted only at effort low/medium/high and takes no other
// field. Claude Opus 5.5 rejects both `disabled` and `between_tools`, so its
// only valid "lowest" request omits `thinking` (adaptive default).

type Body = Record<string, unknown>;

function prepare(translatedBody: Body, modelToCall: string, provider = "claude") {
  return prepareUpstreamBody({
    translatedBody,
    modelToCall,
    provider,
    targetFormat: FORMATS.CLAUDE,
    credentials: {},
    originModel: modelToCall,
  }) as Promise<Body>;
}

function claudeBody(model: string, extra: Body = {}): Body {
  return {
    model,
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "disabled" },
    ...extra,
  };
}

const SONNET_5_5_IDS = [
  "claude-sonnet-5-5",
  "claude-sonnet-5.5",
  "claude-sonnet-5-5-20260928",
  "anthropic.claude-sonnet-5-5",
  "global.anthropic.claude-sonnet-5-5",
  "cc/claude-sonnet-5-5",
];

test("Sonnet 5.5 ids do not fall back to the Sonnet 5 spec", () => {
  for (const id of SONNET_5_5_IDS) {
    assert.equal(getModelSpec(id), getModelSpec("claude-sonnet-5-5"), id);
    assert.notEqual(getModelSpec(id), getModelSpec("claude-sonnet-5"), id);
  }
});

test("Sonnet 5.5 sends between_tools instead of disabled on every id form and platform", async () => {
  for (const id of SONNET_5_5_IDS) {
    for (const provider of ["claude", "anthropic", "bedrock", "vertex"]) {
      const out = await prepare(claudeBody(id), id, provider);
      assert.deepEqual(out.thinking, { type: "between_tools" }, `${provider} ${id}`);
    }
  }
});

test("Sonnet 5.5 between_tools carries no extra thinking fields", async () => {
  const out = await prepare(
    claudeBody("claude-sonnet-5-5", {
      thinking: {
        type: "disabled",
        display: "summarized",
        budget_tokens: 1024,
        block_binding: { prefix_mismatch_behavior: "drop_block" },
      },
    }),
    "claude-sonnet-5-5"
  );
  assert.deepEqual(out.thinking, { type: "between_tools" });
});

test("Sonnet 5.5 caps xhigh/max effort to high when thinking is turned off", async () => {
  for (const effort of ["xhigh", "max", "XHIGH"]) {
    const out = await prepare(
      claudeBody("claude-sonnet-5-5", { output_config: { effort, format: { type: "text" } } }),
      "claude-sonnet-5-5",
      "bedrock"
    );
    assert.deepEqual(out.thinking, { type: "between_tools" }, effort);
    assert.deepEqual(out.output_config, { effort: "high", format: { type: "text" } }, effort);
  }
});

test("Sonnet 5.5 keeps low/medium/high effort unchanged with between_tools", async () => {
  for (const effort of ["low", "medium", "high"]) {
    const out = await prepare(
      claudeBody("claude-sonnet-5-5", { output_config: { effort } }),
      "claude-sonnet-5-5"
    );
    assert.deepEqual(out.output_config, { effort }, effort);
  }
});

test("Sonnet 5.5 leaves adaptive and client-sent between_tools untouched", async () => {
  const adaptive = await prepare(
    claudeBody("claude-sonnet-5-5", {
      thinking: { type: "adaptive" },
      output_config: { effort: "max" },
    }),
    "claude-sonnet-5-5"
  );
  assert.deepEqual(adaptive.thinking, { type: "adaptive" });
  // Release #15035: Sonnet 5.5 caps effort at xhigh (max is an upstream 400),
  // so adaptive keeps its thinking mode but max is clamped to xhigh.
  assert.deepEqual(adaptive.output_config, { effort: "xhigh" });
});

test("Sonnet 5.5 relaxes forced tool_choice (upstream rejects any/tool)", async () => {
  const tools = [{ name: "t", input_schema: { type: "object" } }];
  const out = await prepare(
    claudeBody("claude-sonnet-5-5", { tools, tool_choice: { type: "tool", name: "t" } }),
    "claude-sonnet-5-5"
  );
  assert.equal("tool_choice" in out, false);
  assert.deepEqual(out.tools, tools);
});

test("Opus 5.5 drops disabled thinking instead of sending between_tools", async () => {
  for (const id of ["claude-opus-5-5", "claude-opus-5.5", "anthropic.claude-opus-5-5"]) {
    const out = await prepare(claudeBody(id, { output_config: { effort: "xhigh" } }), id);
    assert.equal("thinking" in out, false, id);
    assert.deepEqual(out.output_config, { effort: "xhigh" }, id);
  }
});

test("Sonnet 5 and Opus 5 still send disabled thinking", async () => {
  const sonnet = await prepare(claudeBody("claude-sonnet-5"), "claude-sonnet-5");
  assert.deepEqual(sonnet.thinking, { type: "disabled" });
  const opus = await prepare(
    claudeBody("claude-opus-5", { output_config: { effort: "max" } }),
    "claude-opus-5"
  );
  assert.deepEqual(opus.thinking, { type: "disabled" });
  assert.deepEqual(opus.output_config, { effort: "high" });
});

test("Claude Code compatible bridge: raw disabled + max + forced tool_choice is valid upstream", async () => {
  const tools = [{ name: "t", description: "t", input_schema: { type: "object" } }];
  for (const [model, expectedThinking] of [
    ["claude-sonnet-5-5", { type: "between_tools" }],
    ["claude-opus-5-5", undefined],
  ] as const) {
    for (const effort of ["max", undefined]) {
      const sourceBody = claudeBody(model, {
        tools,
        tool_choice: { type: "any" },
        ...(effort ? { output_config: { effort } } : {}),
      });
      const bridged = buildClaudeCodeCompatibleRequest({
        sourceBody,
        normalizedBody: sourceBody,
        claudeBody: sourceBody,
        model,
        summarizeThinking: true,
      }) as Body;
      const out = await prepare(bridged, model, "anthropic-compatible-cc-test");
      const label = `${model} effort=${effort}`;
      assert.deepEqual(out.thinking, expectedThinking, label);
      assert.equal("tool_choice" in out, false, label);
      if (expectedThinking) {
        assert.equal((out.output_config as Body).effort, "high", label);
      }
    }
  }
});

test("summarize-display helpers never add display to between_tools", () => {
  assert.deepEqual(
    applyClaudeCodeCompatibleThinkingDisplay(
      { type: "between_tools" },
      { summarizeThinking: true }
    ),
    { type: "between_tools" }
  );
  const translated = translateRequest(
    FORMATS.CLAUDE,
    FORMATS.CLAUDE,
    "claude-sonnet-5-5",
    {
      ...claudeBody("claude-sonnet-5-5", { thinking: { type: "between_tools" } }),
      _omnirouteCopilotReasoningSummary: "summarized",
    },
    false,
    null,
    "claude"
  ) as Body;
  assert.deepEqual(translated.thinking, { type: "between_tools" });
});

test("the no-think alias reaches Sonnet 5.5 as between_tools", async () => {
  const aliased: Body = { ...claudeBody("no-think/claude-sonnet-5-5"), thinking: undefined };
  assert.equal(applyNoThinkingAlias(aliased, { claudeFormat: true }).applied, true);
  const fromAlias = await prepare(aliased, aliased.model as string);
  assert.deepEqual(fromAlias.thinking, { type: "between_tools" });
});
