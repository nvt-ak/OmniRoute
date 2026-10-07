import { appendBoundedText } from "../../../utils/streamHelpers.ts";
import { normalizeOutputIndex } from "./pureHelpers.ts";

type TextKind = "content" | "refusal";
interface Fragment {
  text: string;
  order: number;
}
interface TextPart {
  fragments: Fragment[];
  length: number;
  // Leading whitespace-only refusal text waits here until meaningful text arrives,
  // so a whitespace-only refusal never surfaces as a fabricated refusal.
  pendingRefusal?: string;
}
interface TextItem {
  id?: string;
  commentary: boolean;
  parts: Map<number | null, TextPart>;
  refusals: Map<number | null, TextPart>;
}
interface TextTracker {
  closed: boolean;
  sequence: number;
  items: Set<TextItem>;
  byId: Map<string, TextItem>;
  byIndex: Map<number, TextItem>;
  anonymous?: TextItem;
}
interface TextState {
  responsesTextSnapshots?: TextTracker;
  responsesRefusalObserved?: boolean;
  dropResponsesCommentary?: boolean;
  accumulatedContent?: string;
  chatId?: string;
  created?: number;
  model?: string;
}
interface Identity {
  item_id?: unknown;
  output_index?: unknown;
  content_index?: unknown;
  phase?: unknown;
  part?: unknown;
}
type Snapshot = Record<string, unknown>;

