/**
 * Client bundles must not reach server-only modules.
 *
 * Two production build failures came from this exact class, both by way of a
 * `"use client"` dashboard page importing one small helper out of a module whose
 * *other* exports are server-only:
 *
 *   1. ComboControlCenterClient → combos/controlCenter → services/model.ts
 *      → `await import("@/lib/db/readCache")` → ioredis / sharp
 *      → `Module not found: Can't resolve 'net' | 'dns' | 'fs' | 'child_process'`
 *
 *   2. CliAgentsPageClient → shared/constants/cliTools → providerRegistry
 *      → providers/codebuddy-cn → oauth constants → utils/cursorAgentCliVersion.ts
 *      → `UnhandledSchemeError: Reading from "node:fs" is not handled by plugins`
 *
 * Neither was caught by tsc or by any unit test — both compile and run fine under
 * Node. Only `next build` failed, minutes into CI. This walks the static import
 * graph (plus `await import()` / `require()`, since webpack resolves those too)
 * from each client entry and fails on the first server-only specifier reached.
 *
 * When this fails: do NOT add webpack `resolve.fallback` shims — that ships dead
 * Node polyfills to the browser and hides the leak. Move the value the client
 * actually needs into a module without server dependencies, and re-export it from
 * the original so server callers keep working and no second copy can drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

/** Bare specifiers that pull Node builtins in and break the browser bundle. */
const SERVER_ONLY_PACKAGES = new Set([
  "ioredis",
  "sharp",
  "detect-libc",
  "better-sqlite3",
  "fs",
  "net",
  "dns",
  "child_process",
  "os",
  "path",
  "worker_threads",
]);

/** Client entries whose import graphs have regressed in production builds. */
const CLIENT_ENTRIES = [
  "src/app/(dashboard)/dashboard/cli-agents/CliAgentsPageClient.tsx",
  "src/app/(dashboard)/dashboard/combos/ComboControlCenterClient.tsx",
  "src/app/(dashboard)/dashboard/HomePageClient.tsx",
];

const SOURCE_RE = /\.(tsx?|mjs|jsx?|cjs)$/;

/**
 * Mirrors tsconfig.json `compilerOptions.paths`. Kept explicit so a renamed or
 * added alias shows up as an unresolved specifier (asserted below) instead of
 * silently pruning a whole subtree from the walk.
 */
