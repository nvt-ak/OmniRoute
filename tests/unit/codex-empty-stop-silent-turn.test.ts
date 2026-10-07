import test from "node:test";
import assert from "node:assert/strict";
import {
  isEmptyContentResponse,
  isTrustedEmptyStop,
} from "../../open-sse/services/errorClassifier.ts";
import { validateResponseQuality } from "../../open-sse/services/combo/validateQuality.ts";
import { pipeWithDisconnect, createStreamController } from "../../open-sse/utils/streamHandler.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";
import { detectMalformedNonStream } from "../../open-sse/utils/diagnostics.ts";
import { createSSEStream } from "../../open-sse/utils/stream.ts";
import { isCleanEmptyClaudeStop } from "../../open-sse/utils/streamClaudeEmptyBody.ts";
import {
  hasTrustedEmptyTurn,
  markEmptyTurnExecution,
} from "../../open-sse/utils/emptyTurnPolicy.ts";
import { getRegistryEntry } from "../../open-sse/config/providerRegistry.ts";

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

function nativeExecution(response: Response, format: string, executionProvider?: string): Response {
  const provider =
    executionProvider ??
    (format === FORMATS.CLAUDE ? "anthropic" : format === FORMATS.OPENAI ? "openai" : "codex");
  return markEmptyTurnExecution(response, getRegistryEntry(provider)!.baseUrl!, {
    connectionId: "native-test-connection",
    accessToken: "native-test-token",
  });
}

async function clientSees(frames: string[], provider: string, format: string, trusted = false) {
  const upstream = sse(frames);
  const watched = pipeWithDisconnect(
    trusted
      ? nativeExecution(upstream, format, provider === "codex" ? provider : undefined)
      : upstream,
    new TransformStream(),
    createStreamController({ provider, model: "m", clientResponseFormat: format })
  );
  return new Response(watched).text();
}

function assertEmptyStreamRejected(text: string, context = "empty stream") {
  const events = text
    .split(/\r?\n\r?\n/)
    .map((frame) =>
      frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
    )
    .filter((data) => data && data !== "[DONE]")
    .map((data) => JSON.parse(data));

  assert.ok(
    events.some((event) => {
      const error = event.error ?? event.response?.error;
      return (
        error &&
        (error.code === "empty_response" ||
          ((event.type === "error" ||
            event.type === "response.failed" ||
            event.choices?.some(
              (choice: { finish_reason?: string }) => choice.finish_reason === "error"
            )) &&
            typeof error.message === "string" &&
            error.message.length > 0))
      );
    }),
    `${context}: expected a structured empty-content failure`
  );
  for (const event of events) {
    assert.ok(
      !["content_block_start", "signature_delta", "text_delta"].includes(event.type) &&
        !["signature_delta", "text_delta"].includes(event.delta?.type),
      `${context}: must not synthesize content blocks`
    );
    if (event.type === "response.output_text.delta") {
      assert.ok(!event.delta, `${context}: no fake Responses answer`);
    }
    for (const item of event.response?.output ?? []) {
      for (const part of item.content ?? []) {
        assert.ok(!part.text && !part.refusal, `${context}: no fake completed answer`);
      }
    }
    for (const choice of event.choices ?? []) {
      assert.ok(!choice.delta?.content && !choice.message?.content, `${context}: no fake answer`);
      assert.ok(!choice.delta?.tool_calls?.length, `${context}: no fake tool calls`);
    }
  }
}

// Live capture 2026-10-06 (watchdog prompt, "silence preferred"): Codex completes
// with an empty final_answer, status "completed", output 4 / reasoning 0.
// Empty completion remains a failure even with authenticated native execution.
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
  trailingNewline = true,
  trusted = true
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
  const raw = new Response(source, {
    headers: { "Content-Type": "text/event-stream" },
  });
  const upstream = trusted ? nativeExecution(raw, FORMATS.OPENAI_RESPONSES) : raw;
  const watched = pipeWithDisconnect(
    upstream,
    createSSEStream({
      targetFormat: FORMATS.OPENAI_RESPONSES,
      sourceFormat: clientFormat,
      provider: "codex",
      trustedEmptyTurn: () => hasTrustedEmptyTurn(upstream),
      model: "gpt-6.1-sol",
      body: { messages: [{ role: "user", content: "hi" }] },
    }),
    createStreamController({ provider: "codex", model: "m", clientResponseFormat: clientFormat })
  );
  return new Response(watched).text().catch((error: Error) => `THREW ${error.message}`);
}

