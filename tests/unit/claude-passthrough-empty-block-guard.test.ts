// Regression test: the Claude passthrough path must drop typeless / empty chunks
// (`event: content_block_delta\ndata: {}`) so they are never forwarded to the client.
// A Claude-compatible relay can emit such empty events; forwarding the raw `data: {}`
// crashes strict Anthropic clients with a zod discriminatedUnion error on `type`
// (path ["type"]: "No matching discriminator"). See open-sse/utils/stream.ts isClaudeSSE branch.

import test from "node:test";
import assert from "node:assert/strict";

import { FORMATS } from "../../open-sse/translator/formats.ts";

const { createPassthroughStreamWithLogger } = await import("../../open-sse/utils/stream.ts");

async function runPassthrough(rawSSE: string): Promise<string> {
  const stream = createPassthroughStreamWithLogger(
    "claude",
    null,
    null,
    "claude-opus-4-8",
    null,
    null,
    null,
    null,
    null,
    FORMATS.CLAUDE
  );

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(rawSSE));
      controller.close();
    },
  });

  const piped = readable.pipeThrough(stream as TransformStream<Uint8Array, Uint8Array>);
  const reader = piped.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

test("passthrough drops `event: content_block_delta` with empty `data: {}`", async () => {
  const sse =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[]}}\n\n' +
    "event: content_block_delta\ndata: {}\n\n" +
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n' +
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n';

  const out = await runPassthrough(sse);

  assert.equal(out.includes("data: {}"), false, "empty `data: {}` chunk must be dropped");
  assert.ok(out.includes('"text":"hello"'), "valid text delta must pass through");
  assert.ok(out.includes('"type":"message_start"'), "message_start must pass through");
  assert.ok(out.includes('"type":"message_stop"'), "message_stop must pass through");
});

test("passthrough drops a content_block_delta whose delta has no value", async () => {
  const sse =
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":""}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"keep"}}\n\n';

  const out = await runPassthrough(sse);

  assert.ok(out.includes('"text":"keep"'), "non-empty delta must pass through");
  const emptyDeltaCount = (out.match(/"text":""/g) || []).length;
  assert.equal(emptyDeltaCount, 0, "empty text_delta must be dropped");
});
