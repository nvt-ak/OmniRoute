import assert from "node:assert/strict";
import test from "node:test";

const { assembleStreamingPipeline } =
  await import("../../open-sse/handlers/chatCore/streamingPipeline.ts");

type ReplayTurn = {
  readonly model: string;
  readonly sessionId: string;
  readonly turnMarker: string;
  readonly items: readonly (
    | { readonly type: "reasoning"; readonly encryptedContent: string }
    | {
        readonly type: "function_call";
        readonly callId: string;
        readonly name: string;
        readonly arguments: string;
      }
    | {
        readonly type: "custom_tool_call";
        readonly callId: string;
        readonly name: string;
        readonly input: string;
      }
  )[];
};

function sseStream(events: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) return result + decoder.decode();
    result += decoder.decode(value, { stream: true });
  }
}

function createNoopTransform(): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
  });
}

function createChatClientTransform(): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  return new TransformStream({
    transform(_chunk, controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"visible"}}]}\n\n'));
    },
  });
}

function createStreamController() {
  const abortController = new AbortController();
  return {
    signal: abortController.signal,
    startTime: Date.now(),
    isConnected: () => true,
    handleDisconnect: () => {},
    handleComplete: () => {},
    markClientTerminalSeen: () => {},
    handleError: () => {},
    abort: () => abortController.abort(),
    clientResponseFormat: "openai",
  };
}

const streamingPipelineDeps = {
  pipeWithDisconnect(
    providerResponse: Response,
    transformStream: TransformStream<Uint8Array, Uint8Array>
  ) {
    return providerResponse.body!.pipeThrough(transformStream);
  },
  wantsProgress: () => false,
  isFeatureFlagEnabled: () => false,
  createPiiSseTransform: createNoopTransform,
  createProgressTransform: createNoopTransform,
  createSseHeartbeatTransform: createNoopTransform,
  shapeForClientFormat: () => "openai-chunk" as const,
  createModelEchoTransform: createNoopTransform,
} satisfies Parameters<typeof assembleStreamingPipeline>[1];

test("commits one ordered Codex replay turn after response.completed without changing wire bytes", async () => {
  // Given
  const encryptedContent = "  opaque\u0000ciphertext\n\t==  ";
  const addedEvent = `event: response.output_item.added\ndata: ${JSON.stringify({
    type: "response.output_item.added",
    item: { type: "reasoning", encrypted_content: "intermediate" },
  })}\n\n`;
  const customToolDoneEvent = `event: response.output_item.done\ndata: ${JSON.stringify({
    type: "response.output_item.done",
    output_index: 2,
    item: { type: "custom_tool_call", call_id: "ctc_1", name: "shell", input: '{"cmd":"pwd"}' },
  })}\n\n`;
  const reasoningDoneEvent = `event: response.output_item.done\ndata: ${JSON.stringify({
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "reasoning", encrypted_content: encryptedContent },
  })}\n\n`;
  const functionDoneEvent = `event: response.output_item.done\ndata: ${JSON.stringify({
    type: "response.output_item.done",
    output_index: 1,
    item: {
      type: "function_call",
      call_id: "fc_1",
      name: "read_file",
      arguments: '{"path":"a.ts"}',
    },
  })}\n\n`;
  const completedEvent = `event: response.completed\ndata: ${JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp_1",
      output: [
        { type: "reasoning", encrypted_content: encryptedContent },
        { type: "function_call", call_id: "fc_1", name: "read_file", arguments: '{"path":"a.ts"}' },
        { type: "custom_tool_call", call_id: "ctc_1", name: "shell", input: '{"cmd":"pwd"}' },
      ],
    },
  })}\n\n`;
  const wireEvents = [
    addedEvent,
    customToolDoneEvent,
    reasoningDoneEvent,
    functionDoneEvent,
    completedEvent,
  ];
  const stored: ReplayTurn[] = [];
  const responseHeaders: Record<string, string> = {};

  // When
  const finalStream = assembleStreamingPipeline(
    {
      providerResponse: new Response(sseStream(wireEvents)),
      transformStream: createNoopTransform(),
      streamController: createStreamController(),
      createPiiTransform: undefined,
      clientRawRequestHeaders: null,
      clientResponseFormat: "openai",
      echoModel: null,
      responseHeaders,
      codexOpaqueResponsesReplay: {
        model: "gpt-5-codex",
        sessionId: "canonical-session",
        store(value) {
          stored.push(value);
        },
      },
    },
    streamingPipelineDeps
  );
  const wireOutput = await readStream(finalStream);

  // Then
  assert.equal(wireOutput, wireEvents.join(""));
  assert.deepEqual(responseHeaders, {});
  assert.deepEqual(stored, [
    {
      model: "gpt-5-codex",
      sessionId: "canonical-session",
      turnMarker: "resp_1",
      items: [
        { type: "reasoning", encryptedContent },
        { type: "function_call", callId: "fc_1", name: "read_file", arguments: '{"path":"a.ts"}' },
        { type: "custom_tool_call", callId: "ctc_1", name: "shell", input: '{"cmd":"pwd"}' },
      ],
    },
  ]);
});

