import test from "node:test";
import assert from "node:assert/strict";
import { shouldAbortEmptyClaudeStream } from "../../open-sse/utils/streamClaudeEmptyBody.ts";
import {
  createSSEStream,
  createClaudeEmptyResponseLifecycle,
  updateClaudeEmptyResponseLifecycle,
} from "../../open-sse/utils/stream.ts";
import { createStreamController, pipeWithDisconnect } from "../../open-sse/utils/streamHandler.ts";
import { validateResponseQuality } from "../../open-sse/services/combo/validateQuality.ts";
import { isEmptyContentResponse } from "../../open-sse/services/errorClassifier.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";
import {
  detectMalformedNonStream,
  describeMalformedNonStream,
  synthOpenAIErrorChunk,
  synthResponsesFailure,
} from "../../open-sse/utils/diagnostics.ts";

const log = { warn() {} };
const headers = { "Content-Type": "text/event-stream" };
const encode = new TextEncoder();
const frame = (data: Record<string, unknown>) =>
  `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;

function emptyTurn(reason: string | null, stop = true, emptyBlock = false): string {
  return [
    frame({
      type: "message_start",
      message: {
        id: "msg_native",
        role: "assistant",
        content: [],
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    }),
    ...(emptyBlock
      ? [
          frame({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          }),
          frame({ type: "content_block_stop", index: 0 }),
        ]
      : []),
    frame({
      type: "message_delta",
      delta: { stop_reason: reason, stop_sequence: reason === "stop_sequence" ? "END" : null },
      usage: { output_tokens: 3 },
    }),
    ...(stop ? [frame({ type: "message_stop" })] : []),
  ].join("");
}

function response(text: string, fragmented = false): Response {
  const bytes = encode.encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const size = fragmented ? 7 : bytes.length || 1;
        for (let offset = 0; offset < bytes.length; offset += size) {
          controller.enqueue(bytes.subarray(offset, offset + size));
        }
        controller.close();
      },
    }),
    { headers }
  );
}

function transform() {
  return createSSEStream({
    mode: "passthrough",
    sourceFormat: FORMATS.CLAUDE,
    clientResponseFormat: FORMATS.CLAUDE,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    body: { messages: [{ role: "user", content: "Say nothing if there is no suggestion" }] },
  });
}

for (const reason of ["end_turn", "stop_sequence"]) {
  test(`native Claude ${reason}: no reasoning required through transform, watcher and combo`, async () => {
    const expected = emptyTurn(reason);
    for (const fragmented of [false, true]) {
      for (const trailingNewline of [false, true]) {
        const upstream = response(trailingNewline ? expected : expected.trimEnd(), fragmented);
        const controller = createStreamController({
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          clientResponseFormat: FORMATS.CLAUDE,
        });
        const watched = pipeWithDisconnect(upstream, transform(), controller);
        const quality = await validateResponseQuality(
          new Response(watched, { headers }),
          true,
          log,
          undefined,
          undefined,
          true,
          "anthropic"
        );
        assert.equal(quality.valid, true, quality.reason);
        const output = await quality.clonedResponse!.text();
        assert.equal(output, expected);
        assert.doesNotMatch(
          output,
          /content_block|signature_delta|reasoning_tokens|"type":"error"/
        );
      }
    }
  });

  test(`native Claude ${reason}: raw watcher and trusted provider-independent combo accept the full lifecycle`, async () => {
    const text = emptyTurn(reason);
    const controller = createStreamController({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      clientResponseFormat: FORMATS.CLAUDE,
    });
    const watched = pipeWithDisconnect(response(text, true), new TransformStream(), controller);
    assert.equal(await new Response(watched).text(), text);
    const quality = await validateResponseQuality(
      response(text, true), true, log, undefined, undefined, true
    );
    assert.equal(quality.valid, true, quality.reason);
    assert.equal(await quality.clonedResponse!.text(), text);
  });
}

test("native Claude empty SSE is not trusted by the combo gate without credential or provider evidence", async () => {
  for (const reason of ["end_turn", "stop_sequence"]) {
    const quality = await validateResponseQuality(
      response(emptyTurn(reason), true), true, log, undefined, undefined, false
    );
    assert.equal(quality.valid, false);
  }
});

test("native Claude empty turns still reject invalid reasons, missing terminals and zero bytes", async () => {
  for (const text of [
    emptyTurn("content_filter"),
    emptyTurn(null),
    emptyTurn("max_tokens"),
    emptyTurn("tool_use"),
    emptyTurn("end_turn", false),
    emptyTurn("stop_sequence", false),
    "",
  ]) {
    await assert.rejects(
      new Response(response(text, true).body!.pipeThrough(transform())).text(),
      /empty response/
    );
    const quality = await validateResponseQuality(
      response(text, true),
      true,
      log,
      undefined,
      undefined,
      true,
      "anthropic"
    );
    assert.equal(quality.valid, false, text);
  }
});

test("native Claude watcher does not mistake message_delta or a bare stop header for completion", async () => {
  for (const reason of ["end_turn", "stop_sequence"]) {
    for (const suffix of ["", "event: message_stop\n\n"]) {
      const controller = createStreamController({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        clientResponseFormat: FORMATS.CLAUDE,
      });
      const watched = pipeWithDisconnect(
        response(emptyTurn(reason, false) + suffix, true),
        new TransformStream(),
        controller
      );
      assert.match(await new Response(watched).text(), /"type":"error"/);
    }
  }
});

test("native Claude clean stops do not hide upstream errors or empty text blocks", async () => {
  for (const reason of ["end_turn", "stop_sequence"]) {
    const errored =
      frame({
        type: "error",
        error: { type: "overloaded_error", message: "upstream overloaded" },
      }) + emptyTurn(reason);
    const quality = await validateResponseQuality(
      response(errored),
      true,
      log,
      undefined,
      undefined,
      true,
      "anthropic"
    );
    assert.equal(quality.valid, false);
    assert.match(quality.reason!, /upstream overloaded/);
    const emptyBlock = emptyTurn(reason, true, true);
    const blockQuality = await validateResponseQuality(
      response(emptyBlock),
      true,
      log,
      undefined,
      undefined,
      true,
      "anthropic"
    );
    assert.equal(blockQuality.valid, false);
    const controller = createStreamController({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      clientResponseFormat: FORMATS.CLAUDE,
    });
    const watched = pipeWithDisconnect(
      response(emptyBlock, true),
      new TransformStream(),
      controller
    );
    assert.match(await new Response(watched).text(), /"type":"error"/);
  }
});

test("native Claude non-streaming empty-response guards are unchanged", () => {
  for (const reason of ["end_turn", "stop_sequence"]) {
    const body = {
      type: "message",
      content: [],
      stop_reason: reason,
      usage: { input_tokens: 12, output_tokens: 3 },
    };
    assert.equal(isEmptyContentResponse(body, { provider: "anthropic" }), true);
    assert.equal(detectMalformedNonStream(body, "anthropic"), "empty_choices");
  }
});

test("Responses diagnostics distinguish trusted empty completion from failed or incomplete terminals", () => {
  const completed = { object: "response", status: "completed", output: [] };
  assert.equal(detectMalformedNonStream(completed, "antigravity"), null);
  for (const body of [
    { ...completed, status: "failed", error: { message: "upstream overloaded" } },
    { ...completed, status: "in_progress" },
    { ...completed, incomplete_details: { reason: "max_output_tokens" } },
  ]) {
    assert.equal(detectMalformedNonStream(body, "antigravity"), "empty_choices");
  }
  const failed = {
    ...completed,
    status: "failed",
    error: { message: "upstream overloaded" },
    output: [{ type: "message", content: [{ type: "output_text", text: "partial" }] }],
  };
  assert.equal(detectMalformedNonStream(failed, "antigravity"), "no_terminal");
  assert.deepEqual(describeMalformedNonStream(failed, "no_terminal"), {
    message: "upstream reported a failed response: upstream overloaded",
    code: "upstream_response_failed",
    type: "upstream_response_error",
  });
});

test("native Claude refusal metadata is valid only for an assistant message without an error", () => {
  const refusal = { type: "message", role: "assistant", content: [], stop_reason: "refusal" };
  assert.equal(isEmptyContentResponse(refusal, { provider: "anthropic" }), false);
  assert.equal(detectMalformedNonStream(refusal, "anthropic"), null);
  for (const body of [
    { ...refusal, role: "user" },
    { ...refusal, error: { message: "upstream overloaded" } },
  ]) {
    assert.equal(isEmptyContentResponse(body, { provider: "anthropic" }), true);
    assert.equal(detectMalformedNonStream(body, "anthropic"), "empty_choices");
  }
});

test("synthetic malformed-stream errors preserve sanitized messages and strict Responses fields", () => {
  const secret = "sk-testsecret0123456789";
  const reason = `upstream rejected credential ${secret}`;
  const responsesWire = synthResponsesFailure(reason);
  assert.match(responsesWire, /^event: response.failed\n/);
  const failure = JSON.parse(responsesWire.split("\ndata: ")[1].trim());
  assert.equal(failure.type, "response.failed");
  assert.equal(failure.sequence_number, 1);
  assert.match(failure.response.id, /^resp_error_.+/);
  assert.equal(failure.response.status, "failed");
  assert.equal(failure.response.error.code, "stream_disconnected");
  assert.doesNotMatch(failure.response.error.message, /sk-testsecret0123456789/);

  const openAIWire = synthOpenAIErrorChunk({ provider: "codex", reason });
  const openAI = JSON.parse(openAIWire.slice("data: ".length).trim());
  assert.equal(openAI.error.code, "upstream_empty_response");
  assert.doesNotMatch(openAI.error.message, /sk-testsecret0123456789/);
});

test("Codex empty shells without generated output remain malformed in each client format", () => {
  for (const usage of [undefined, { output_tokens: 0 }, { input_tokens: 12 }]) {
    for (const body of [
      { object: "response", status: "completed", output: [], usage },
      {
        choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }],
        usage,
      },
      { type: "message", role: "assistant", content: [], stop_reason: "end_turn", usage },
    ]) {
      assert.equal(isEmptyContentResponse(body, { provider: "codex" }), true);
      assert.equal(detectMalformedNonStream(body, "codex"), "empty_choices");
    }
  }
});

const complete = {
  hasError: false,
  hasContentBlock: false,
  hasMessageStart: true,
  hasMessageDelta: true,
  hasMessageStop: true,
};

test("a finished Claude stream with end_turn and no content block is a real empty answer", () => {
  assert.equal(shouldAbortEmptyClaudeStream({ ...complete, stopReason: "end_turn" }, true), false);
});

test("a finished Claude stream with stop_sequence and no content block is a real empty answer", () => {
  assert.equal(
    shouldAbortEmptyClaudeStream({ ...complete, stopReason: "stop_sequence" }, true),
    false
  );
});

test("content_filter with no content block still aborts", () => {
  assert.equal(
    shouldAbortEmptyClaudeStream({ ...complete, stopReason: "content_filter" }, true),
    true
  );
});

test("a complete lifecycle with no stop_reason still aborts", () => {
  assert.equal(shouldAbortEmptyClaudeStream({ ...complete, stopReason: null }, true), true);
});

test("a lifecycle that never reached message_stop still aborts", () => {
  assert.equal(
    shouldAbortEmptyClaudeStream(
      { ...complete, hasMessageStop: false, stopReason: "end_turn" },
      true
    ),
    true
  );
});

test("a zero-byte Claude stream still aborts even if a stop reason was guessed", () => {
  assert.equal(shouldAbortEmptyClaudeStream({ ...complete, stopReason: "end_turn" }, false), true);
});

test("message_delta stores stop_reason for the empty-stream decision", () => {
  const lifecycle = createClaudeEmptyResponseLifecycle();
  updateClaudeEmptyResponseLifecycle(lifecycle, {
    type: "message_start",
    message: { role: "assistant", content: [] },
  });
  updateClaudeEmptyResponseLifecycle(lifecycle, {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 3 },
  });
  updateClaudeEmptyResponseLifecycle(lifecycle, { type: "message_stop" });
  assert.equal(lifecycle.stopReason, "end_turn");
  assert.equal(lifecycle.hasMessageStop, true);
  assert.equal(shouldAbortEmptyClaudeStream(lifecycle, true), false);
});
