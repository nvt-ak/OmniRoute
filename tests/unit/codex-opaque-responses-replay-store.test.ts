import assert from "node:assert/strict";
import test from "node:test";

const { CodexOpaqueResponsesReplayStore } =
  await import("../../open-sse/services/codexOpaqueResponsesReplayStore.ts");

type MutableClock = {
  now: () => number;
  advance: (milliseconds: number) => void;
};

function createClock(start = 1_000): MutableClock {
  let current = start;
  return {
    now: () => current,
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
}

test("preserves opaque encrypted_content byte-for-byte for its model and session", () => {
  // Given
  const clock = createClock();
  const store = new CodexOpaqueResponsesReplayStore({ now: clock.now });
  const encryptedContent = "  opaque\u0000ciphertext\n\t==  ";

  // When
  const stored = store.store({
    model: "gpt-5-codex",
    sessionId: "session-a",
    encryptedContent,
  });
  const replay = store.get({ model: "gpt-5-codex", sessionId: "session-a" });

  // Then
  assert.equal(stored, true);
  assert.equal(replay, encryptedContent);
});

test("uses only model and session for replay identity", () => {
  // Given
  const clock = createClock();
  const store = new CodexOpaqueResponsesReplayStore({ now: clock.now });
  store.store({
    model: "gpt-5-codex",
    sessionId: "shared-session",
    encryptedContent: "opaque-for-shared-session",
  });

  // When
  const replay = store.get({ model: "gpt-5-codex", sessionId: "shared-session" });

  // Then
  assert.equal(replay, "opaque-for-shared-session");
});

test("isolates entries with different models or sessions", () => {
  // Given
  const clock = createClock();
  const store = new CodexOpaqueResponsesReplayStore({ now: clock.now });
  store.store({ model: "model-a", sessionId: "session-a", encryptedContent: "entry-a" });
  store.store({ model: "model-b", sessionId: "session-a", encryptedContent: "entry-b" });

  // When
  const wrongModel = store.get({ model: "model-b", sessionId: "session-b" });
  const original = store.get({ model: "model-a", sessionId: "session-a" });
  const otherModel = store.get({ model: "model-b", sessionId: "session-a" });

  // Then
  assert.equal(wrongModel, null);
  assert.equal(original, "entry-a");
  assert.equal(otherModel, "entry-b");
});

test("refuses storage for missing or invalid sessions", () => {
  // Given
  const clock = createClock();
  const store = new CodexOpaqueResponsesReplayStore({ now: clock.now });

  // When
  const missingSession = store.store({
    model: "gpt-5-codex",
    sessionId: "",
    encryptedContent: "opaque-missing",
  });
  const invalidSession = store.store({
    model: "gpt-5-codex",
    sessionId: " \t ",
    encryptedContent: "opaque-invalid",
  });

  // Then
  assert.equal(missingSession, false);
  assert.equal(invalidSession, false);
  assert.equal(store.size(), 0);
});

test("expires entries deterministically at the configured TTL", () => {
  // Given
  const clock = createClock();
  const store = new CodexOpaqueResponsesReplayStore({ now: clock.now, ttlMs: 50 });
  store.store({ model: "gpt-5-codex", sessionId: "session-a", encryptedContent: "opaque" });

  // When
  clock.advance(49);
  const beforeExpiry = store.get({ model: "gpt-5-codex", sessionId: "session-a" });
  clock.advance(1);
  const atExpiry = store.get({ model: "gpt-5-codex", sessionId: "session-a" });

  // Then
  assert.equal(beforeExpiry, "opaque");
  assert.equal(atExpiry, null);
});

test("evicts the oldest retained entry when the bounded capacity is reached", () => {
  // Given
  const clock = createClock();
  const store = new CodexOpaqueResponsesReplayStore({ now: clock.now, maxEntries: 2 });
  store.store({ model: "gpt-5-codex", sessionId: "session-a", encryptedContent: "oldest" });
  clock.advance(1);
  store.store({ model: "gpt-5-codex", sessionId: "session-b", encryptedContent: "middle" });
  clock.advance(1);

  // When
  store.store({ model: "gpt-5-codex", sessionId: "session-c", encryptedContent: "newest" });

  // Then
  assert.equal(store.get({ model: "gpt-5-codex", sessionId: "session-a" }), null);
  assert.equal(store.get({ model: "gpt-5-codex", sessionId: "session-b" }), "middle");
  assert.equal(store.get({ model: "gpt-5-codex", sessionId: "session-c" }), "newest");
});

test("appends ordered immutable opaque turns to the model and session chain", () => {
  // Given
  const store = new CodexOpaqueResponsesReplayStore();
  const key = { model: "gpt-5-codex", sessionId: "session-a" };
  // When
  store.appendTurn({
    ...key,
    turnMarker: "turn-1",
    items: [
      { type: "reasoning", encryptedContent: "  encrypted\u0000reasoning\n" },
      {
        type: "function_call",
        callId: "fc_1",
        name: "read_file",
        arguments: '{"path":"a.ts"}',
      },
    ],
  });
  store.appendTurn({
    ...key,
    turnMarker: "turn-2",
    items: [{ type: "custom_tool_call", callId: "ctc_1", name: "shell", input: '{"cmd":"pwd"}' }],
  });
  const chain = store.getChain(key);

  // Then
  assert.deepEqual(chain, {
    turns: [
      {
        turnMarker: "turn-1",
        items: [
          { type: "reasoning", encryptedContent: "  encrypted\u0000reasoning\n" },
          {
            type: "function_call",
            callId: "fc_1",
            name: "read_file",
            arguments: '{"path":"a.ts"}',
          },
        ],
      },
      {
        turnMarker: "turn-2",
        items: [
          { type: "custom_tool_call", callId: "ctc_1", name: "shell", input: '{"cmd":"pwd"}' },
        ],
      },
    ],
  });
  assert.equal(Object.isFrozen(chain), true);
  assert.equal(Object.isFrozen(chain?.turns), true);
  assert.equal(Object.isFrozen(chain?.turns[0]), true);
  assert.equal(Object.isFrozen(chain?.turns[0]?.items), true);
  assert.equal(Object.isFrozen(chain?.turns[0]?.items[0]), true);
});

test("retains only the newest bounded replay turns for each chain", () => {
  // Given
  const store = new CodexOpaqueResponsesReplayStore({ maxTurnsPerChain: 2 });
  const key = { model: "gpt-5-codex", sessionId: "session-a" };
  store.appendTurn({
    ...key,
    turnMarker: "turn-1",
    items: [{ type: "reasoning", encryptedContent: "opaque-1" }],
  });
  store.appendTurn({
    ...key,
    turnMarker: "turn-2",
    items: [{ type: "reasoning", encryptedContent: "opaque-2" }],
  });

  // When
  store.appendTurn({
    ...key,
    turnMarker: "turn-3",
    items: [{ type: "reasoning", encryptedContent: "opaque-3" }],
  });

  // Then
  assert.deepEqual(
    store.getChain(key)?.turns.map((turn) => turn.turnMarker),
    ["turn-2", "turn-3"]
  );
});

test("isolates replay chains by both model and canonical session", () => {
  // Given
  const store = new CodexOpaqueResponsesReplayStore();
  store.appendTurn({
    model: "model-a",
    sessionId: "session-a",
    turnMarker: "turn-a",
    items: [{ type: "reasoning", encryptedContent: "opaque-a" }],
  });
  store.appendTurn({
    model: "model-b",
    sessionId: "session-a",
    turnMarker: "turn-b",
    items: [{ type: "reasoning", encryptedContent: "opaque-b" }],
  });

  // When
  const isolated = store.getChain({ model: "model-a", sessionId: "session-b" });
  const original = store.getChain({ model: "model-a", sessionId: "session-a" });
  const otherModel = store.getChain({ model: "model-b", sessionId: "session-a" });

  // Then
  assert.equal(isolated, null);
  assert.deepEqual(original?.turns[0]?.items[0], {
    type: "reasoning",
    encryptedContent: "opaque-a",
  });
  assert.deepEqual(otherModel?.turns[0]?.items[0], {
    type: "reasoning",
    encryptedContent: "opaque-b",
  });
});

test("expires and evicts whole replay chains with TTL and capacity bounds", () => {
  // Given
  const clock = createClock();
  const store = new CodexOpaqueResponsesReplayStore({ now: clock.now, ttlMs: 50, maxEntries: 2 });
  store.appendTurn({
    model: "model-a",
    sessionId: "session-a",
    turnMarker: "turn-a",
    items: [{ type: "reasoning", encryptedContent: "opaque-a" }],
  });
  clock.advance(1);
  store.appendTurn({
    model: "model-b",
    sessionId: "session-b",
    turnMarker: "turn-b",
    items: [{ type: "reasoning", encryptedContent: "opaque-b" }],
  });
  clock.advance(1);

  // When
  store.appendTurn({
    model: "model-c",
    sessionId: "session-c",
    turnMarker: "turn-c",
    items: [{ type: "reasoning", encryptedContent: "opaque-c" }],
  });
  clock.advance(49);
  const expired = store.getChain({ model: "model-b", sessionId: "session-b" });

  // Then
  assert.equal(store.getChain({ model: "model-a", sessionId: "session-a" }), null);
  assert.equal(store.getChain({ model: "model-c", sessionId: "session-c" })?.turns.length, 1);
  assert.equal(expired, null);
});

test("clears the requested replay chain without affecting other chains", () => {
  // Given
  const store = new CodexOpaqueResponsesReplayStore();
  const key = { model: "gpt-5-codex", sessionId: "session-a" };
  const otherKey = { model: "gpt-5-codex", sessionId: "session-b" };
  store.appendTurn({
    ...key,
    turnMarker: "turn-a",
    items: [{ type: "reasoning", encryptedContent: "opaque-a" }],
  });
  store.appendTurn({
    ...otherKey,
    turnMarker: "turn-b",
    items: [{ type: "reasoning", encryptedContent: "opaque-b" }],
  });

  // When
  const cleared = store.clearChain(key);

  // Then
  assert.equal(cleared, true);
  assert.equal(store.getChain(key), null);
  assert.equal(store.getChain(otherKey)?.turns[0]?.turnMarker, "turn-b");
});

test("clears only the chain whose expected current turn marker still matches", () => {
  // Given
  const store = new CodexOpaqueResponsesReplayStore();
  const key = { model: "gpt-5-codex", sessionId: "session-a" };
  store.appendTurn({
    ...key,
    turnMarker: "turn-1",
    items: [{ type: "reasoning", encryptedContent: "opaque-1" }],
  });

  // When
  const cleared = store.clearChainIfCurrent({ ...key, expectedTurnMarker: "turn-1" });

  // Then
  assert.equal(cleared, true);
  assert.equal(store.getChain(key), null);
});

test("preserves a newer chain when conditional clear uses a stale turn marker", () => {
  // Given
  const store = new CodexOpaqueResponsesReplayStore();
  const key = { model: "gpt-5-codex", sessionId: "session-a" };
  store.appendTurn({
    ...key,
    turnMarker: "turn-1",
    items: [{ type: "reasoning", encryptedContent: "opaque-1" }],
  });
  store.appendTurn({
    ...key,
    turnMarker: "turn-2",
    items: [{ type: "reasoning", encryptedContent: "opaque-2" }],
  });

  // When
  const cleared = store.clearChainIfCurrent({ ...key, expectedTurnMarker: "turn-1" });

  // Then
  assert.equal(cleared, false);
  assert.equal(store.getChain(key)?.turns.at(-1)?.turnMarker, "turn-2");
});

test("returns isolated immutable snapshots that cannot mutate retained replay state", () => {
  // Given
  const store = new CodexOpaqueResponsesReplayStore();
  const key = { model: "gpt-5-codex", sessionId: "session-a" };
  store.appendTurn({
    ...key,
    turnMarker: "turn-1",
    items: [{ type: "reasoning", encryptedContent: "opaque-1" }],
  });

  // When
  const firstRead = store.getChain(key);
  const secondRead = store.getChain(key);

  // Then
  assert.notEqual(firstRead, secondRead);
  assert.notEqual(firstRead?.turns, secondRead?.turns);
  assert.equal(Object.isFrozen(firstRead), true);
  assert.equal(Object.isFrozen(firstRead?.turns), true);
  assert.equal(Object.isFrozen(firstRead?.turns[0]?.items), true);
  assert.deepEqual(store.getChain(key)?.turns[0]?.items[0], {
    type: "reasoning",
    encryptedContent: "opaque-1",
  });
});