test("does not commit a finalized Codex item without response.completed", async () => {
  // Given
  const encryptedContent = "  opaque\\u0000ciphertext\\n\\t==  ";
  const providerEvent = `event: response.output_item.done\ndata: ${JSON.stringify({
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "reasoning", encrypted_content: encryptedContent },
  })}\n\n`;
  const stored: ReplayTurn[] = [];

  // When
  const finalStream = assembleStreamingPipeline(
    {
      providerResponse: new Response(sseStream([providerEvent])),
      transformStream: createChatClientTransform(),
      streamController: createStreamController(),
      createPiiTransform: undefined,
      clientRawRequestHeaders: null,
      clientResponseFormat: "openai",
      echoModel: null,
      responseHeaders: {},
      codexOpaqueResponsesReplay: {
        model: "gpt-5-codex",
        sessionId: "canonical-session",
        store(value) {
          stored.push(value);
        },
      },
    },
    streamingPipelineDeps
  );
  const clientOutput = await readStream(finalStream);

  // Then
  assert.equal(clientOutput.includes(encryptedContent), false);
  assert.equal(clientOutput.includes('"content":"visible"'), true);
  assert.deepEqual(stored, []);
});

test("does not commit failed, intermediate, malformed, or non-replay Codex stream events", async () => {
  // Given
  const events = [
    `event: response.output_item.added\ndata: ${JSON.stringify({
      type: "response.output_item.added",
      item: { type: "reasoning", encrypted_content: "added" },
    })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "reasoning", encrypted_content: "opaque" },
    })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({
      type: "response.output_item.done",
      item: { type: "message", encrypted_content: "message" },
    })}\n\n`,
    "event: response.output_item.done\ndata: not-json\n\n",
    `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed" })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { id: "resp_failed", output: [{ type: "reasoning", encrypted_content: "opaque" }] },
    })}\n\n`,
  ];
  const stored: ReplayTurn[] = [];

  // When
  const finalStream = assembleStreamingPipeline(
    {
      providerResponse: new Response(sseStream(events)),
      transformStream: createNoopTransform(),
      streamController: createStreamController(),
      createPiiTransform: undefined,
      clientRawRequestHeaders: null,
      clientResponseFormat: "openai",
      echoModel: null,
      responseHeaders: {},
      codexOpaqueResponsesReplay: {
        model: "gpt-5-codex",
        sessionId: "canonical-session",
        store(value) {
          stored.push(value);
        },
      },
    },
    streamingPipelineDeps
  );
  const wireOutput = await readStream(finalStream);

  // Then
  assert.equal(wireOutput, events.join(""));
  assert.deepEqual(stored, []);
});

test("does not collect for missing replay context", async () => {
  // Given
  const event = `event: response.output_item.done\ndata: ${JSON.stringify({
    type: "response.output_item.done",
    item: { type: "reasoning", encrypted_content: "opaque" },
  })}\n\n`;

  // When
  const finalStream = assembleStreamingPipeline(
    {
      providerResponse: new Response(sseStream([event])),
      transformStream: createNoopTransform(),
      streamController: createStreamController(),
      createPiiTransform: undefined,
      clientRawRequestHeaders: null,
      clientResponseFormat: "openai",
      echoModel: null,
      responseHeaders: {},
    },
    streamingPipelineDeps
  );
  const wireOutput = await readStream(finalStream);

  // Then
  assert.equal(wireOutput, event);
});