// output0 is not a model answer: it stays a 502 failover in every shape.
test("Codex completed empty turn with zero generated output still fails over", async () => {
  const usage = reportedUsages[0];
  for (const body of [
    { choices: [{ message: { content: null }, finish_reason: "stop" }], usage },
    { type: "message", role: "assistant", content: [], stop_reason: "end_turn", usage },
    { object: "response", status: "completed", output: [], usage },
  ]) {
    assert.equal(isEmptyContentResponse(body, { provider: "codex" }), true);
    assert.equal(detectMalformedNonStream(body, "codex"), "empty_choices");
    assert.equal((await quality(json(body), false)).valid, false);
  }
  for (const reason of ["stop", "end_turn", "stop_sequence"]) {
    assert.equal(isTrustedEmptyStop("codex", reason, usage), false);
    assert.equal(isTrustedEmptyStop("codex", reason, undefined), false);
  }
  const frames = silentEvents(usage);
  assertEmptyStreamRejected(await clientSees(frames, "codex", FORMATS.OPENAI_RESPONSES));
  assert.equal((await quality(sse(frames), true)).valid, false);
  for (const format of [FORMATS.CLAUDE, FORMATS.OPENAI]) {
    const text = await translate(frames, format, false, true, false);
    assert.equal((await quality(sse([text]), true)).valid, false, format);
    assertEmptyStreamRejected(text, format);
  }
});

for (const usage of reportedUsages.slice(1)) {
  const label = `output${usage.output_tokens}/reasoning${usage.output_tokens_details.reasoning_tokens}`;
  test(`Codex ${label} completed empty normal stops fail in every nonstream shape`, async () => {
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
      assert.equal(isTrustedEmptyStop("codex", reason, { ...usage, estimated: true }), false);
      assert.equal(isCleanEmptyClaudeStop(reason, "codex", { ...usage, estimated: true }), false);
    }
    for (const status of ["incomplete", "failed", "in_progress"]) {
      const body = { object: "response", status, output: [], usage };
      assert.equal(isEmptyContentResponse(body, { provider: "codex" }), true, status);
    }
  });

  test(`Codex ${label} completed empty raw Responses and chat fail watcher and combo`, async () => {
    const frames = silentEvents(usage);
    const chatFrames = [
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\n`,
      "data: [DONE]\n\n",
    ];
    for (const [stream, format] of [
      [frames, FORMATS.OPENAI_RESPONSES],
      [chatFrames, FORMATS.OPENAI],
    ] as const) {
      for (const authenticated of [false, true]) {
        const seen = await clientSees(stream, "codex", format, authenticated);
        assertEmptyStreamRejected(seen, format);
        assert.equal((await quality(sse([seen]), true)).valid, false, format);
      }
      assert.equal((await quality(sse(stream), true)).valid, false, format);
    }
  });

  test(`Codex ${label} completed empty turn fails full Responses transform, watcher and combo`, async () => {
    for (const format of [FORMATS.CLAUDE, FORMATS.OPENAI]) {
      for (const fragmented of [false, true]) {
        for (const trailingNewline of [false, true]) {
          const text = await translate(silentEvents(usage), format, fragmented, trailingNewline);
          assertEmptyStreamRejected(text, format);
          assert.equal((await quality(sse([text]), true)).valid, false);
        }
      }
    }
  });
}

test("generated Codex usage alone never grants watcher execution trust", async () => {
  for (const usage of reportedUsages.slice(1)) {
    for (const [frames, format] of [
      [silentEvents(usage), FORMATS.OPENAI_RESPONSES],
      [
        [
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\n`,
          "data: [DONE]\n\n",
        ],
        FORMATS.OPENAI,
      ],
    ] as const) {
      assertEmptyStreamRejected(await clientSees([...frames], "codex", format), format);
    }
    for (const format of [FORMATS.CLAUDE, FORMATS.OPENAI]) {
      const text = await translate(silentEvents(usage), format, true, false, false);
      assertEmptyStreamRejected(text, format);
    }
  }
});

