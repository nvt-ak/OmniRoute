import test from "node:test";
import assert from "node:assert/strict";

const { sanitizeClaudePassthroughThinkingBlocks } =
  await import("../../open-sse/handlers/chatCore.ts");

// Regression for the GitHub issue reported against #5312 on the Anthropic-native Claude
// OAuth passthrough, routed through a combo that hops between Claude models on the same
// connection. A thinking signature is model-bound server-side; the sanitizer KEEPS a
// thinking block when its signature is safe to replay to the target model and DROPS it
// otherwise (never rewrites), which resolves all three 400s: "must contain thinking"
// (#5108), "Invalid signature" (#2454 cross-model hop), and "cannot be modified" (#3775).
//
// Signatures are built to the real Claude protobuf shape (see claude-thinking-signature
// test for the builder); model_text is the field that records the minting model.
function varint(n: number): Buffer {
  const bytes: number[] = [];
  let v = n;
  do {
    let x = v & 0x7f;
    v >>>= 7;
    if (v) x |= 0x80;
    bytes.push(x);
  } while (v);
  return Buffer.from(bytes);
}
function tag(num: number, type: number): Buffer {
  return varint((num << 3) | type);
}
function buildClaudeSignature(modelName: string | null): string {
  const parts: Buffer[] = [tag(1, 0), varint(12), tag(2, 0), varint(2)];
  if (modelName !== null) {
    parts.push(tag(6, 2), varint(Buffer.byteLength(modelName)), Buffer.from(modelName));
  }
  const channelBlock = Buffer.concat(parts);
  const container = Buffer.concat([tag(1, 2), varint(channelBlock.length), channelBlock]);
  const payload = Buffer.concat([
    tag(2, 2),
    varint(container.length),
    container,
    tag(3, 0),
    varint(1),
  ]);
  return payload.toString("base64");
}
const SONNET_SIG = buildClaudeSignature("claude-sonnet-4-6");
const OPUS_SIG = buildClaudeSignature("claude-opus-4-8");

test("KEEPS a thinking block whose signature model matches the target (same-model multi-turn)", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning", signature: SONNET_SIG },
        { type: "text", text: "answer" },
      ],
    },
  ];
  const before = JSON.stringify(messages);

  const out = sanitizeClaudePassthroughThinkingBlocks(
    messages,
    "claude-sonnet-4-6"
  ) as typeof messages;

  assert.equal(JSON.stringify(out), before, "matching-model thinking is preserved verbatim");
});

test("DROPS a thinking block on a cross-model combo hop (opus sig → sonnet target)", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "opus reasoning", signature: OPUS_SIG },
        { type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ];

  const out = sanitizeClaudePassthroughThinkingBlocks(
    messages,
    "claude-sonnet-5"
  ) as typeof messages;

  const content = out[1].content as Array<Record<string, unknown>>;
  assert.equal(content.length, 1, "opus thinking dropped, tool_use kept");
  assert.equal(content[0].type, "tool_use");
});

test("DROPS an empty-text thinking block with no valid signature (#5108 shape)", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "" },
        { type: "text", text: "answer" },
      ],
    },
    { role: "user", content: [{ type: "text", text: "again" }] },
    { role: "assistant", content: [{ type: "text", text: "final" }] },
  ];

  const out = sanitizeClaudePassthroughThinkingBlocks(
    messages,
    "claude-sonnet-4-6"
  ) as typeof messages;

  const content = out[1].content as Array<Record<string, unknown>>;
  assert.equal(content.length, 1);
  assert.equal(content[0].type, "text");
});

test("DROPS redacted_thinking blocks (opaque data, unverifiable)", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "redacted_thinking", data: "SOME_DATA" },
        { type: "text", text: "hi" },
      ],
    },
    { role: "user", content: [{ type: "text", text: "more" }] },
    { role: "assistant", content: [{ type: "text", text: "final" }] },
  ];

  const out = sanitizeClaudePassthroughThinkingBlocks(
    messages,
    "claude-sonnet-4-6"
  ) as typeof messages;

  const content = out[0].content as Array<Record<string, unknown>>;
  assert.equal(content.length, 1);
  assert.equal(content[0].type, "text");
});

test("KEEPS matching-model thinking on the LATEST assistant turn (verbatim)", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "latest", signature: SONNET_SIG },
        { type: "text", text: "answer" },
      ],
    },
  ];
  const before = JSON.stringify(messages);

  const out = sanitizeClaudePassthroughThinkingBlocks(
    messages,
    "claude-sonnet-4-6"
  ) as typeof messages;

  assert.equal(JSON.stringify(out), before);
});

test("removes an assistant message emptied by a dropped thinking block", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "opus", signature: OPUS_SIG }] },
    { role: "user", content: [{ type: "text", text: "more" }] },
    { role: "assistant", content: [{ type: "text", text: "final" }] },
  ];

  const out = sanitizeClaudePassthroughThinkingBlocks(
    messages,
    "claude-sonnet-5"
  ) as typeof messages;

  assert.equal(out.length, 3);
  assert.equal((out[1] as { role: string }).role, "user");
});

test("leaves assistant messages without thinking untouched (same reference)", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
  ];

  const out = sanitizeClaudePassthroughThinkingBlocks(messages, "claude-sonnet-4-6");

  assert.equal(out, messages);
});

test("never touches user messages", () => {
  const messages = [
    { role: "user", content: [{ type: "thinking", thinking: "x", signature: OPUS_SIG }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ];
  const before = JSON.stringify(messages);

  const out = sanitizeClaudePassthroughThinkingBlocks(
    messages,
    "claude-sonnet-5"
  ) as typeof messages;

  assert.equal(JSON.stringify(out), before);
});

test("non-array / empty / string-content inputs pass through", () => {
  assert.equal(sanitizeClaudePassthroughThinkingBlocks(undefined, "m"), undefined);
  assert.equal(sanitizeClaudePassthroughThinkingBlocks(null, "m"), null);
  const empty: unknown[] = [];
  assert.equal(sanitizeClaudePassthroughThinkingBlocks(empty, "m"), empty);
  const strContent = [
    { role: "user", content: "plain" },
    { role: "assistant", content: "reply" },
  ];
  assert.equal(
    JSON.stringify(sanitizeClaudePassthroughThinkingBlocks(strContent, "m")),
    JSON.stringify(strContent)
  );
});
