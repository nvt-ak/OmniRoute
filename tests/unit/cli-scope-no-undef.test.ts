import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Linter } from "eslint";
import { globSync } from "glob";
import { reportReadinessTimeout } from "../../bin/cli/commands/serve.mjs";

// #13369 shipped `omniroute serve` crashing at startup with
// "✖ opts is not defined": runWithSupervisor() read `opts.readyTimeout`, but
// `opts` is scoped to runServe(). It reached a release because eslint.config.mjs
// ignores "bin/**" entirely, so no-undef never ran over the CLI, and the only
// serve.mjs tests match source text with regexes (which a ReferenceError passes).
//
// This scans every shipped CLI module for out-of-scope identifiers — the class
// of bug that turns into a runtime ReferenceError on the very first command.

const NODE_GLOBALS = [
  "console",
  "process",
  "fetch",
  "URL",
  "URLSearchParams",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "setImmediate",
  "queueMicrotask",
  "Buffer",
  "performance",
  "globalThis",
  "structuredClone",
  "AbortController",
  "AbortSignal",
  "TextEncoder",
  "TextDecoder",
  "Intl",
  "WebSocket",
  "crypto",
  "Response",
  "Request",
  "Headers",
  "FormData",
  "Blob",
  "File",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "atob",
  "btoa",
  "__dirname",
  "__filename",
  "require",
  "module",
  "exports",
];

test("no shipped CLI module references an out-of-scope identifier (#13369)", () => {
  const files = globSync("bin/**/*.mjs").filter((f) => !f.includes("node_modules"));
  assert.ok(files.length > 50, `expected the CLI tree to be scanned, found ${files.length} files`);

  const linter = new Linter({ configType: "flat" });
  const problems: string[] = [];

  for (const file of files) {
    const messages = linter.verify(
      readFileSync(file, "utf8"),
      {
        languageOptions: {
          ecmaVersion: "latest",
          sourceType: "module",
          globals: Object.fromEntries(NODE_GLOBALS.map((g) => [g, "readonly"])),
        },
        rules: { "no-undef": "error" },
      },
      file
    );
    for (const m of messages) problems.push(`${file}:${m.line}:${m.column} ${m.message}`);
  }

  assert.deepEqual(
    problems,
    [],
    `out-of-scope identifiers crash the CLI at runtime:\n${problems.join("\n")}`
  );
});

test("serve --ready-timeout reaches the readiness probe and its diagnostic", () => {
  const logs: string[] = [];
  const origErr = console.error.bind(console);
  console.error = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    // The caller passes the budget waitForServer actually used (4th arg), so the
    // message and the "raise it to 2x" tip describe the real timeout, not the
    // default. The 3rd arg is the probe outcome (null = unclassified here).
    reportReadinessTimeout(20128, null, null, 9000);
  } finally {
    console.error = origErr;
  }

  const combined = logs.join("\n").replace(/\u001b\[\d+m/g, "");
  assert.match(combined, /did not respond within 9s/);
  assert.match(combined, /--ready-timeout 18000/);
});
