import test from "node:test";
import assert from "node:assert/strict";
import {
  isEmptyContentResponse,
  isTrustedEmptyStop,
} from "../../open-sse/services/errorClassifier.ts";
import { validateResponseQuality } from "../../open-sse/services/combo/validateQuality.ts";
import {
  createDisconnectAwareStream,
  createStreamController,
} from "../../open-sse/utils/streamHandler.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";
import { detectMalformedNonStream } from "../../open-sse/utils/diagnostics.ts";
import { createSSEStream } from "../../open-sse/utils/stream.ts";
import { isCleanEmptyClaudeStop } from "../../open-sse/utils/streamClaudeEmptyBody.ts";

const silentLog = { warn: () => undefined };
const reportedUsages = [
  { input_tokens: 158569, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 } },
  { input_tokens: 158569, output_tokens: 4, output_tokens_details: { reasoning_tokens: 0 } },
  { input_tokens: 158569, output_tokens: 16, output_tokens_details: { reasoning_tokens: 10 } },
];
const frame = (event: { type: string; [key: string]: unknown }) =>
  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const sse = (frames: string[]) =>
  new Response(frames.join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
const json = (body: object) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
const quality = (response: Response, streaming: boolean, provider = "codex") =>
  validateResponseQuality(response, streaming, silentLog, undefined, undefined, false, provider);

async function clientSees(frames: string[], provider: string, format: string) {
  const watched = createDisconnectAwareStream(
    {
      readable: sse(frames).body!,
      writable: { getWriter: () => ({ abort: () => Promise.resolve() }) },
    },
    createStreamController({ provider, model: "m", clientResponseFormat: format })
  );
  return new Response(watched).text();
}

// Actual empty final_answer events must stay empty; generated/reasoning token
// counts (including the 4732 replay's output16/reasoning10) are not answer proof.
function silentEvents(usage: object, terminal = "completed") {
  const message = {
    id: "msg_silent",
    type: "message",
    status: "completed",
    role: "assistant",
    phase: "final_answer",
    content: [{ type: "output_text", text: "" }],
  };
  const part = { type: "output_text", text: "" };
  const events = [
    frame({
      type: "response.created",
      response: { id: "resp_silent", status: "in_progress", output: [] },
    }),
    frame({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    }),
    frame({
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      item_id: message.id,
      part,
    }),
    frame({
      type: "response.output_text.done",
      output_index: 0,
      content_index: 0,
      item_id: message.id,
      text: "",
    }),
    frame({
      type: "response.content_part.done",
      output_index: 0,
      content_index: 0,
      item_id: message.id,
      part,
    }),
    frame({ type: "response.output_item.done", output_index: 0, item: message }),
  ];
  if (terminal !== "missing")
    events.push(
      frame({
        type: terminal === "failed" ? "response.failed" : "response.completed",
        response: {
          id: "resp_silent",
          object: "response",
          status:
            terminal === "missing_status"
              ? undefined
              : terminal === "error" || terminal === "incomplete_details"
                ? "completed"
                : terminal,
          error:
            terminal === "failed" || terminal === "error" ? { message: "upstream failed" } : null,
          incomplete_details:
            terminal === "incomplete_details" ? { reason: "max_output_tokens" } : null,
          output: [],
          usage,
        },
      })
    );
  return events;
}

async function translate(
  frames: string[],
  clientFormat: string,
  fragmented = false,
  trailingNewline = true
) {
  const bytes = new TextEncoder().encode(
    trailingNewline ? frames.join("") : frames.join("").trimEnd()
  );
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      if (fragmented) {
        for (let i = 0; i < bytes.length; i += 13) controller.enqueue(bytes.subarray(i, i + 13));
      } else controller.enqueue(bytes);
      controller.close();
    },
  });
  const transformed = source.pipeThrough(
    createSSEStream({
      targetFormat: FORMATS.OPENAI_RESPONSES,
      sourceFormat: clientFormat,
      provider: "codex",
      model: "gpt-6.1-sol",
      body: { messages: [{ role: "user", content: "hi" }] },
    })
  );
  const watched = createDisconnectAwareStream(
    {
      readable: transformed,
      writable: { getWriter: () => ({ abort: () => Promise.resolve() }) },
    },
    createStreamController({ provider: "codex", model: "m", clientResponseFormat: clientFormat })
  );
  return new Response(watched).text().catch((error: Error) => `THREW ${error.message}`);
}