const PATH_ALIASES: Array<[RegExp, string]> = [
  [/^@omniroute\/browser-pool$/, "packages/browser-pool/src"],
  [/^@omniroute\/open-sse$/, "open-sse"],
  [/^@omniroute\/open-sse\//, "open-sse/"],
  [/^@\//, "src/"],
];

/** Specifiers that must resolve locally; anything else is a bare npm package. */
const ALIASED_OR_RELATIVE = /^(\.|@\/|@omniroute\/)/;

function resolveSpecifier(spec: string, importer: string): string | null {
  let base: string | null = null;
  if (spec.startsWith(".")) {
    base = resolve(dirname(importer), spec);
  } else {
    for (const [pattern, target] of PATH_ALIASES) {
      if (!pattern.test(spec)) continue;
      base = resolve(".", spec.replace(pattern, target));
      break;
    }
  }
  if (!base) return null;

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.js`,
    `${base}.jsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
    join(base, "index.js"),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/**
 * Every specifier webpack actually resolves: static value imports, dynamic
 * `import()`, and `require()`.
 *
 * `import type …` / `export type …` are excluded — SWC erases them, so they
 * create no bundle edge and cannot leak a Node-only dep. Same rule as
 * tests/unit/authz/spawn-capable-prefixes-client-safe.test.ts.
 */
function specifiersOf(source: string): string[] {
  const specs: string[] = [];
  // import|export [type] [<clause> from] "<spec>" — `[^"';]*?` spans multi-line clauses.
  const staticRe = /\b(?:import|export)\s+(type\s+)?(?:[^"';]*?\bfrom\s*)?["']([^"']+)["']/g;
  for (let m = staticRe.exec(source); m; m = staticRe.exec(source)) {
    if (m[1]) continue; // `import type` — erased, no webpack edge
    specs.push(m[2]);
  }
  for (const m of source.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1]);
  for (const m of source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1]);
  return specs;
}

function findServerLeaks(entry: string): { leaks: string[]; unresolved: string[] } {
  const visited = new Set<string>();
  const leaks: string[] = [];
  const unresolved: string[] = [];

  const walk = (file: string, trail: string[]) => {
    if (visited.has(file) || !SOURCE_RE.test(file)) return;
    visited.add(file);

    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      return;
    }

    for (const spec of specifiersOf(source)) {
      const bare = spec.replace(/^node:/, "").split("/")[0];
      if (spec.startsWith("node:") || SERVER_ONLY_PACKAGES.has(bare)) {
        const rel = file.replace(`${process.cwd()}/`, "");
        // Trail makes the fix obvious: it names the edge to cut.
        const via = [...trail.slice(-2), rel].map((f) => f.split("/").pop()).join(" → ");
        leaks.push(`${spec} reached via ${via}\n      in ${rel}`);
        continue;
      }
      const resolved = resolveSpecifier(spec, file);
      if (resolved) {
        walk(resolved, [...trail, file.replace(`${process.cwd()}/`, "")]);
      } else if (ALIASED_OR_RELATIVE.test(spec)) {
        // A specifier that looks local but did not resolve means the walk stopped
        // early — anything server-only behind it would pass vacuously.
        unresolved.push(`${spec} <- ${file.replace(`${process.cwd()}/`, "")}`);
      }
    }
  };

  walk(resolve(entry), []);
  return { leaks: [...new Set(leaks)], unresolved: [...new Set(unresolved)] };
}

/**
 * Local-looking specifiers the walker legitimately cannot resolve. Pinned so a
 * renamed alias or moved file surfaces as a failure here rather than silently
 * pruning a subtree and turning the leak checks into vacuous passes.
 *
 * Current sole entry is a doc-comment example inside publicCreds.ts, not a real
 * import — the regex sees the string in a `node -e '…'` usage snippet.
 */
const EXPECTED_UNRESOLVED = ["./open-sse/utils/publicCreds.ts <- open-sse/utils/publicCreds.ts"];

for (const entry of CLIENT_ENTRIES) {
  test(`client entry imports no server-only module: ${entry.split("/").pop()}`, () => {
    assert.ok(existsSync(resolve(entry)), `entry moved or renamed: ${entry}`);
    const { leaks, unresolved } = findServerLeaks(entry);

    assert.deepEqual(
      leaks,
      [],
      `${entry} reaches server-only modules — next build will fail:\n\n  ${leaks.join("\n\n  ")}\n`
    );

    const unexpected = unresolved.filter((u) => !EXPECTED_UNRESOLVED.includes(u));
    assert.deepEqual(
      unexpected,
      [],
      `Walker could not resolve these local specifiers, so anything server-only behind ` +
        `them is unchecked. Add the alias to PATH_ALIASES (mirroring tsconfig paths) or, ` +
        `if genuinely not an import, to EXPECTED_UNRESOLVED:\n  ${unexpected.join("\n  ")}`
    );
  });
}

// Guards the walker itself: a module that genuinely imports node:fs must be
// reported. Without this, a resolver regression would silently turn every
// assertion above into a vacuous pass.
test("walker detects a known server-only module", () => {
  const { leaks } = findServerLeaks("open-sse/utils/cursorAgentCliVersion.ts");
  assert.ok(
    leaks.some((l) => l.startsWith("node:fs")),
    "walker failed to flag node:fs in cursorAgentCliVersion.ts — detection is broken"
  );
});

// Guards the type-import exclusion: `import type` is erased by SWC and creates no
// webpack edge, so it must NOT be reported — otherwise this test fails on leaks
// that do not exist in the real bundle.
test("type-only imports are not treated as bundle edges", () => {
  const valueAndType = specifiersOf(
    [
      'import type { Foo } from "node:fs";',
      'export type { Bar } from "ioredis";',
      'import { real } from "./thing";',
    ].join("\n")
  );
  assert.deepEqual(valueAndType, ["./thing"]);
});
