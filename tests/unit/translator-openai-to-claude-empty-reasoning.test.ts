import assert from "node:assert/strict";
import { test } from "node:test";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.ts";
import { translateNonStreamingResponse } from "../../open-sse/handlers/responseTranslator.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";
import {
  hasValuableContent,
  isKnownNonClaudeStreamPayload,
} from "../../open-sse/utils/streamHelpers.ts";
import {
  createStreamContentWatcher,
  hasUsefulStreamContent,
} from "../../open-sse/utils/streamReadiness.ts";
import { validateResponseQuality } from "../../open-sse/services/combo/validateQuality.ts";
import { detectMalformedNonStream } from "../../open-sse/utils/diagnostics.ts";
import { sanitizeStreamingChunk } from "../../open-sse/handlers/responseSanitizer.ts";

function firstChatChoice(body: unknown): Record<string, unknown> {
  assert.ok(body && typeof body === "object" && "choices" in body);
  assert.ok(Array.isArray(body.choices));
  const choice: unknown = body.choices[0];
  assert.ok(choice && typeof choice === "object" && !Array.isArray(choice));
  return choice as Record<string, unknown>;
}

function chatMessage(body: Record<string, unknown>): Record<string, unknown> {
  const message = firstChatChoice(body).message;
  assert.ok(message && typeof message === "object" && !Array.isArray(message));
  return message as Record<string, unknown>;
}

test("openai-to-claude ignores zero-length reasoning_content empty string deltas", () => {
  const state = {
    messageStartSent: true,
    thinkingBlockStarted: false,
    thinkingBlockIndex: -1,
    textBlockStarted: false,
    textBlockIndex: -1,
    textBlockClosed: false,
    nextBlockIndex: 0,
    _pendingXmlToolCalls: [],
  };

  const chunk = {
    choices: [
      {
        delta: {
          reasoning_content: "",
        },
      },
    ],
  };

  const results = openaiToClaudeResponse(chunk, state) || [];
  assert.equal(results.length, 0);
  assert.equal(state.thinkingBlockStarted, false);
});

test("refusal-only Chat deltas reach Claude verbatim and close with refusal", async () => {
  const state = { toolCalls: new Map(), requestedThinking: false };
  const refusal = "I cannot help with that. <invoke>Not a tool</invoke>";
  const chunk = { choices: [{ delta: { refusal }, finish_reason: null }] };
  assert.equal(hasValuableContent(chunk, FORMATS.OPENAI), true);
  assert.equal(isKnownNonClaudeStreamPayload(chunk), true);
  assert.equal(hasUsefulStreamContent(`data: ${JSON.stringify(chunk)}\n\n`), true);
  const events = [
    ...(openaiToClaudeResponse(chunk, state) || []),
    ...(openaiToClaudeResponse(
      { choices: [{ delta: {}, finish_reason: "content_filter" }] },
      state
    ) || []),
    ...(openaiToClaudeResponse(null, state) || []),
  ];
  const texts = events.filter((event) => event.type === "content_block_delta");
  assert.deepEqual(
    texts.map((event) => event.delta),
    [{ type: "text_delta", text: refusal }]
  );
  assert.equal(events.filter((event) => event.type === "content_block_stop").length, 1);
  assert.equal(
    events.find((event) => event.type === "message_delta")?.delta.stop_reason,
    "refusal"
  );
  assert.equal(events.at(-1)?.type, "message_stop");
  const watcher = createStreamContentWatcher();
  watcher.note(`data: ${JSON.stringify(chunk)}\n\n`);
  watcher.finish();
  assert.equal(watcher.sawContent(), true);
  const nativeSse = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  const nativeWatcher = createStreamContentWatcher();
  nativeWatcher.note(nativeSse);
  nativeWatcher.finish();
  assert.equal(nativeWatcher.sawContent(), true);
  const quality = await validateResponseQuality(
    new Response(nativeSse, {
      headers: { "content-type": "text/event-stream" },
    }),
    true,
    {},
    null,
    null,
    "codex"
  );
  assert.equal(quality.valid, true);
});

test("Chat refusal whitespace is buffered before text and forwarded verbatim after text", () => {
  for (const fragments of [
    ["I cannot", " ", "help.", "\n"],
    [" \n", "\t", "I cannot", " ", "help.", "\n"],
  ]) {
    const state = { toolCalls: new Map(), requestedThinking: false };
    const events = [];
    for (const refusal of fragments) {
      const chunk = { choices: [{ delta: { refusal }, finish_reason: null }] };
      assert.equal(hasValuableContent(chunk, FORMATS.OPENAI), true);
      const translated = openaiToClaudeResponse(chunk, state) || [];
      if (refusal.trim().length === 0 && !state.hasRefusal) {
        assert.ok(translated.every((event) => event.type !== "content_block_delta"));
      }
      events.push(...translated);
    }
    events.push(
      ...(openaiToClaudeResponse(
        { choices: [{ delta: {}, finish_reason: "content_filter" }] },
        state
      ) || [])
    );
    events.push(...(openaiToClaudeResponse(null, state) || []));
    assert.equal(
      events
        .filter((event) => event.type === "content_block_delta")
        .map((event) => event.delta.text)
        .join(""),
      fragments.join("")
    );
    assert.equal(events.filter((event) => event.type === "content_block_start").length, 1);
    assert.equal(events.filter((event) => event.type === "content_block_stop").length, 1);
    assert.equal(
      events.find((event) => event.type === "message_delta")?.delta.stop_reason,
      "refusal"
    );
  }
});

