import type {
  AppendCodexOpaqueResponseReplayTurn,
  CodexOpaqueResponsesReplayItem,
} from "../../services/codexOpaqueResponsesReplayStore.ts";

export type CodexOpaqueResponsesReplayContext = {
  readonly model: string;
  readonly sessionId: string;
  readonly store: (value: AppendCodexOpaqueResponseReplayTurn) => boolean | void;
};

type JsonRecord = Record<string, unknown>;

type ResponsesEvent = {
  eventName: string;
  dataLines: string[];
};

type BufferedReplayItem = {
  readonly outputIndex: number;
  readonly item: CodexOpaqueResponsesReplayItem;
};

export function wrapWithCodexOpaqueResponsesReplayCapture(
  replay: CodexOpaqueResponsesReplayContext,
  nextTransform: TransformStream<Uint8Array, Uint8Array>
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const observer = new ResponsesEventObserver(replay);
  const capture = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      observer.accept(decoder.decode(chunk, { stream: true }));
      controller.enqueue(chunk);
    },
    flush() {
      observer.accept(decoder.decode());
      observer.finish();
    },
  });

  return {
    readable: capture.readable.pipeThrough(nextTransform),
    writable: capture.writable,
  };
}

class ResponsesEventObserver {
  private pendingLine = "";
  private event: ResponsesEvent = { eventName: "", dataLines: [] };
  private readonly items: BufferedReplayItem[] = [];
  private failed = false;
  private committed = false;

  constructor(private readonly replay: CodexOpaqueResponsesReplayContext) {}

  accept(text: string): void {
    const lines = `${this.pendingLine}${text}`.split("\n");
    this.pendingLine = lines.pop() ?? "";
    for (const rawLine of lines) {
      this.acceptLine(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
    }
  }

  finish(): void {
    if (this.pendingLine) this.acceptLine(this.pendingLine);
    this.observeEvent();
  }

  private acceptLine(line: string): void {
    if (!line) {
      this.observeEvent();
      this.event = { eventName: "", dataLines: [] };
      return;
    }
    if (line.startsWith("event:")) {
      this.event = { ...this.event, eventName: line.slice("event:".length).trim() };
      return;
    }
    if (line.startsWith("data:")) {
      this.event = {
        ...this.event,
        dataLines: [...this.event.dataLines, line.slice("data:".length).trimStart()],
      };
    }
  }

  private observeEvent(): void {
    if (this.event.dataLines.length === 0) return;

    try {
      const root = asRecord(JSON.parse(this.event.dataLines.join("\n")));
      if (this.event.eventName === "response.failed") this.failed = true;
      if (this.event.eventName === "response.output_item.done") this.bufferItem(root);
      if (this.event.eventName === "response.completed") this.commit(root);
    } catch (error) {
      if (error instanceof SyntaxError) return;
      throw error;
    }
  }

  private bufferItem(root: JsonRecord): void {
    const outputIndex = root.output_index;
    const item = toReplayItem(asRecord(root.item));
    if (
      root.type !== "response.output_item.done" ||
      typeof outputIndex !== "number" ||
      !Number.isSafeInteger(outputIndex) ||
      !item
    ) {
      return;
    }
    this.items.push({ outputIndex, item });
  }

  private commit(root: JsonRecord): void {
    if (this.failed || this.committed || root.type !== "response.completed") return;

    const response = asRecord(root.response);
    const output = response.output;
    const items = Array.isArray(output)
      ? output.map((value) => toReplayItem(asRecord(value))).filter(isReplayItem)
      : this.items
          .slice()
          .sort((left, right) => left.outputIndex - right.outputIndex)
          .map(({ item }) => item);
    const turnMarker = response.id;
    if (typeof turnMarker !== "string" || items.length === 0) return;

    this.replay.store({
      model: this.replay.model,
      sessionId: this.replay.sessionId,
      turnMarker,
      items,
    });
    this.committed = true;
  }
}

function toReplayItem(value: JsonRecord): CodexOpaqueResponsesReplayItem | null {
  const type = value.type;
  if (type === "reasoning" && typeof value.encrypted_content === "string") {
    return { type, encryptedContent: value.encrypted_content };
  }
  if (
    type === "function_call" &&
    typeof value.call_id === "string" &&
    typeof value.name === "string" &&
    typeof value.arguments === "string"
  ) {
    return { type, callId: value.call_id, name: value.name, arguments: value.arguments };
  }
  if (
    type === "custom_tool_call" &&
    typeof value.call_id === "string" &&
    typeof value.name === "string" &&
    typeof value.input === "string"
  ) {
    return { type, callId: value.call_id, name: value.name, input: value.input };
  }
  return null;
}

function isReplayItem(
  value: CodexOpaqueResponsesReplayItem | null
): value is CodexOpaqueResponsesReplayItem {
  return value !== null;
}

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}
