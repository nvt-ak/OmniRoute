import assert from "node:assert/strict";
import test from "node:test";

import { translateNonStreamingResponse } from "../../open-sse/handlers/responseTranslator.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

test("Claude non-stream -> Responses preserves opaque reasoning alongside text and tools", () => {
  const opaquePayload = "opaque_redacted_payload";

  const translated = translateNonStreamingResponse(
    {
      id: "msg_nonstream",
      type: "message",
      model: "claude-test",
      stop_reason: "tool_use",
      usage: { input_tokens: 3, output_tokens: 5 },
      content: [
        { type: "thinking", thinking: "visible plan", signature: "sig_nonstream" },
        { type: "redacted_thinking", data: opaquePayload },
        { type: "text", text: "answer" },
        { type: "tool_use", id: "tool_1", name: "lookup", input: { query: "value" } },
      ],
    },
    FORMATS.CLAUDE,
    FORMATS.OPENAI_RESPONSES
  );

  assert.deepEqual(translated, {
    id: "resp_msg_nonstream",
    object: "response",
    created_at: 0,
    status: "completed",
    model: "claude-test",
    output: [
      {
        id: "rs_resp_msg_nonstream_0",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "visible plan" }],
        encrypted_content: "sig_nonstream",
      },
      {
        id: "rs_resp_msg_nonstream_1",
        type: "reasoning",
        summary: [],
        encrypted_content: opaquePayload,
      },
      {
        id: "msg_resp_msg_nonstream_2",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "answer", annotations: [], logprobs: [] }],
      },
      {
        id: "fc_tool_1",
        type: "function_call",
        call_id: "tool_1",
        name: "lookup",
        arguments: '{"query":"value"}',
      },
    ],
    usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
  });
});
