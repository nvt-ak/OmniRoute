const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 100;

type ReplayKey = {
  readonly model: string;
  readonly sessionId: string;
};

const REPLAY_ITEM_TYPES = ["reasoning", "function_call", "custom_tool_call"] as const;

type CodexOpaqueResponsesReplayItemType = (typeof REPLAY_ITEM_TYPES)[number];

export type CodexOpaqueResponsesReplayItem =
  | {
      readonly type: "reasoning";
      readonly encryptedContent: string;
    }
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
    };

export type CodexOpaqueResponsesReplayTurn = {
  readonly turnMarker: string;
  readonly items: readonly CodexOpaqueResponsesReplayItem[];
};

export type CodexOpaqueResponsesReplayChain = {
  readonly turns: readonly CodexOpaqueResponsesReplayTurn[];
};

type ReplayEntry = {
  readonly expiresAt: number;
  readonly turns: readonly CodexOpaqueResponsesReplayTurn[];
};

export type CodexOpaqueResponsesReplayStoreOptions = {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly maxTurnsPerChain?: number;
};

export type StoreCodexOpaqueResponseReplay = ReplayKey & {
  readonly encryptedContent: string;
};

export type AppendCodexOpaqueResponseReplayTurn = ReplayKey & CodexOpaqueResponsesReplayTurn;

export type ClearCodexOpaqueResponseReplayChain = ReplayKey & {
  readonly expectedTurnMarker: string;
};

/**
 * Process-local replay state for opaque Codex Responses content.
 *
 * Chains are identified only by model and caller-provided canonical session. The
 * store retains content unchanged: it never logs, persists, decrypts, hashes,
 * parses, or normalizes opaque content.
 */
export class CodexOpaqueResponsesReplayStore {
  private readonly entries = new Map<string, ReplayEntry>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxTurnsPerChain: number;

  constructor(options: CodexOpaqueResponsesReplayStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = positiveIntegerOrDefault(options.ttlMs, DEFAULT_TTL_MS);
    this.maxEntries = positiveIntegerOrDefault(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.maxTurnsPerChain = positiveIntegerOrDefault(options.maxTurnsPerChain, DEFAULT_MAX_ENTRIES);
  }

  /** @deprecated Use appendTurn() for new replay capture. */
  store(value: StoreCodexOpaqueResponseReplay): boolean {
    if (!hasSession(value.sessionId)) return false;

    this.write(value, [
      freezeTurn({
        turnMarker: value.encryptedContent,
        items: [{ type: "reasoning", encryptedContent: value.encryptedContent }],
      }),
    ]);
    return true;
  }

  /** @deprecated Use getChain() for new replay execution. */
  get(key: ReplayKey): string | null {
    const chain = this.getChain(key);
    const latestTurn = chain?.turns.at(-1);
    const latestItem = latestTurn?.items.at(-1);
    return latestItem?.type === "reasoning" ? latestItem.encryptedContent : null;
  }

  appendTurn(value: AppendCodexOpaqueResponseReplayTurn): boolean {
    if (!hasSession(value.sessionId)) return false;

    const key = toKey(value);
    const now = this.now();
    this.evictExpired(now);
    const existing = this.entries.get(key);
    const turns = existing ? [...existing.turns, freezeTurn(value)] : [freezeTurn(value)];
    this.write(value, turns.slice(-this.maxTurnsPerChain), now);
    return true;
  }

  getChain(key: ReplayKey): CodexOpaqueResponsesReplayChain | null {
    if (!hasSession(key.sessionId)) return null;

    const mapKey = toKey(key);
    const entry = this.entries.get(mapKey);
    if (!entry) return null;

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(mapKey);
      return null;
    }

    return freezeChain(entry.turns);
  }

  clearChain(key: ReplayKey): boolean {
    if (!hasSession(key.sessionId)) return false;

    this.evictExpired(this.now());
    return this.entries.delete(toKey(key));
  }

  clearChainIfCurrent(value: ClearCodexOpaqueResponseReplayChain): boolean {
    if (!hasSession(value.sessionId)) return false;

    const key = toKey(value);
    const entry = this.entries.get(key);
    const latestTurn = entry?.turns.at(-1);
    if (
      !entry ||
      entry.expiresAt <= this.now() ||
      latestTurn?.turnMarker !== value.expectedTurnMarker
    ) {
      if (entry?.expiresAt <= this.now()) this.entries.delete(key);
      return false;
    }

    this.entries.delete(key);
    return true;
  }

  size(): number {
    this.evictExpired(this.now());
    return this.entries.size;
  }

  private write(
    key: ReplayKey,
    turns: readonly CodexOpaqueResponsesReplayTurn[],
    now = this.now()
  ): void {
    this.evictExpired(now);
    const mapKey = toKey(key);
    if (!this.entries.has(mapKey)) this.evictOldestUntilSpace();
    this.entries.set(mapKey, { expiresAt: now + this.ttlMs, turns: Object.freeze([...turns]) });
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  private evictOldestUntilSpace(): void {
    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) return;
      this.entries.delete(oldestKey);
    }
  }
}

export const codexOpaqueResponsesReplayStore = new CodexOpaqueResponsesReplayStore();

function freezeChain(
  turns: readonly CodexOpaqueResponsesReplayTurn[]
): CodexOpaqueResponsesReplayChain {
  return Object.freeze({ turns: Object.freeze(turns.map(freezeTurn)) });
}

function freezeTurn(turn: CodexOpaqueResponsesReplayTurn): CodexOpaqueResponsesReplayTurn {
  return Object.freeze({
    turnMarker: turn.turnMarker,
    items: Object.freeze(turn.items.map((item) => Object.freeze({ ...item }))),
  });
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function hasSession(sessionId: string): boolean {
  return sessionId.trim().length > 0;
}

function toKey({ model, sessionId }: ReplayKey): string {
  return JSON.stringify([model, sessionId]);
}
