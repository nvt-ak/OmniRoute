import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { getProviderServiceKinds } from "../../src/lib/providers/serviceKindIndex.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("provider filters derive media kinds without pulling Node services into the browser", async () => {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["src/app/(dashboard)/dashboard/providers/providerPageUtils.ts"],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(getProviderServiceKinds("xai", ["llm"]), ["llm", "video", "image"]);
  assert.equal(getProviderServiceKinds("openai", ["llm"]).includes("image"), true);
  assert.deepEqual(getProviderServiceKinds("unregistered", ["webFetch"]), ["webFetch"]);
});
