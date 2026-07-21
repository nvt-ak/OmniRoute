/**
 * Thinking-model registry — loads `models.json` (ported from CLIProxyAPI
 * `internal/registry/models/models.json`) and resolves per-model thinking
 * capability. Only the thinking-relevant fields are consumed here; the rest of
 * OmniRoute's model metadata still lives in `modelSpecs.ts`.
 *
 * Path resolution follows the compression `ruleLoader.ts` pattern (multi-candidate
 * dir walk from process.cwd(), no `import.meta.url`/`__dirname` — both are frozen
 * to the build-machine path in the Next standalone bundle).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type { ModelInfo } from "./types.ts";

/** Top-level sections in models.json that map to a provider family. */
type ModelsJson = Record<string, ModelInfo[]>;

let modelsCache: ModelsJson | null = null;
let modelsDirCache: string | null = null;
/** id → best ModelInfo across all sections (for provider-agnostic fallback). */
let byIdCache: Map<string, ModelInfo> | null = null;

function getModuleDir(): string {
  const anchors = [process.cwd()];
  const argv1 = process.argv[1];
  if (typeof argv1 === "string" && argv1) anchors.push(path.dirname(argv1));
  const rel = path.join("open-sse", "services", "thinking");
  for (const anchor of anchors) {
    let dir = path.resolve(anchor);
    for (let i = 0; i <= 8; i++) {
      if (fs.existsSync(path.join(dir, rel))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return path.join(os.homedir(), ".omniroute");
}

function getModelsFile(): string {
  if (modelsDirCache) return modelsDirCache;
  const root = getModuleDir();
  const candidates = [
    path.join(root, "open-sse", "services", "thinking", "models.json"),
    path.join(root, "app", "open-sse", "services", "thinking", "models.json"),
  ];
  modelsDirCache =
    candidates.find((candidate, index) => {
      return candidates.indexOf(candidate) === index && fs.existsSync(candidate);
    }) ?? candidates[0];
  return modelsDirCache;
}

/**
 * Load and cache models.json. Non-strict like the Go loader: a malformed/missing
 * file yields an empty catalog (thinking becomes passthrough) rather than throwing.
 */
function loadModels(): ModelsJson {
  if (modelsCache) return modelsCache;
  const file = getModelsFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    modelsCache = isModelsJson(parsed) ? parsed : {};
  } catch {
    modelsCache = {};
  }
  return modelsCache;
}

function isModelsJson(value: unknown): value is ModelsJson {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (section) => Array.isArray(section)
  );
}

function getByIdIndex(): Map<string, ModelInfo> {
  if (byIdCache) return byIdCache;
  const index = new Map<string, ModelInfo>();
  const models = loadModels();
  for (const section of Object.values(models)) {
    for (const entry of section) {
      if (!entry || typeof entry.id !== "string") continue;
      // First occurrence wins; prefer one that actually declares thinking.
      const existing = index.get(entry.id);
      if (!existing || (!existing.thinking && entry.thinking)) {
        index.set(entry.id, entry);
      }
    }
  }
  byIdCache = index;
  return index;
}

/**
 * Look up a model's thinking capability by exact id. When `provider` is given and
 * that section exists, it is searched first (provider-specific capability); then a
 * provider-agnostic exact-id match is used as fallback. Returns null for unknown
 * models — callers treat null as "user-defined" (skip validation).
 */
export function lookupModelInfo(
  modelId: string | null | undefined,
  provider?: string | null
): ModelInfo | null {
  if (!modelId || typeof modelId !== "string") return null;
  const id = modelId.trim();
  if (!id) return null;

  const models = loadModels();

  if (provider) {
    const section = models[provider.trim().toLowerCase()];
    if (Array.isArray(section)) {
      const hit = section.find((m) => m && m.id === id);
      if (hit) return hit;
    }
  }

  return getByIdIndex().get(id) ?? null;
}

/** Test-only: clear caches so a fresh models.json is re-read. */
export function resetRegistryCacheForTests(): void {
  modelsCache = null;
  modelsDirCache = null;
  byIdCache = null;
}
