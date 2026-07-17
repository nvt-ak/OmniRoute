#!/usr/bin/env node
/**
 * Skip-docs build helper.
 *
 * When `OMNIROUTE_SKIP_DOCS=1` is set, `build-next-isolated.mjs` calls
 * `stubDocsPages()` BEFORE `next build` and `restoreDocsPages()` in a `finally`
 * afterward (and on SIGINT/SIGTERM) — mirroring the proven stub/restore pattern in
 * `backendOnlyPages.mjs`.
 *
 * WHY: The in-app fumadocs documentation site (`/docs`) compiles 1,187 markdown files
 * through MDX via the `withMDX()` wrap in `next.config.mjs` + `source.config.ts`. On a
 * memory/CPU-constrained machine (e.g. 16 GB) that MDX scan+compile is the dominant
 * build-time cost. Self-hosters running a standalone build who read the docs on GitHub
 * do not need the embedded docs site.
 *
 * HOW: `next.config.mjs` already drops the `withMDX()` wrap when the flag is set, so
 * fumadocs-mdx never generates `.source/server`. But the `/docs` route group
 * (`src/app/docs/**`) imports `@/lib/source` → `.source/server`; leaving those routes
 * in the build would fail with a missing-module error. This helper physically moves the
 * ENTIRE `src/app/docs/` subtree out of `src/app/` for the duration of the build so
 * Next's App Router never sees the route group (and never resolves `.source/server`),
 * then moves it back. `src/lib/source.ts` itself is left in place — nothing imports it
 * once the docs routes are gone, so it never enters the build graph.
 *
 * SAFETY: `src/app/docs/` is git-tracked, so a hard kill is recoverable via
 * `git checkout -- src/app/docs && git clean -fd src/app/docs`. The caller also restores
 * in a `finally` block and on SIGINT/SIGTERM. The move is idempotent: if the source is
 * already absent (already moved) it is a no-op.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** True when the current build should skip the in-app /docs site. */
export function isSkipDocsBuild(env = process.env) {
  return env.OMNIROUTE_SKIP_DOCS === "1";
}

/**
 * Move `src/app/docs/` out of the build tree into a temp backup directory.
 * @returns {{ source: string, backup: string } | null} restore descriptor, or null if
 *   there was nothing to move (docs dir absent / already moved).
 */
export function stubDocsPages(rootDir = process.cwd(), log = console) {
  const docsAppDir = path.join(rootDir, "src", "app", "docs");
  if (!fs.existsSync(docsAppDir)) {
    log.warn?.("[skip-docs] src/app/docs not found — nothing to move");
    return null;
  }

  const backupDir = path.join(
    os.tmpdir(),
    `omniroute-skip-docs-${process.pid}-${Date.now()}`,
    "docs"
  );

  try {
    fs.mkdirSync(path.dirname(backupDir), { recursive: true });
    fs.renameSync(docsAppDir, backupDir);
  } catch (err) {
    if (err?.code === "EXDEV") {
      // Cross-device rename: fall back to copy + remove.
      fs.cpSync(docsAppDir, backupDir, { recursive: true });
      fs.rmSync(docsAppDir, { recursive: true, force: true });
    } else {
      log.error?.(
        `[skip-docs] FAILED to move ${docsAppDir}: ${err?.message || err} — build aborted`
      );
      throw err;
    }
  }

  log.log?.("[skip-docs] Moved src/app/docs out of the build tree (/docs excluded)");
  return { source: docsAppDir, backup: backupDir };
}

/** Move the docs route group back into `src/app/`. Best-effort; logs failures. */
export function restoreDocsPages(descriptor, log = console) {
  if (!descriptor || typeof descriptor !== "object") return;
  const { source, backup } = descriptor;
  if (!source || !backup) return;
  if (!fs.existsSync(backup)) return; // already restored / nothing to do

  try {
    fs.rmSync(source, { recursive: true, force: true }); // clear any partial rebuild
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.renameSync(backup, source);
  } catch (err) {
    if (err?.code === "EXDEV") {
      fs.cpSync(backup, source, { recursive: true });
      fs.rmSync(backup, { recursive: true, force: true });
    } else {
      log.error?.(
        `[skip-docs] FAILED to restore ${source}: ${err?.message || err} — ` +
          `run \`git checkout -- src/app/docs && git clean -fd src/app/docs\` to recover`
      );
      return;
    }
  }

  // Clean up the now-empty temp backup parent directory (best effort).
  try {
    fs.rmSync(path.dirname(backup), { recursive: true, force: true });
  } catch {
    // non-fatal
  }

  log.log?.("[skip-docs] Restored src/app/docs into the build tree");
}
