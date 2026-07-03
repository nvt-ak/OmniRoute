/**
 * Claude thinking-signature structural inspection.
 *
 * Ported from CLIProxyAPI (internal/signature/claude_validation.go). A Claude
 * `thinking` block carries a `signature`: an opaque base64 blob, in one or two
 * base64 layers, decoding to a protobuf payload whose first byte is 0x12.
 *
 *   E prefix → single base64 layer; decoded[0] === 0x12.
 *   R prefix → double base64 layer; decoded[0] === 'E' (0x45); the inner base64
 *              decodes to a payload whose first byte is 0x12.
 *
 * Protobuf tree (CLIProxyAPI spec sections 4.1-4.2):
 *
 *   payload
 *   |- Field 2 (bytes): container
 *   |  `- Field 1 (bytes): channelBlock
 *   |     |- Field 1 (varint): channel_id (11 | 12)
 *   |     |- Field 2 (varint): infra (optional)
 *   |     `- Field 6 (bytes):  model_text (optional, e.g. "claude-sonnet-4-6")
 *   `- Field 3 (varint): =1
 *
 * The ECDSA signature (channelBlock Field 5) binds the block to a specific
 * account and is NOT recoverable client-side, so structural validity is not
 * proof a signature will replay. But Field 6 (model_text) records WHICH model
 * minted the block — enough to detect a combo model hop (opus→sonnet) that would
 * otherwise 400 with "Invalid signature in thinking block".
 */

const MAX_SIGNATURE_LEN = 32 * 1024 * 1024;

const WIRE_VARINT = 0;
const WIRE_BYTES = 2;

function stripCachePrefix(rawSignature: string): string {
  const sig = rawSignature.trim();
  if (sig === "") return "";
  const hashIdx = sig.indexOf("#");
  if (hashIdx >= 0) return sig.slice(hashIdx + 1).trim();
  return sig;
}

function decodeBase64(value: string): Uint8Array | null {
  // Buffer.from(..., "base64") is lenient (ignores invalid chars), which would let
  // garbage like "Egarbage!!!" decode to a stray 0x12 byte. Re-encode and compare to
  // reject anything that is not clean, canonical base64.
  const buf = Buffer.from(value, "base64");
  if (buf.length === 0) return null;
  if (buf.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) return null;
  return new Uint8Array(buf);
}

/** Decode the E/R base64 layer(s) to the raw protobuf payload, or null. */
function decodeSignaturePayload(rawSignature: string): Uint8Array | null {
  const sig = stripCachePrefix(rawSignature);
  if (sig === "" || sig.length > MAX_SIGNATURE_LEN) return null;

  if (sig[0] === "E") {
    const decoded = decodeBase64(sig);
    return decoded && decoded.length > 0 && decoded[0] === 0x12 ? decoded : null;
  }
  if (sig[0] === "R") {
    const outer = decodeBase64(sig);
    if (!outer || outer.length === 0 || outer[0] !== 0x45 /* 'E' */) return null;
    const inner = decodeBase64(Buffer.from(outer).toString("latin1"));
    return inner && inner.length > 0 && inner[0] === 0x12 ? inner : null;
  }
  return null;
}

type WireField = { num: number; type: number; value: Uint8Array; varint: number };

/** Minimal protobuf wire walker: yields each top-level field of `buf`. */
function walkProtobuf(buf: Uint8Array): WireField[] | null {
  const fields: WireField[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const [tag, tagLen] = readVarint(buf, offset);
    if (tagLen < 0) return null;
    offset += tagLen;
    const num = Number(tag >> 3n);
    const type = Number(tag & 7n);
    if (type === WIRE_VARINT) {
      const [val, valLen] = readVarint(buf, offset);
      if (valLen < 0) return null;
      fields.push({ num, type, value: new Uint8Array(), varint: Number(val) });
      offset += valLen;
    } else if (type === WIRE_BYTES) {
      const [len, lenLen] = readVarint(buf, offset);
      if (lenLen < 0) return null;
      offset += lenLen;
      const end = offset + Number(len);
      if (end > buf.length) return null;
      fields.push({ num, type, value: buf.slice(offset, end), varint: 0 });
      offset = end;
    } else {
      return null; // unsupported wire type in this signature schema
    }
  }
  return fields;
}

function readVarint(buf: Uint8Array, start: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < buf.length) {
    const byte = buf[offset];
    result |= BigInt(byte & 0x7f) << shift;
    offset += 1;
    if ((byte & 0x80) === 0) return [result, offset - start];
    shift += 7n;
    if (shift > 63n) return [0n, -1];
  }
  return [0n, -1];
}

function firstBytesField(fields: WireField[], num: number): Uint8Array | null {
  for (const f of fields) {
    if (f.num === num && f.type === WIRE_BYTES) return f.value;
  }
  return null;
}

/**
 * Returns true when rawSignature decodes as a structurally-valid Claude thinking
 * signature (correct E/R base64 layering + the 0x12 Claude protobuf marker).
 * Foreign, empty, and non-decodable signatures return false.
 */
export function isStructurallyValidClaudeThinkingSignature(rawSignature: unknown): boolean {
  if (typeof rawSignature !== "string") return false;
  return decodeSignaturePayload(rawSignature) !== null;
}

/**
 * Extracts the model name (protobuf Field 2.1.6 model_text) that minted the
 * signature, or "" when the field is absent (compact schema) or the signature is
 * not a decodable Claude signature. Returned lowercased for comparison.
 */
export function extractClaudeSignatureModel(rawSignature: unknown): string {
  if (typeof rawSignature !== "string") return "";
  const payload = decodeSignaturePayload(rawSignature);
  if (!payload) return "";

  const top = walkProtobuf(payload);
  if (!top) return "";
  const container = firstBytesField(top, 2);
  if (!container) return "";
  const containerFields = walkProtobuf(container);
  if (!containerFields) return "";
  const channelBlock = firstBytesField(containerFields, 1);
  if (!channelBlock) return "";
  const channelFields = walkProtobuf(channelBlock);
  if (!channelFields) return "";
  const modelText = firstBytesField(channelFields, 6);
  if (!modelText) return "";

  try {
    return Buffer.from(modelText).toString("utf8").trim().toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Decides whether a Claude thinking signature can be safely replayed to
 * targetModel. A signature is replay-safe when it is structurally a Claude
 * signature AND either carries no model tag (compact schema — cannot prove a
 * mismatch, so we trust it) or its model tag matches the target model. A tagged
 * signature whose model differs from the target (e.g. an opus signature replayed
 * to a sonnet target in a combo) is NOT safe — Anthropic rejects it 400.
 */
export function isClaudeSignatureReplaySafeForModel(
  rawSignature: unknown,
  targetModel: string | null | undefined
): boolean {
  if (!isStructurallyValidClaudeThinkingSignature(rawSignature)) return false;
  const sigModel = extractClaudeSignatureModel(rawSignature);
  if (sigModel === "") return true; // untagged (compact) — no mismatch provable
  const rawTarget = String(targetModel || "")
    .trim()
    .toLowerCase();
  if (rawTarget === "") return true;
  const bareTarget = rawTarget.slice(rawTarget.lastIndexOf("/") + 1);
  return sigModel === bareTarget;
}
