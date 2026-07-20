import assert from "node:assert/strict";
import test from "node:test";

import { wrapWithCodexOpaqueResponsesReplayCapture } from "../../open-sse/handlers/chatCore/codexOpaqueResponsesReplayCapture.ts";
import type { AppendCodexOpaqueResponseReplayTurn } from "../../open-sse/services/codexOpaqueResponsesReplayStore.ts";

type CapturedTurn = AppendCodexOpaqueResponseReplayTurn;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function captureStream(
  frames: readonly string[],
  onStore: (value: CapturedTurn) => void
): Promise<string> {
  const capture = wrapWithCodexOpaqueResponsesReplayCapture(
    {
      model: "gpt-5-codex",
      sessionId: "session-a",
      store: onStore,
    },
    new TransformStream<Uint8Array, Uint8Array>()
  );
  const writer = capture.writable.getWriter();
  const reader = capture.readable.getReader();
  const output = readAll(reader);

  for (const frame of frames) await writer.write(encoder.encode(frame));
  await writer.close();
  return output;
}

async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) return decoder.decode(concatenate(chunks));
    chunks.push(result.value);
  }
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

test("captures finalized response items in canonical completion order only after response.completed", async () => {
  // Given
  const turns: CapturedTurn[] = [];
  const frames = [
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":2,"item":{"type":"custom_tool_call","call_id":"ctc_1","name":"shell","input":"{\\"cmd\\":\\"pwd\\"}"}}\n\n',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","encrypted_content":" opaque\\u0000ciphertext "}}\n\n',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","call_id":"fc_1","name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","output":[{"type":"reasoning","encrypted_content":" opaque\\u0000ciphertext "},{"type":"function_call","call_id":"fc_1","name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"},{"type":"custom_tool_call","call_id":"ctc_1","name":"shell","input":"{\\"cmd\\":\\"pwd\\"}"}]}}\n\n',
  ];

  // When
  const output = await captureStream(frames, (value) => turns.push(value));

  // Then
  assert.equal(output, frames.join(""));
  assert.deepEqual(turns, [
    {
      model: "gpt-5-codex",
      sessionId: "session-a",
      turnMarker: "resp_1",
      items: [
        { type: "reasoning", encryptedContent: " opaque\u0000ciphertext " },
        {
          type: "function_call",
          callId: "fc_1",
          name: "read_file",
          arguments: '{"path":"a.ts"}',
        },
        {
          type: "custom_tool_call",
          callId: "ctc_1",
          name: "shell",
          input: '{"cmd":"pwd"}',
        },
      ],
    },
  ]);
});

test("does not commit partial, failed, or malformed response streams", async () => {
  // Given
  const completedWithoutTerminal = [
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","encrypted_content":"opaque"}}\n\n',
  ];
  const failed = [
    ...completedWithoutTerminal,
    'event: response.failed\ndata: {"type":"response.failed"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_failed","output":[{"type":"reasoning","encrypted_content":"opaque"}]}}\n\n',
  ];
  const malformed = [
    "event: response.output_item.done\ndata: {not-json}\n\n",
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_2","output":[]}}\n\n',
  ];

  // When
  const captured: CapturedTurn[] = [];
  await captureStream(completedWithoutTerminal, (value) => captured.push(value));
  await captureStream(failed, (value) => captured.push(value));
  await captureStream(malformed, (value) => captured.push(value));

  // Then
  assert.deepEqual(captured, []);
});

test("preserves byte-identical output across fragmented UTF-8 and SSE frames", async () => {
  // Given
  const source =
    'event: response.output_item.done\r\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","encrypted_content":"opaque"}}\r\n\r\nevent: response.completed\r\ndata: {"type":"response.completed","response":{"id":"resp_fragmented","output":[{"type":"reasoning","encrypted_content":"opaque"}]}}\r\n\r\n';
  const bytes = encoder.encode(source);
  const fragments = [
    decoder.decode(bytes.subarray(0, 37), { stream: true }),
    decoder.decode(bytes.subarray(37, 101), { stream: true }),
    decoder.decode(bytes.subarray(101)),
  ];
  const captured: CapturedTurn[] = [];

  // When
  const output = await captureStream(fragments, (value) => captured.push(value));

  // Then
  assert.equal(output, source);
  assert.equal(captured.length, 1);
});