for (const usage of reportedUsages) {
  const label = `output${usage.output_tokens}/reasoning${usage.output_tokens_details.reasoning_tokens}`;
  test(`Codex ${label} empty normal stops are rejected in every nonstream shape`, async () => {
    const bodies = [
      { choices: [{ message: { content: null }, finish_reason: "stop" }], usage },
      { type: "message", role: "assistant", content: [], stop_reason: "end_turn", usage },
      { object: "response", status: "completed", output: [], usage },
    ];
    for (const body of bodies) {
      assert.equal(isEmptyContentResponse(body, { provider: "codex" }), true);
      assert.equal(detectMalformedNonStream(body, "codex"), "empty_choices");
      assert.equal((await quality(json(body), false)).valid, false);
    }
    for (const reason of ["stop", "end_turn", "stop_sequence"]) {
      assert.equal(isTrustedEmptyStop("codex", reason, usage), false);
      assert.equal(isCleanEmptyClaudeStop(reason, "codex", usage), false);
    }
  });

  test(`Codex ${label} empty raw Responses and chat fail watcher and combo`, async () => {
    const frames = silentEvents(usage);
    const chatFrames = [
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\n`,
      "data: [DONE]\n\n",
    ];
    for (const [stream, format] of [
      [frames, FORMATS.OPENAI_RESPONSES],
      [chatFrames, FORMATS.OPENAI],
    ] as const) {
      assert.match(await clientSees(stream, "codex", format), /empty content|response\.failed/);
      assert.equal((await quality(sse(stream), true)).valid, false);
    }
  });

  test(`Codex ${label} empty turn fails full Responses transform, watcher and combo`, async () => {
    for (const format of [FORMATS.CLAUDE, FORMATS.OPENAI]) {
      for (const fragmented of [false, true]) {
        for (const trailingNewline of [false, true]) {
          const text = await translate(silentEvents(usage), format, fragmented, trailingNewline);
          assert.match(
            text,
            /THREW|empty response|empty content|"type":"error"|"finish_reason":"error"/
          );
          assert.doesNotMatch(
            text,
            /\(empty response\)|content_block_start|signature_delta|"type":"text_delta"/
          );
          assert.equal((await quality(sse([text]), true)).valid, false);
        }
      }
    }
  });
}

test("unfinished and unsuccessful Codex terminals never become silent success", async () => {
  for (const terminal of [
    "missing",
    "missing_status",
    "failed",
    "incomplete",
    "error",
    "incomplete_details",
  ]) {
    const frames = silentEvents(reportedUsages[2], terminal);
    assert.equal((await quality(sse(frames), true)).valid, false, terminal);
    for (const format of [FORMATS.CLAUDE, FORMATS.OPENAI]) {
      const text = await translate(frames, format, true, false);
      assert.equal((await quality(sse([text]), true)).valid, false, `${terminal}/${format}`);
      assert.doesNotMatch(text, /\(empty response\)|"type":"text_delta"/);
    }
  }
});

test("EOF without final newline preserves genuine delta text and successful terminal", async () => {
  const frames = [
    frame({
      type: "response.created",
      response: { id: "resp_real", status: "in_progress", output: [] },
    }),
    frame({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: "msg_real",
      delta: "Real answer",
    }),
    frame({
      type: "response.completed",
      response: {
        id: "resp_real",
        status: "completed",
        output: [
          {
            id: "msg_real",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Real answer" }],
          },
        ],
        usage: reportedUsages[1],
      },
    }),
  ];
  for (const format of [FORMATS.CLAUDE, FORMATS.OPENAI]) {
    const text = await translate(frames, format, true, false);
    assert.match(text, /Real answer/);
    assert.doesNotMatch(text, /THREW|empty response|empty content|\(empty response\)/);
    assert.match(text, format === FORMATS.CLAUDE ? /message_stop/ : /\[DONE\]/);
    assert.equal((await quality(sse([text]), true)).valid, true);
  }
});

test("Antigravity remains trusted, but estimated empty shells are not trusted", async () => {
  const estimated = { output_tokens: 4, estimated: true };
  const hidden = { output_tokens: 4 };
  Object.defineProperty(hidden, Symbol.for("omniroute.usage.estimated"), { value: true });
  for (const reason of ["stop", "end_turn", "stop_sequence"]) {
    assert.equal(isTrustedEmptyStop("antigravity", reason), true);
    assert.equal(isTrustedEmptyStop("antigravity", reason, reportedUsages[0]), true);
    for (const usage of [estimated, hidden]) {
      assert.equal(isTrustedEmptyStop("antigravity", reason, usage), false);
      const body = { choices: [{ message: { content: null }, finish_reason: reason }], usage };
      assert.equal(isEmptyContentResponse(body, { provider: "antigravity" }), true);
      if (usage === estimated) {
        assert.equal((await quality(json(body), false, "antigravity")).valid, false);
      }
      if (reason !== "stop") {
        assert.equal(isCleanEmptyClaudeStop(reason, "antigravity", usage), false);
        const frames = [
          frame({ type: "message_start", message: { content: [] } }),
          frame({ type: "message_delta", delta: { stop_reason: reason }, usage }),
          frame({ type: "message_stop" }),
        ];
        // Symbol provenance is exercised by the direct policy assertion above;
        // only the enumerable marker survives encoding onto the wire.
        if (usage === estimated) {
          assert.match(
            await clientSees(frames, "antigravity", FORMATS.CLAUDE),
            /empty content|"type":"error"/
          );
          assert.equal((await quality(sse(frames), true, "antigravity")).valid, false);
        }
      }
    }
  }
  assert.equal(isTrustedEmptyStop("opencode", "stop", reportedUsages[2]), false);
  assert.equal(isTrustedEmptyStop(undefined, "stop", reportedUsages[2]), false);
  assert.equal(isTrustedEmptyStop("antigravity", "incomplete"), false);
});

test("native Claude clean empty stops survive passthrough while combo requires connection trust", async () => {
  for (const provider of ["claude", "anthropic", "antigravity", "opencode"]) {
    for (const reason of ["end_turn", "stop_sequence"]) {
      const frames = [
        frame({
          type: "message_start",
          message: { id: "msg_empty", role: "assistant", content: [] },
        }),
        frame({
          type: "message_delta",
          delta: { stop_reason: reason },
          usage: { output_tokens: 0 },
        }),
        frame({ type: "message_stop" }),
      ];
      const transformed = sse(frames).body!.pipeThrough(
        createSSEStream({
          mode: "passthrough",
          sourceFormat: FORMATS.CLAUDE,
          clientResponseFormat: FORMATS.CLAUDE,
          provider,
          model: "m",
          body: { messages: [{ role: "user", content: "hi" }] },
        })
      );
      const text = await new Response(transformed).text();
      assert.equal(text, frames.join(""));
      assert.equal(await clientSees([text], provider, FORMATS.CLAUDE), text);
      const trustedEmptyTurn = provider === "claude" || provider === "anthropic";
      const verdict = await validateResponseQuality(
        sse([text]),
        true,
        silentLog,
        undefined,
        undefined,
        trustedEmptyTurn,
        provider
      );
      assert.equal(verdict.valid, trustedEmptyTurn || provider === "antigravity");
    }
  }
});

test("Claude empty Codex, unfinished and zero-byte passthrough responses are aborted", async () => {
  for (const [reason, stop] of [
    ["end_turn", true],
    ["stop_sequence", true],
    ["end_turn", false],
    [null, true],
    ["zero_bytes", false],
  ] as const) {
    const frames =
      reason === "zero_bytes"
        ? []
        : [
            frame({ type: "message_start", message: { content: [] } }),
            frame({
              type: "message_delta",
              delta: { stop_reason: reason },
              usage: reportedUsages[2],
            }),
            ...(stop ? [frame({ type: "message_stop" })] : []),
          ];
    const transformed = sse(frames).body!.pipeThrough(
      createSSEStream({
        mode: "passthrough",
        sourceFormat: FORMATS.CLAUDE,
        clientResponseFormat: FORMATS.CLAUDE,
        provider: "codex",
        model: "m",
        body: { messages: [{ role: "user", content: "hi" }] },
      })
    );
    await assert.rejects(new Response(transformed).text(), /empty response/);
    assert.equal((await quality(sse(frames), true)).valid, false);
  }
});

test("native Claude clean empty stop still needs a terminal message_stop", async () => {
  const frames = [
    frame({ type: "message_start", message: { content: [] } }),
    frame({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
  ];
  assert.match(await clientSees(frames, "claude", FORMATS.CLAUDE), /empty content|"type":"error"/);
  assert.equal((await quality(sse(frames), true, "claude")).valid, false);
});

test("genuine Codex refusal text counts as output, not as an empty-stop exemption", () => {
  for (const refusal of ["I cannot help with that request.", "", " \n\t", null, 1]) {
    const expectedEmpty = typeof refusal !== "string" || refusal.trim().length === 0;
    for (const field of ["message", "delta"]) {
      for (const finishReason of ["stop", "content_filter"]) {
        const body = {
          choices: [{ [field]: { content: null, refusal }, finish_reason: finishReason }],
          usage: reportedUsages[2],
        };
        assert.equal(isEmptyContentResponse(body, { provider: "codex" }), expectedEmpty);
      }
    }
    const response = {
      object: "response",
      status: "completed",
      usage: reportedUsages[2],
      output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal }] }],
    };
    assert.equal(isEmptyContentResponse(response, { provider: "codex" }), expectedEmpty);
  }
});

test("Codex content_filter metadata alone is not client-usable output", () => {
  const body = {
    choices: [
      {
        message: { content: null, reasoning_content: "hidden reasoning" },
        finish_reason: "content_filter",
      },
    ],
    usage: reportedUsages[2],
  };
  assert.equal(isEmptyContentResponse(body, { provider: "codex" }), true);
  const withText = {
    ...body,
    choices: [{ message: { content: "Actual explanation" }, finish_reason: "content_filter" }],
  };
  assert.equal(isEmptyContentResponse(withText, { provider: "codex" }), false);
});