test("whitespace-only Chat refusal never becomes successful native Claude output", async () => {
  const state = { toolCalls: new Map(), requestedThinking: false };
  const events = [];
  for (const refusal of [" \n", "\t"]) {
    events.push(
      ...(openaiToClaudeResponse(
        { choices: [{ delta: { refusal }, finish_reason: null }] },
        state
      ) || [])
    );
  }
  events.push(
    ...(openaiToClaudeResponse(
      { choices: [{ delta: {}, finish_reason: "content_filter" }] },
      state
    ) || [])
  );
  events.push(...(openaiToClaudeResponse(null, state) || []));
  assert.ok(events.every((event) => event.type !== "content_block_delta"));
  assert.equal(state.hasRefusal, undefined);
  assert.equal(state.pendingRefusalWhitespace, undefined);
  const nativeSse = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  const watcher = createStreamContentWatcher();
  watcher.note(nativeSse);
  watcher.finish();
  assert.equal(watcher.sawContent(), false);
  const quality = await validateResponseQuality(
    new Response(nativeSse, {
      headers: { "content-type": "text/event-stream" },
    }),
    true,
    {},
    null,
    null,
    "codex"
  );
  assert.equal(quality.valid, false);
});

test("Responses refusal parts survive nonstream Chat and native Claude quality gates", async () => {
  const refusal = "I cannot assist with this request.";
  const response = {
    object: "response",
    id: "resp_refusal",
    status: "completed",
    model: "codex",
    output: [{ type: "message", content: [{ type: "refusal", refusal }] }],
    usage: { input_tokens: 11, output_tokens: 7 },
  };
  const chat = translateNonStreamingResponse(response, FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI);
  assert.equal(chatMessage(chat).refusal, refusal);
  assert.equal(chatMessage(chat).content, "");
  assert.equal(firstChatChoice(chat).finish_reason, "content_filter");
  const claude = translateNonStreamingResponse(response, FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE);
  assert.deepEqual(claude.content, [{ type: "text", text: refusal }]);
  assert.equal(claude.stop_reason, "refusal");
  for (const body of [response, chat, claude]) {
    assert.equal(detectMalformedNonStream(body, "codex"), null);
    const quality = await validateResponseQuality(
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      }),
      false,
      {},
      null,
      null,
      "codex"
    );
    assert.equal(quality.valid, true);
  }
});

test("missing and empty refusal strings do not manufacture successful Codex output", async () => {
  for (const refusal of [undefined, "", "   ", null, 42]) {
    const response = {
      object: "response",
      status: "completed",
      output: [{ type: "message", content: [{ type: "refusal", refusal }] }],
    };
    const chat = translateNonStreamingResponse(response, FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI);
    assert.equal(chatMessage(chat).refusal, undefined);
    for (const body of [response, chat]) {
      assert.equal(detectMalformedNonStream(body, "codex"), "empty_choices");
      const quality = await validateResponseQuality(
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        }),
        false,
        {},
        null,
        null,
        false,
        "codex"
      );
      assert.equal(quality.valid, false);
    }
  }
  for (const refusal of ["", "   "]) {
    const chunk = { choices: [{ delta: { refusal } }] };
    assert.equal(hasValuableContent(chunk, FORMATS.OPENAI), refusal.length > 0);
    assert.equal(isKnownNonClaudeStreamPayload(chunk), false);
    assert.equal(hasUsefulStreamContent(`data: ${JSON.stringify(chunk)}\n\n`), false);
    for (const type of ["response.refusal.delta", "response.refusal.done"]) {
      assert.equal(isKnownNonClaudeStreamPayload({ type, delta: refusal, refusal }), false);
    }
  }
});

test("Chat streaming sanitization preserves exact refusal without content duplication", () => {
  const refusal = "Cannot help.\n\n\n\n<invoke>literal</invoke>\u200d";
  const sanitized = sanitizeStreamingChunk({
    choices: [{ delta: { refusal }, finish_reason: null }],
  });
  const choice = firstChatChoice(sanitized);
  assert.deepEqual(choice.delta, { refusal });
});
