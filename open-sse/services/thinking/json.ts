/**
 * Minimal dotted-path JSON helpers — TypeScript stand-in for CLIProxyAPI's
 * gjson/sjson usage. Paths use dot notation ("a.b.c"). All mutators operate on
 * plain objects and never touch arrays by index (not needed for thinking config).
 */

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Read a value at a dotted path, or undefined if any segment is missing. */
export function getPath(body: unknown, dottedPath: string): unknown {
  if (!isObj(body)) return undefined;
  const parts = dottedPath.split(".");
  let cur: unknown = body;
  for (const part of parts) {
    if (!isObj(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** True if a value exists (not undefined) at the dotted path. */
export function hasPath(body: unknown, dottedPath: string): boolean {
  return getPath(body, dottedPath) !== undefined;
}

/** Read a string at a dotted path (only when the value is actually a string). */
export function getString(body: unknown, dottedPath: string): string | undefined {
  const v = getPath(body, dottedPath);
  return typeof v === "string" ? v : undefined;
}

/** Read an integer at a dotted path (number or numeric string). */
export function getInt(body: unknown, dottedPath: string): number | undefined {
  const v = getPath(body, dottedPath);
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^[+-]?\d+$/.test(v)) return Number.parseInt(v, 10);
  return undefined;
}

/**
 * Set a value at a dotted path, creating intermediate objects. Mutates `body`
 * in place (callers clone first). Returns `body` for chaining.
 */
export function setPath(body: Obj, dottedPath: string, value: unknown): Obj {
  const parts = dottedPath.split(".");
  let cur: Obj = body;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = cur[key];
    if (!isObj(next)) {
      cur[key] = {};
    }
    cur = cur[key] as Obj;
  }
  cur[parts[parts.length - 1]] = value;
  return body;
}

/** Delete a value at a dotted path. No-op if any segment is missing. */
export function deletePath(body: Obj, dottedPath: string): Obj {
  const parts = dottedPath.split(".");
  let cur: unknown = body;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isObj(cur)) return body;
    cur = cur[parts[i]];
  }
  if (isObj(cur)) delete cur[parts[parts.length - 1]];
  return body;
}

/** Delete `path` when the object at that path is empty ({}). */
export function pruneEmptyObject(body: Obj, dottedPath: string): Obj {
  const v = getPath(body, dottedPath);
  if (isObj(v) && Object.keys(v).length === 0) {
    deletePath(body, dottedPath);
  }
  return body;
}

/** Shallow structuredClone wrapper — returns {} for non-object input. */
export function cloneBody(body: unknown): Obj {
  if (!isObj(body)) return {};
  return structuredClone(body);
}
