import test from "node:test";
import assert from "node:assert/strict";

const { parseSuffix, parseSuffixToConfig, parseNumericSuffix, parseSpecialSuffix, parseLevelSuffix } =
  await import("../../open-sse/services/thinking/suffix.ts");
const { ThinkingMode } = await import("../../open-sse/services/thinking/types.ts");

test("parseSuffix extracts level suffix", () => {
  const r = parseSuffix("claude-opus-4-8(high)");
  assert.equal(r.hasSuffix, true);
  assert.equal(r.modelName, "claude-opus-4-8");
  assert.equal(r.rawSuffix, "high");
});

test("parseSuffix extracts numeric suffix", () => {
  const r = parseSuffix("claude-opus-4-8(16384)");
  assert.equal(r.rawSuffix, "16384");
  assert.equal(r.modelName, "claude-opus-4-8");
});

test("parseSuffix: no parens → no suffix", () => {
  const r = parseSuffix("gemini-2.5-pro");
  assert.equal(r.hasSuffix, false);
  assert.equal(r.modelName, "gemini-2.5-pro");
});

test("parseSuffix: unmatched paren → no suffix", () => {
  const r = parseSuffix("model(high");
  assert.equal(r.hasSuffix, false);
  assert.equal(r.modelName, "model(high");
});

test("parseSuffix uses the LAST paren", () => {
  const r = parseSuffix("weird(name)(high)");
  assert.equal(r.modelName, "weird(name)");
  assert.equal(r.rawSuffix, "high");
});

test("parseSuffix extracts square-bracket level suffix (combo-name safe)", () => {
  const r = parseSuffix("pool-main-opus[high]");
  assert.equal(r.hasSuffix, true);
  assert.equal(r.modelName, "pool-main-opus");
  assert.equal(r.rawSuffix, "high");
});

test("parseSuffix extracts square-bracket numeric suffix", () => {
  const r = parseSuffix("pool-subagent-sonnet[16384]");
  assert.equal(r.rawSuffix, "16384");
  assert.equal(r.modelName, "pool-subagent-sonnet");
});

test("parseSuffix: square brackets preferred over round brackets", () => {
  const r = parseSuffix("weird(name)[high]");
  assert.equal(r.modelName, "weird(name)");
  assert.equal(r.rawSuffix, "high");
});

test("parseSuffix: unmatched square bracket → no suffix", () => {
  const r = parseSuffix("pool-main-opus[high");
  assert.equal(r.hasSuffix, false);
  assert.equal(r.modelName, "pool-main-opus[high");
});

test("parseSuffix: empty square-bracket content still parses (empty rawSuffix)", () => {
  const r = parseSuffix("pool-main-opus[]");
  assert.equal(r.hasSuffix, true);
  assert.equal(r.modelName, "pool-main-opus");
  assert.equal(r.rawSuffix, "");
});

test("parseNumericSuffix: leading zeros, zero, negatives", () => {
  assert.equal(parseNumericSuffix("08192"), 8192);
  assert.equal(parseNumericSuffix("0"), 0);
  assert.equal(parseNumericSuffix("-1"), null);
  assert.equal(parseNumericSuffix("high"), null);
});

test("parseSpecialSuffix: none/auto/-1", () => {
  assert.equal(parseSpecialSuffix("none"), ThinkingMode.None);
  assert.equal(parseSpecialSuffix("auto"), ThinkingMode.Auto);
  assert.equal(parseSpecialSuffix("-1"), ThinkingMode.Auto);
  assert.equal(parseSpecialSuffix("AUTO"), ThinkingMode.Auto);
  assert.equal(parseSpecialSuffix("high"), null);
});

test("parseLevelSuffix: valid levels only", () => {
  assert.equal(parseLevelSuffix("HIGH"), "high");
  assert.equal(parseLevelSuffix("xhigh"), "xhigh");
  assert.equal(parseLevelSuffix("none"), null); // special, not level
  assert.equal(parseLevelSuffix("ultra"), null);
});

test("parseSuffixToConfig priority: special → level → numeric", () => {
  assert.deepEqual(parseSuffixToConfig("none"), { mode: ThinkingMode.None, budget: 0, level: "" });
  assert.deepEqual(parseSuffixToConfig("auto"), { mode: ThinkingMode.Auto, budget: -1, level: "" });
  assert.deepEqual(parseSuffixToConfig("high"), {
    mode: ThinkingMode.Level,
    budget: 0,
    level: "high",
  });
  assert.deepEqual(parseSuffixToConfig("16384"), {
    mode: ThinkingMode.Budget,
    budget: 16384,
    level: "",
  });
  assert.deepEqual(parseSuffixToConfig("0"), { mode: ThinkingMode.None, budget: 0, level: "" });
});

test("parseSuffixToConfig: unknown → empty config", () => {
  const c = parseSuffixToConfig("bogus");
  assert.deepEqual(c, { mode: ThinkingMode.Budget, budget: 0, level: "" });
});
