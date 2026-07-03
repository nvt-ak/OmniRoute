import test from "node:test";
import assert from "node:assert/strict";

const {
  isStructurallyValidClaudeThinkingSignature,
  extractClaudeSignatureModel,
  isClaudeSignatureReplaySafeForModel,
} = await import("../../open-sse/utils/claudeThinkingSignature.ts");

// Build a synthetic-but-structurally-real Claude thinking signature, mirroring the
// CLIProxyAPI protobuf fixture (internal/signature/provider_compatibility_test.go):
//   payload = Field2(bytes)=container + Field3(varint)=1
//   container = Field1(bytes)=channelBlock
//   channelBlock = Field1(varint)=channel_id(12) + Field2(varint)=infra(2) + Field6(bytes)=model_text
// The payload's first byte is the Field2-bytes tag (2<<3|2 = 0x12), so its base64 form
// begins with 'E' — exactly the single-layer Claude signature shape.
function varint(n: number): Buffer {
  const bytes: number[] = [];
  let v = n;
  do {
    let x = v & 0x7f;
    v >>>= 7;
    if (v) x |= 0x80;
    bytes.push(x);
  } while (v);
  return Buffer.from(bytes);
}
function tag(num: number, type: number): Buffer {
  return varint((num << 3) | type);
}
function buildClaudeSignature(modelName: string | null): string {
  const parts: Buffer[] = [tag(1, 0), varint(12), tag(2, 0), varint(2)];
  if (modelName !== null) {
    parts.push(tag(6, 2), varint(Buffer.byteLength(modelName)), Buffer.from(modelName));
  }
  const channelBlock = Buffer.concat(parts);
  const container = Buffer.concat([tag(1, 2), varint(channelBlock.length), channelBlock]);
  const payload = Buffer.concat([
    tag(2, 2),
    varint(container.length),
    container,
    tag(3, 0),
    varint(1),
  ]);
  return payload.toString("base64");
}

const SONNET_46_SIG = buildClaudeSignature("claude-sonnet-4-6");
const OPUS_SIG = buildClaudeSignature("claude-opus-4-8");
const COMPACT_SIG = buildClaudeSignature(null); // no model tag

test("isStructurallyValidClaudeThinkingSignature accepts real Claude signatures", () => {
  assert.equal(isStructurallyValidClaudeThinkingSignature(SONNET_46_SIG), true);
  assert.equal(isStructurallyValidClaudeThinkingSignature(COMPACT_SIG), true);
});

test("isStructurallyValidClaudeThinkingSignature rejects empty / garbage / non-string", () => {
  assert.equal(isStructurallyValidClaudeThinkingSignature(""), false);
  assert.equal(isStructurallyValidClaudeThinkingSignature("Egarbage!!!"), false);
  assert.equal(isStructurallyValidClaudeThinkingSignature("not-base64"), false);
  assert.equal(isStructurallyValidClaudeThinkingSignature(null), false);
  assert.equal(isStructurallyValidClaudeThinkingSignature(undefined), false);
  assert.equal(isStructurallyValidClaudeThinkingSignature(123), false);
});

test("extractClaudeSignatureModel reads the model_text tag (lowercased)", () => {
  assert.equal(extractClaudeSignatureModel(SONNET_46_SIG), "claude-sonnet-4-6");
  assert.equal(extractClaudeSignatureModel(OPUS_SIG), "claude-opus-4-8");
  assert.equal(extractClaudeSignatureModel(COMPACT_SIG), "");
  assert.equal(extractClaudeSignatureModel("garbage"), "");
});

test("replay-safe when the signature model matches the target model", () => {
  assert.equal(isClaudeSignatureReplaySafeForModel(SONNET_46_SIG, "claude-sonnet-4-6"), true);
  assert.equal(
    isClaudeSignatureReplaySafeForModel(SONNET_46_SIG, "claude/claude-sonnet-4-6"),
    true
  );
});

test("NOT replay-safe on a cross-model combo hop (opus signature → sonnet target)", () => {
  assert.equal(isClaudeSignatureReplaySafeForModel(OPUS_SIG, "claude-sonnet-5"), false);
  assert.equal(isClaudeSignatureReplaySafeForModel(OPUS_SIG, "claude-sonnet-4-6"), false);
  assert.equal(isClaudeSignatureReplaySafeForModel(SONNET_46_SIG, "claude-opus-4-8"), false);
});

test("compact (untagged) signatures are trusted (no mismatch provable)", () => {
  assert.equal(isClaudeSignatureReplaySafeForModel(COMPACT_SIG, "claude-sonnet-5"), true);
  assert.equal(isClaudeSignatureReplaySafeForModel(COMPACT_SIG, "anything"), true);
});

test("structurally-invalid signatures are never replay-safe", () => {
  assert.equal(isClaudeSignatureReplaySafeForModel("", "claude-sonnet-5"), false);
  assert.equal(isClaudeSignatureReplaySafeForModel("garbage", "claude-sonnet-5"), false);
  assert.equal(isClaudeSignatureReplaySafeForModel(undefined, "claude-sonnet-5"), false);
});