test("authenticated native Codex empty completion fails with zero generated tokens", async () => {
  const frames = silentEvents(reportedUsages[0]);
  assertEmptyStreamRejected(await clientSees(frames, "codex", FORMATS.OPENAI_RESPONSES, true));
  for (const format of [FORMATS.OPENAI, FORMATS.CLAUDE]) {
    const text = await translate(frames, format, true, false);
    assertEmptyStreamRejected(text, format);
    assert.equal((await quality(sse([text]), true)).valid, false);
  }
});

// Authentication and missing content-type headers must not turn empty output
// into success, regardless of upstream chunk boundaries.
test("native Codex silent turn without a content-type header still fails", async () => {
  const markHeaderless = (frames: string[], chunk: number) => {
    const bytes = new TextEncoder().encode(frames.join(""));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunk)
          controller.enqueue(bytes.subarray(i, i + chunk));
        controller.close();
      },
    });
    const raw = new Response(body);
    raw.headers.delete("content-type");
    return markEmptyTurnExecution(raw, getRegistryEntry("codex")!.baseUrl!, {
      connectionId: "native-test-connection",
      accessToken: "native-test-token",
    });
  };
  for (const chunk of [1 << 20, 7]) {
    const frames = silentEvents(reportedUsages[1]);
    const upstream = markHeaderless(frames, chunk);
    const watched = pipeWithDisconnect(
      upstream,
      createSSEStream({
        targetFormat: FORMATS.OPENAI_RESPONSES,
        sourceFormat: FORMATS.OPENAI,
        provider: "codex",
        trustedEmptyTurn: () => hasTrustedEmptyTurn(upstream),
        model: "gpt-6.1-sol",
        body: { messages: [{ role: "user", content: "hi" }] },
      }),
      createStreamController({
        provider: "codex",
        model: "m",
        clientResponseFormat: FORMATS.OPENAI,
      })
    );
    const text = await new Response(watched).text();
    assertEmptyStreamRejected(text, `chunk ${chunk}`);
    assert.equal((await quality(sse([text]), true)).valid, false, `chunk ${chunk}`);
  }

  const failed = markHeaderless(silentEvents(reportedUsages[1], "failed"), 1 << 20);
  const watchedFailed = pipeWithDisconnect(
    failed,
    new TransformStream(),
    createStreamController({
      provider: "codex",
      model: "m",
      clientResponseFormat: FORMATS.OPENAI_RESPONSES,
    })
  );
  const failedText = await new Response(watchedFailed).text();
  assert.match(failedText, /response\.failed/);
  assert.equal((await quality(sse([failedText]), true)).valid, false);
});

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
    assert.match(
      await clientSees(frames, "codex", FORMATS.OPENAI_RESPONSES),
      /empty content|response\.failed/,
      `watcher/${terminal}`
    );
    for (const format of [FORMATS.CLAUDE, FORMATS.OPENAI]) {
      const text = await translate(frames, format, true, false);
      assert.equal((await quality(sse([text]), true)).valid, false, `${terminal}/${format}`);
      assert.doesNotMatch(text, /"type":"text_delta"/);
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
      assert.equal(await clientSees([text], provider, FORMATS.CLAUDE, true), text);
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

test("Claude-shape Codex empty stops, unfinished, reasonless and zero-byte streams abort", async () => {
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

test("Codex refusal text counts as output; content_filter without text stays empty", () => {
  for (const refusal of ["I cannot help with that request.", "", " \n\t", null, 1]) {
    const hasRefusal = typeof refusal === "string" && refusal.trim().length > 0;
    for (const field of ["message", "delta"]) {
      for (const finishReason of ["stop", "content_filter"]) {
        const body = {
          choices: [{ [field]: { content: null, refusal }, finish_reason: finishReason }],
          usage: reportedUsages[2],
        };
        assert.equal(isEmptyContentResponse(body, { provider: "codex" }), !hasRefusal);
      }
    }
    const response = {
      object: "response",
      status: "completed",
      usage: reportedUsages[2],
      output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal }] }],
    };
    assert.equal(isEmptyContentResponse(response, { provider: "codex" }), !hasRefusal);
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
