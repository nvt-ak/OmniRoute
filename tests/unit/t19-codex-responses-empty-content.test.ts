import test from "node:test";
import assert from "node:assert/strict";
import { isEmptyContentResponse } from "../../open-sse/services/errorClassifier.ts";
import { detectMalformedNonStream } from "../../open-sse/utils/diagnostics.ts";

const { translateNonStreamingResponse } =
  await import("../../open-sse/handlers/responseTranslator.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");

function firstChoice(response: Record<string, unknown>): Record<string, unknown> {
  assert.ok(Array.isArray(response.choices));
  const choice: unknown = response.choices[0];
  assert.ok(choice && typeof choice === "object" && !Array.isArray(choice));
  return choice as Record<string, unknown>;
}

function messageContent(response: Record<string, unknown>): unknown {
  const message = firstChoice(response).message;
  assert.ok(message && typeof message === "object" && !Array.isArray(message));
  return (message as Record<string, unknown>).content;
}

function estimatedUsage(response: Record<string, unknown>): unknown {
  const usage = response.usage;
  assert.ok(usage && typeof usage === "object" && !Array.isArray(usage));
  return (usage as Record<string, unknown>).estimated;
}

test("T19: picks the last non-empty message content from Responses output", () => {
  const responseBody = {
    object: "response",
    id: "resp_t19",
    model: "gpt-5.3-codex",
    created_at: 1710000000,
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "" }],
      },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "thinking..." }],
      },
      {
        type: "message",
        content: [{ type: "output_text", text: "Resposta final" }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  };

  const translated = translateNonStreamingResponse(
    responseBody,
    FORMATS.OPENAI_RESPONSES,
    FORMATS.OPENAI
  );

  assert.equal(messageContent(translated), "Resposta final");
});

test("T19: falls back to last message block when all message texts are empty", () => {
  const responseBody = {
    object: "response",
    id: "resp_t19_empty",
    model: "gpt-5.3-codex",
    created_at: 1710000001,
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "" }],
      },
      {
        type: "message",
        content: [{ type: "output_text", text: "" }],
      },
    ],
  };

  const translated = translateNonStreamingResponse(
    responseBody,
    FORMATS.OPENAI_RESPONSES,
    FORMATS.OPENAI
  );

  assert.equal(messageContent(translated), "");
  assert.equal(firstChoice(translated).finish_reason, "unknown");
});

function silentResponse(overrides: Record<string, unknown> = {}) {
  return {
    object: "response",
    id: "resp_silent",
    model: "gpt-5.3-codex",
    created_at: 1710000000,
    status: "completed",
    output: [],
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      output_tokens_details: { reasoning_tokens: 0 },
    },
    ...overrides,
  };
}

test("completed silent Responses project to Claude without invented text", () => {
  const translated = translateNonStreamingResponse(
    silentResponse(),
    FORMATS.OPENAI_RESPONSES,
    FORMATS.CLAUDE
  );
  assert.deepEqual(translated.content, []);
  assert.equal(translated.stop_reason, "end_turn");
  assert.deepEqual(translated.usage, { input_tokens: 10, output_tokens: 4 });
  assert.equal(isEmptyContentResponse(translated, { provider: "codex" }), true);
  assert.equal(detectMalformedNonStream(translated, "codex"), "empty_choices");
});

test("silent reasoning usage is preserved but cannot prove a usable Claude answer", () => {
  const translated = translateNonStreamingResponse(
    silentResponse({
      usage: {
        input_tokens: 10,
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: 4 },
      },
    }),
    FORMATS.OPENAI_RESPONSES,
    FORMATS.CLAUDE
  );
  assert.deepEqual(translated.content, []);
  assert.equal(translated.stop_reason, "end_turn");
  assert.deepEqual(translated.usage, {
    input_tokens: 10,
    output_tokens: 0,
    reasoning_tokens: 4,
  });
  assert.equal(isEmptyContentResponse(translated, { provider: "codex" }), true);
  assert.equal(detectMalformedNonStream(translated, "codex"), "empty_choices");
});

test("completed Responses preserve genuine text for Claude", () => {
  const translated = translateNonStreamingResponse(
    silentResponse({
      output: [{ type: "message", content: [{ type: "output_text", text: "Real answer" }] }],
    }),
    FORMATS.OPENAI_RESPONSES,
    FORMATS.CLAUDE
  );
  assert.deepEqual(translated.content, [{ type: "text", text: "Real answer" }]);
  assert.equal(translated.stop_reason, "end_turn");
});

for (const status of ["failed", "incomplete", "cancelled", "in_progress"]) {
  test(`Responses ${status} never becomes a normal stop despite output usage`, () => {
    const body = silentResponse({ status });
    const openai = translateNonStreamingResponse(body, FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI);
    assert.equal(firstChoice(openai).finish_reason, status);
    const claude = translateNonStreamingResponse(body, FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE);
    assert.equal(claude.stop_reason, status);
    assert.deepEqual(claude.content, [{ type: "text", text: "(empty response)" }]);
  });
}

for (const metadata of [
  { error: { message: "upstream failed" } },
  { incomplete_details: { reason: "max_output_tokens" } },
  { status: undefined },
]) {
  test(`silent Responses require successful terminal evidence: ${JSON.stringify(metadata)}`, () => {
    const translated = translateNonStreamingResponse(
      silentResponse(metadata),
      FORMATS.OPENAI_RESPONSES,
      FORMATS.CLAUDE
    );
    assert.notEqual(translated.stop_reason, "end_turn");
    assert.deepEqual(translated.content, [{ type: "text", text: "(empty response)" }]);
  });
}

for (const marker of ["estimated", Symbol.for("omniroute.usage.estimated")]) {
  test(`Responses usage preserves ${String(marker)} provenance across both projections`, () => {
    const usage = { input_tokens: 10, output_tokens: 4 };
    Object.defineProperty(usage, marker, { value: true, enumerable: false });
    const body = silentResponse({ usage });
    const openai = translateNonStreamingResponse(body, FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI);
    assert.equal(estimatedUsage(openai), true);
    const claude = translateNonStreamingResponse(body, FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE);
    assert.equal(estimatedUsage(claude), true);
    assert.deepEqual(claude.content, [{ type: "text", text: "(empty response)" }]);
  });
}

for (const completionTokens of [0, undefined, Infinity]) {
  test(`generic OpenAI empty guard remains for unproven generation: ${completionTokens}`, () => {
    const translated = translateNonStreamingResponse(
      {
        object: "chat.completion",
        choices: [{ message: { content: "" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: completionTokens },
      },
      FORMATS.OPENAI,
      FORMATS.CLAUDE
    );
    assert.deepEqual(translated.content, [{ type: "text", text: "(empty response)" }]);
  });
}
