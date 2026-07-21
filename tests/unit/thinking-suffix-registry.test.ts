import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { lookupModelInfo } = await import("../../open-sse/services/thinking/registry.ts");
const { splitThinkingSuffix } = await import(
  "../../open-sse/handlers/chatCore/thinkingSuffixVariant.ts"
);

const here = path.dirname(fileURLToPath(import.meta.url));
const modelsPath = path.resolve(here, "../../open-sse/services/thinking/models.json");

test("models.json loads and every thinking block is well-formed", () => {
  const raw = JSON.parse(fs.readFileSync(modelsPath, "utf8")) as Record<string, unknown[]>;
  assert.ok(Object.keys(raw).length > 0, "has provider sections");

  for (const [section, arr] of Object.entries(raw)) {
    assert.ok(Array.isArray(arr), `${section} is an array`);
    for (const entry of arr as Array<Record<string, unknown>>) {
      assert.equal(typeof entry.id, "string", `${section}: entry has id`);
      const th = entry.thinking as Record<string, unknown> | undefined | null;
      if (th == null) continue;
      if (th.min !== undefined) assert.equal(typeof th.min, "number");
      if (th.max !== undefined) assert.equal(typeof th.max, "number");
      if (th.levels !== undefined) assert.ok(Array.isArray(th.levels));
      if (th.zero_allowed !== undefined) assert.equal(typeof th.zero_allowed, "boolean");
      if (th.dynamic_allowed !== undefined) assert.equal(typeof th.dynamic_allowed, "boolean");
    }
  }
});

test("lookupModelInfo resolves opus-4-8 (level-only + dynamic, no fixed budget)", () => {
  const info = lookupModelInfo("claude-opus-4-8", "claude");
  assert.ok(info, "opus-4-8 found");
  assert.ok(info?.thinking, "has thinking");
  // Adaptive-only: no min/max budget range, has dynamic + levels.
  assert.equal(info?.thinking?.min ?? undefined, undefined);
  assert.equal(info?.thinking?.max ?? undefined, undefined);
  assert.equal(info?.thinking?.dynamic_allowed, true);
  assert.ok((info?.thinking?.levels?.length ?? 0) > 0);
});

test("lookupModelInfo returns null for unknown model", () => {
  assert.equal(lookupModelInfo("totally-made-up-model", "claude"), null);
});

test("splitThinkingSuffix strips suffix and recovers raw value", () => {
  assert.deepEqual(splitThinkingSuffix("pool-main-opus(high)"), {
    baseModel: "pool-main-opus",
    rawSuffix: "high",
  });
  assert.deepEqual(splitThinkingSuffix("claude-opus-4-8(16384)"), {
    baseModel: "claude-opus-4-8",
    rawSuffix: "16384",
  });
  assert.deepEqual(splitThinkingSuffix("pool-main-opus"), {
    baseModel: "pool-main-opus",
    rawSuffix: "",
  });
});

test("splitThinkingSuffix recovers square-bracket suffix off a pool name", () => {
  assert.deepEqual(splitThinkingSuffix("pool-main-opus[high]"), {
    baseModel: "pool-main-opus",
    rawSuffix: "high",
  });
  assert.deepEqual(splitThinkingSuffix("pool-subagent-sonnet[low]"), {
    baseModel: "pool-subagent-sonnet",
    rawSuffix: "low",
  });
  assert.deepEqual(splitThinkingSuffix("pool-main-fable[16384]"), {
    baseModel: "pool-main-fable",
    rawSuffix: "16384",
  });
});
