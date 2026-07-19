import assert from "node:assert/strict";
import test from "node:test";

import { FORMATS } from "../../open-sse/translator/formats.ts";
import { translateRequest } from "../../open-sse/translator/index.ts";

type ClaudeBlock = Record<string, unknown>;
type ClaudeMessage = {
  readonly role: string;
  readonly content: readonly ClaudeBlock[];
};

function translateResponsesToClaude(input: readonly unknown[]): readonly ClaudeMessage[] {
  const translated = translateRequest(
    FORMATS.OPENAI_RESPONSES,
    FORMATS.CLAUDE,
    "claude-test",
    { input },
    false,
    null,
    "claude"
  ) as { readonly messages: readonly ClaudeMessage[] };

  return translated.messages;
}

test("Responses reasoning replays an encrypted summary as Claude thinking", () => {
  const messages = translateResponsesToClaude([
    {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "visible plan" }],
      encrypted_content: "claude_signature",
    },
  ]);

  assert.deepEqual(messages, [
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "visible plan",
          signature: "claude_signature",
          cache_control: { type: "ephemeral" },
        },
      ],
    },
  ]);
});

test("Responses encrypted-only reasoning replays as Claude redacted thinking", () => {
  const messages = translateResponsesToClaude([
    {
      type: "reasoning",
      summary: [],
      encrypted_content: "opaque_payload",
    },
  ]);

  assert.deepEqual(messages, [
    {
      role: "assistant",
      content: [
        {
          type: "redacted_thinking",
          data: "opaque_payload",
          cache_control: { type: "ephemeral" },
        },
      ],
    },
  ]);
});

test("Responses display-only reasoning remains omitted from Claude replay", () => {
  const messages = translateResponsesToClaude([
    {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "display-only" }],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "continue" }],
    },
  ]);

  assert.deepEqual(messages, [
    {
      role: "user",
      content: [{ type: "text", text: "continue" }],
    },
  ]);
});

test("Responses reasoning remains before its following Claude tool use", () => {
  const messages = translateResponsesToClaude([
    {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "inspect input" }],
      encrypted_content: "claude_signature",
    },
    {
      type: "function_call",
      call_id: "call_1",
      name: "lookup",
      arguments: '{"query":"value"}',
    },
  ]);

  assert.deepEqual(messages, [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "inspect input", signature: "claude_signature" },
        {
          type: "tool_use",
          id: "call_1",
          name: "proxy_lookup",
          input: { query: "value" },
          cache_control: { type: "ephemeral" },
        },
      ],
    },
  ]);
});
