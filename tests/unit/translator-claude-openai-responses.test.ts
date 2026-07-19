import assert from "node:assert/strict";
import test from "node:test";

const { FORMATS } = await import("../../open-sse/translator/formats.ts");
const { initState, translateResponse } = await import("../../open-sse/translator/index.ts");

function translateClaudeStream(chunks) {
  const state = initState(FORMATS.OPENAI_RESPONSES);
  const events = [];

  for (const chunk of chunks) {
    events.push(...translateResponse(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, chunk, state));
  }

  return events;
}

function findReasoningDone(events) {
  return events.find(
    (event) => event.event === "response.output_item.done" && event.data.item.type === "reasoning"
  );
}

function findReasoningDoneItems(events) {
  return events
    .filter(
      (event) => event.event === "response.output_item.done" && event.data.item.type === "reasoning"
    )
    .map((event) => event.data.item);
}

test("Claude -> Responses: streams thinking summaries and keeps the final signature encrypted", () => {
  const events = translateClaudeStream([
    { type: "message_start", message: { id: "claude_1", model: "claude-test" } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig_1" },
    },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 3, output_tokens: 4 },
    },
  ]);

  assert.ok(
    events.some(
      (event) =>
        event.event === "response.reasoning_summary_text.delta" && event.data.delta === "plan"
    )
  );
  assert.equal(findReasoningDone(events)?.data.item.encrypted_content, "sig_1");
  assert.ok(
    events.some(
      (event) => event.event === "response.output_text.delta" && event.data.delta === "answer"
    )
  );

  const completed = events.find((event) => event.event === "response.completed");
  assert.deepEqual(completed?.data.response.usage, {
    input_tokens: 3,
    output_tokens: 4,
    total_tokens: 7,
  });
});

test("Claude -> Responses: signature-only thinking does not create summary text", () => {
  const events = translateClaudeStream([
    { type: "message_start", message: { id: "claude_2", model: "claude-test" } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig_only" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 1 },
    },
  ]);

  assert.equal(
    events.some((event) => event.event === "response.reasoning_summary_text.delta"),
    false
  );
  assert.equal(findReasoningDone(events)?.data.item.encrypted_content, "sig_only");
});

test("Claude -> Responses: separates multiple visible and redacted reasoning blocks", () => {
  const opaquePayload = "opaque_second";
  const events = translateClaudeStream([
    {
      type: "message_start",
      message: { id: "claude_multiple", model: "claude-test", usage: { input_tokens: 7 } },
    },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "first" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig_first" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "redacted_thinking", data: opaquePayload },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 5 },
    },
  ]);

  assert.deepEqual(findReasoningDoneItems(events), [
    {
      id: "rs_resp_claude_multiple_0",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "first" }],
      status: "completed",
      encrypted_content: "sig_first",
    },
    {
      id: "rs_resp_claude_multiple_1",
      type: "reasoning",
      summary: [],
      status: "completed",
      encrypted_content: opaquePayload,
    },
  ]);
  assert.equal(
    events.some(
      (event) =>
        event.event.startsWith("response.reasoning_summary") &&
        JSON.stringify(event.data).includes(opaquePayload)
    ),
    false
  );
  const completed = events.find((event) => event.event === "response.completed");
  assert.deepEqual(completed?.data.response.usage, {
    input_tokens: 7,
    output_tokens: 5,
    total_tokens: 12,
  });
});

test("Claude -> Responses: signature-only thinking omits the summary lifecycle", () => {
  const events = translateClaudeStream([
    { type: "message_start", message: { id: "claude_omitted", model: "claude-test" } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig_omitted" },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} },
  ]);

  assert.equal(
    events.some((event) => event.event.startsWith("response.reasoning_summary")),
    false
  );
  assert.deepEqual(findReasoningDone(events)?.data.item, {
    id: "rs_resp_claude_omitted_0",
    type: "reasoning",
    summary: [],
    status: "completed",
    encrypted_content: "sig_omitted",
  });
});

test("Claude -> Responses: redacted thinking stays opaque and out of reasoning summaries", () => {
  const opaquePayload = "opaque_redacted_payload";
  const events = translateClaudeStream([
    {
      type: "message_start",
      message: { id: "claude_3", model: "claude-test", usage: { input_tokens: 2 } },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "redacted_thinking", data: opaquePayload },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 1 },
    },
  ]);

  const reasoningDone = findReasoningDone(events);
  assert.equal(reasoningDone?.data.item.encrypted_content, opaquePayload);
  assert.equal(
    events.some(
      (event) =>
        event.event.startsWith("response.reasoning_summary") &&
        JSON.stringify(event.data).includes(opaquePayload)
    ),
    false
  );
});