function tracker(state: TextState): TextTracker {
  return (state.responsesTextSnapshots ??= {
    closed: false,
    sequence: 0,
    items: new Set(),
    byId: new Map(),
    byIndex: new Map(),
  });
}
function object(value: unknown): Snapshot | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Snapshot) : null;
}
function index(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? normalizeOutputIndex(value) : undefined;
}
function partsOf(item: TextItem, kind: TextKind): Map<number | null, TextPart> {
  return kind === "refusal" ? item.refusals : item.parts;
}
function dropsCommentary(state: TextState): boolean {
  return state.dropResponsesCommentary !== false;
}
/** Responses output messages are assistant-authored; some providers omit the role. */
function isAssistantMessage(snapshot: Snapshot | null): snapshot is Snapshot {
  return snapshot?.type === "message" && (snapshot.role ?? "assistant") === "assistant";
}
function mergeParts(target: TextPart, source: TextPart): void {
  // Fragments from aliases may interleave before an item event links their IDs.
  for (const fragment of source.fragments) target.fragments.push(fragment);
  target.fragments.sort((a, b) => a.order - b.order);
  target.length += source.length;
  if (source.pendingRefusal) {
    target.pendingRefusal = (target.pendingRefusal ?? "") + source.pendingRefusal;
  }
}
function mergeItems(t: TextTracker, target: TextItem, source: TextItem): void {
  for (const kind of ["content", "refusal"] as const) {
    const targetParts = partsOf(target, kind);
    for (const [key, part] of partsOf(source, kind)) {
      const existing = targetParts.get(key);
      if (existing) mergeParts(existing, part);
      else targetParts.set(key, part);
    }
  }
  target.commentary ||= source.commentary;
  for (const [key, item] of t.byIndex) if (item === source) t.byIndex.set(key, target);
  for (const [key, item] of t.byId) if (item === source) t.byId.set(key, target);
  if (t.anonymous === source) t.anonymous = undefined;
  t.items.delete(source);
}
function resolveItem(t: TextTracker, identity: Identity, allowAnonymous = false): TextItem {
  const id =
    typeof identity.item_id === "string" && identity.item_id ? identity.item_id : undefined;
  const outputIndex = index(identity.output_index);
  const commentary =
    identity.phase === "commentary" || object(identity.part)?.phase === "commentary";
  if (!id && outputIndex === undefined && t.anonymous) {
    t.anonymous.commentary ||= commentary;
    return t.anonymous;
  }
  const byId = id ? t.byId.get(id) : undefined;
  const byIndex = outputIndex !== undefined ? t.byIndex.get(outputIndex) : undefined;
  // Explicit IDs are authoritative; a malformed reused output index must not merge them.
  const compatibleIndex =
    byIndex && (!id || !byIndex.id || byIndex.id === id) ? byIndex : undefined;
  let item = byId ?? compatibleIndex;
  if (byId && compatibleIndex && byId !== compatibleIndex) mergeItems(t, byId, compatibleIndex);
  // Only a complete, single-message snapshot can prove where anonymous deltas belong.
  if (allowAnonymous && t.anonymous && t.items.size === (item ? 2 : 1)) {
    if (item) mergeItems(t, item, t.anonymous);
    else {
      item = t.anonymous;
      t.anonymous = undefined;
    }
  }
  if (!item) {
    item = { commentary: false, parts: new Map(), refusals: new Map() };
    t.items.add(item);
  }
  item.commentary ||= commentary;
  if (id) {
    item.id = id;
    t.byId.set(id, item);
  }
  if (outputIndex !== undefined) t.byIndex.set(outputIndex, item);
  if (!id && outputIndex === undefined) t.anonymous = item;
  return item;
}
function resolvePart(
  item: TextItem,
  kind: TextKind,
  contentIndex: unknown,
  allowAnonymous: boolean,
  snapshot: string
): TextPart | null {
  const parts = partsOf(item, kind);
  const key = index(contentIndex) ?? null;
  if (key === null && [...parts.keys()].some((partKey) => partKey !== null)) return null;
  const anonymous = parts.get(null);
  if (key !== null && anonymous) {
    const existing = parts.get(key);
    if (!allowAnonymous || parts.size > (existing ? 2 : 1)) return null;
    const fragments = [...(existing?.fragments ?? []), ...anonymous.fragments].sort(
      (a, b) => a.order - b.order
    );
    if (!snapshot.startsWith(fragments.map((fragment) => fragment.text).join(""))) return null;
    if (existing) mergeParts(existing, anonymous);
    parts.delete(null);
    if (!existing) parts.set(key, anonymous);
  }
  let part = parts.get(key);
  if (!part) {
    part = { fragments: [], length: 0 };
    parts.set(key, part);
  }
  return part;
}
function reconcile(t: TextTracker, part: TextPart, snapshot: string): string {
  if (snapshot.length < part.length) return "";
  let offset = 0;
  for (const fragment of part.fragments) {
    if (!snapshot.startsWith(fragment.text, offset)) return "";
    offset += fragment.text.length;
  }
  const suffix = snapshot.slice(part.length);
  // Compact only at a snapshot, never on each streamed delta (linear retained text).
  part.fragments = snapshot ? [{ text: snapshot, order: t.sequence++ }] : [];
  part.length = snapshot.length;
  // A snapshot carries the whole part, including any buffered refusal prefix.
  part.pendingRefusal = undefined;
  return suffix;
}
/** Snapshot suffixes and refusals never pass through the stream's raw output_text.delta accumulator. */
function noteEmitted(state: TextState, kind: TextKind, text: string, snapshot: boolean): void {
  if (!text) return;
  if (kind === "refusal") state.responsesRefusalObserved = true;
  if ((snapshot || kind === "refusal") && typeof state.accumulatedContent === "string") {
    state.accumulatedContent = appendBoundedText(state.accumulatedContent, text);
  }
}
export function buildTextSnapshotChunk(
  state: TextState,
  text: string,
  kind: TextKind = "content"
): Record<string, unknown> {
  return {
    id: state.chatId,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model || "gpt-4",
    choices: [{ index: 0, delta: { [kind]: text }, finish_reason: null }],
  };
}
/** Track a streamed delta; returns the text to emit now ("" when nothing should be emitted). */
export function recordResponsesTextDelta(
  state: TextState,
  identity: Identity,
  text: string,
  kind: TextKind = "content"
): string {
  const t = tracker(state);
  if (t.closed) return kind === "content" ? text : "";
  // Missing identity is provenance we do not know yet, not the sole item/part seen so far.
  const item = resolveItem(t, identity);
  if (item.commentary && dropsCommentary(state)) return "";
  const parts = partsOf(item, kind);
  const key = index(identity.content_index) ?? null;
  let part = parts.get(key);
  if (!part) {
    part = { fragments: [], length: 0 };
    parts.set(key, part);
  }
  let emitted = text;
  if (kind === "refusal" && part.length === 0) {
    emitted = (part.pendingRefusal ?? "") + text;
    if (!emitted.trim()) {
      part.pendingRefusal = emitted;
      return "";
    }
    part.pendingRefusal = undefined;
  }
  part.fragments.push({ text: emitted, order: t.sequence++ });
  part.length += emitted.length;
  noteEmitted(state, kind, emitted, false);
  return emitted;
}
export function reconcileResponsesTextDone(
  state: TextState,
  identity: Identity,
  text: unknown,
  kind: TextKind = "content"
): string {
  const t = tracker(state);
  if (t.closed || typeof text !== "string" || !text) return "";
  if (kind === "refusal" && !text.trim()) return "";
  const item = resolveItem(t, identity);
  if (item.commentary && dropsCommentary(state)) return "";
  if (t.anonymous && t.items.size > 1) return "";
  if (index(identity.content_index) === undefined && partsOf(item, kind).size > 1) return "";
  const part = resolvePart(item, kind, identity.content_index, false, text);
  const suffix = part ? reconcile(t, part, text) : "";
  noteEmitted(state, kind, suffix, true);
  return suffix;
}
export function bindResponsesTextItem(
  state: TextState,
  value: unknown,
  outputIndex: unknown
): void {
  const item = object(value);
  if (isAssistantMessage(item)) {
    resolveItem(tracker(state), { item_id: item.id, output_index: outputIndex, phase: item.phase });
  }
}
function snapshotText(part: Snapshot): { kind: TextKind; text: string } | null {
  if (part.type === "output_text" && typeof part.text === "string") {
    return { kind: "content", text: part.text };
  }
  // A whitespace-only refusal is not a refusal; never fabricate one.
  if (part.type === "refusal" && typeof part.refusal === "string" && part.refusal.trim()) {
    return { kind: "refusal", text: part.refusal };
  }
  return null;
}
function recoverItem(
  state: TextState,
  t: TextTracker,
  item: TextItem,
  snapshot: Snapshot
): Record<string, unknown>[] {
  if (!Array.isArray(snapshot.content)) return [];
  if (item.commentary && dropsCommentary(state)) return [];
  const parts = snapshot.content
    .map((part, contentIndex) => {
      const value = object(part);
      return { text: value ? snapshotText(value) : null, contentIndex };
    })
    .filter(
      (entry): entry is { text: { kind: TextKind; text: string }; contentIndex: number } =>
        entry.text !== null
    );
  const recovered: Record<string, unknown>[] = [];
  for (const { text, contentIndex } of parts) {
    const sameKind = parts.filter((entry) => entry.text.kind === text.kind).length;
    const tracked = resolvePart(item, text.kind, contentIndex, sameKind === 1, text.text);
    if (!tracked) continue;
    const suffix = reconcile(t, tracked, text.text);
    if (!suffix) continue;
    noteEmitted(state, text.kind, suffix, true);
    recovered.push(buildTextSnapshotChunk(state, suffix, text.kind));
  }
  return recovered;
}
export function synthesizeTextItemSnapshot(
  state: TextState,
  value: unknown,
  outputIndex: unknown
): Record<string, unknown>[] {
  const t = tracker(state);
  const snapshot = object(value);
  if (t.closed || !isAssistantMessage(snapshot)) return [];
  const item = resolveItem(
    t,
    { item_id: snapshot.id, output_index: outputIndex, phase: snapshot.phase },
    t.items.size === 1 && !!t.anonymous
  );
  if (t.anonymous && t.items.size > 1) return [];
  return recoverItem(state, t, item, snapshot);
}
/** Reconcile a `response.content_part.done` snapshot for one output_text/refusal part. */
export function reconcileResponsesContentPartDone(
  state: TextState,
  identity: Identity
): Record<string, unknown>[] {
  const part = object(identity.part);
  const text = part ? snapshotText(part) : null;
  if (!text) return [];
  const suffix = reconcileResponsesTextDone(state, identity, text.text, text.kind);
  return suffix ? [buildTextSnapshotChunk(state, suffix, text.kind)] : [];
}
// Key by the original output position so callers can interleave text with tool snapshots.
export function recoverTextSnapshotsByOutputIndex(
  state: TextState,
  output: unknown
): Map<number, Record<string, unknown>[]> {
  const recovered = new Map<number, Record<string, unknown>[]>();
  const t = tracker(state);
  if (t.closed) return recovered;
  const items = (Array.isArray(output) ? output : [])
    .map((value, position) => ({
      snapshot: object(value),
      outputIndex: position,
    }))
    .filter(({ snapshot }) => isAssistantMessage(snapshot));
  // Bind all identities before recovering anything: an anonymous prefix cannot be
  // assigned to the first of multiple messages merely because it was visited first.
  const resolved = items.map(({ snapshot, outputIndex }) => ({
    snapshot,
    outputIndex,
    item: resolveItem(
      t,
      { item_id: snapshot.id, output_index: outputIndex, phase: snapshot.phase },
      items.length === 1
    ),
  }));
  if (t.anonymous && t.items.size > 1) return recovered;
  for (const { snapshot, item, outputIndex } of resolved) {
    recovered.set(outputIndex, recoverItem(state, t, item, snapshot));
  }
  return recovered;
}
export function closeResponsesTextSnapshots(state: TextState): void {
  const t = tracker(state);
  t.closed = true;
  t.items.clear();
  t.byId.clear();
  t.byIndex.clear();
  t.anonymous = undefined;
}
