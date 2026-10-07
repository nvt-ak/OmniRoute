import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("media picker compiles for the browser without Node-only dependencies", async () => {
  // A browser build deliberately has no fs/net/dns/child_process fallbacks.
  // Importing the DB-backed image registry here must fail compilation.
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["src/app/(dashboard)/dashboard/cache/media/MediaPageClient.tsx"],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});
