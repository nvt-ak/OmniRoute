import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createSourceFile,
  createPrinter,
  factory,
  isFunctionDeclaration,
  isImportDeclaration,
  isStringLiteral,
  isVariableStatement,
  ModuleKind,
  ScriptTarget,
  transpileModule,
} from "typescript";

interface WebpackStats {
  hasErrors(): boolean;
  toJson(options: Record<string, boolean>): {
    errors?: unknown[];
    warnings?: unknown[];
  };
}

interface WebpackCompiler {
  run(callback: (error?: Error | null, stats?: WebpackStats) => void): void;
  close(callback: (error?: Error | null) => void): void;
}

type WebpackFactory = (config: Record<string, unknown>) => WebpackCompiler;

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack") as {
  webpack: WebpackFactory;
};

function renderIssue(issue: unknown): string {
  if (typeof issue === "string") return issue;
  if (issue && typeof issue === "object" && "message" in issue) {
    return String((issue as { message: unknown }).message);
  }
  return JSON.stringify(issue);
}
function codexLoaderFixture(): string {
  const source = createSourceFile(
    "codex.ts",
    fs.readFileSync(path.resolve("open-sse/executors/codex.ts"), "utf8"),
    ScriptTarget.ES2022,
    true
  );
  // Compile the production loader and transport getter without the unrelated
  // executor graph. Select AST declarations, not a reimplementation or source
  // spelling assertion: changes to the loader run in the emitted fixture.
  const declarations: Record<string, true> = {
    _wreqRequire: true,
    _websocketFn: true,
    _wreqChecked: true,
    _websocketOverride: true,
    getCodexWebSocketTransport: true,
    getCodexAppServerWebsocketTransport: true,
  };
  const statements = source.statements.filter((statement) => {
    if (isImportDeclaration(statement) && isStringLiteral(statement.moduleSpecifier)) {
      return ["module", "node:module", "./codex/wreqLoader.ts"].includes(
        statement.moduleSpecifier.text
      );
    }
    if (isFunctionDeclaration(statement)) {
      return !!statement.name && declarations[statement.name.text] === true;
    }
    return (
      isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) => declarations[declaration.name.getText(source)] === true
      )
    );
  });
  const printer = createPrinter();
  return `${printer.printFile(factory.updateSourceFile(source, statements))}
export function loadRuntimeDependency(specifier: string): unknown {
  return loadDynamicModule(_wreqRequire, specifier);
}
`;
}

async function compileRuntimeRequireModules(): Promise<string[]> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-webpack-create-require-"));
  const sourcePaths = [
    "src/lib/db/adapters/runtimeRequire.ts",
    "src/lib/machineToken.ts",
    "open-sse/services/browserPool.ts",
    "open-sse/utils/tlsClient.ts",
    // Owns the wreq-js createRequire loader that tlsClient.ts imports.
    "open-sse/utils/browserProfiles.ts",
    "open-sse/executors/codex.ts",
  ] as const;
  const entries: Record<string, string> = {};

  try {
    for (const sourcePath of sourcePaths) {
      const source =
        sourcePath === "open-sse/executors/codex.ts"
          ? codexLoaderFixture()
          : fs.readFileSync(path.resolve(sourcePath), "utf8");
      const output = transpileModule(source, {
        compilerOptions: {
          module: ModuleKind.ESNext,
          target: ScriptTarget.ES2022,
        },
        fileName: sourcePath,
      }).outputText;
      const entryName = path.basename(sourcePath, ".ts");
      // Next's server compilation feeds SWC output through javascript/auto.
      // A .mjs fixture would take Webpack's javascript/esm parser path and miss
      // the createRequire warning emitted by the production build.
      const entryPath = path.join(tempDir, `${entryName}.js`);
      fs.writeFileSync(entryPath, output, "utf8");
      entries[entryName] = entryPath;
    }

    const loaderDir = path.join(tempDir, "codex");
    fs.mkdirSync(loaderDir);
    fs.writeFileSync(
      path.join(loaderDir, "wreqLoader.ts"),
      transpileModule(
        fs.readFileSync(path.resolve("open-sse/executors/codex/wreqLoader.ts"), "utf8"),
        { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }
      ).outputText
    );

    const compiler = webpack({
      devtool: false,
      entry: entries,
      externals: [
        "../../src/lib/db/proxies",
        "@/shared/utils/runtimeTimeouts",
        "better-sqlite3",
        "bun:sqlite",
        "sql.js",
        "sqlite-vec",
        "playwright",
        "wreq-js",
        // browserPool.ts imports `./obscura.ts`. The isolated webpack compile
        // has no repo tree, so treat the sibling as external instead of
        // erroring "Can't resolve './obscura.ts'".
        "./obscura.ts",
        "./virtualDisplay.ts",
        "./tlsFirstByteWatchdog.ts",
        // machineToken.ts imports `./dataPaths` since #13909 (random per-install
        // CLI token salt reads the data dir). Same isolated-compile reason.
        "./dataPaths",
        // tlsClient.ts imports the loader as `./browserProfiles.ts`; the file is
        // compiled as its own entry above, so keep the import external here.
        "./browserProfiles.ts",
      ],
      externalsPresets: { node: true },
      mode: "development",
      module: {
        parser: {
          javascript: {
            createRequire: true,
          },
        },
        rules: [
          {
            test: /\.(js|ts)$/,
            type: "javascript/auto",
          },
        ],
      },
      output: {
        filename: "[name].js",
        path: path.join(tempDir, "dist"),
        library: { type: "commonjs2" },
      },
      target: "node",
    });

    const stats = await new Promise<WebpackStats>((resolve, reject) => {
      compiler.run((error, result) => {
        if (error) {
          reject(error);
          return;
        }
        if (!result) {
          reject(new Error("Webpack completed without stats"));
          return;
        }
        resolve(result);
      });
    });

    await new Promise<void>((resolve, reject) => {
      compiler.close((error) => (error ? reject(error) : resolve()));
    });

    const report = stats.toJson({ all: false, errors: true, warnings: true });
    assert.equal(stats.hasErrors(), false, (report.errors ?? []).map(renderIssue).join("\n"));

    // Deploy just the bundle away from the compilation tree. The optional
    // dependency exists only in runtime/node_modules, with no hashed aliases.
    const runtimeDir = path.join(tempDir, "runtime");
    const runtimeChunks = path.join(runtimeDir, "chunks");
    fs.mkdirSync(runtimeChunks, { recursive: true });
    fs.copyFileSync(path.join(tempDir, "dist", "codex.js"), path.join(runtimeChunks, "codex.cjs"));
    const runnerPath = path.join(runtimeDir, "server.cjs");
    fs.writeFileSync(
      runnerPath,
      `
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const loader = require("./chunks/codex.cjs");
const specifier = process.argv[2];
assert.equal(loader.loadRuntimeDependency("node:path").join("one", "two"), path.join("one", "two"));
assert.throws(() => loader.loadRuntimeDependency(specifier), { code: "MODULE_NOT_FOUND" });
if (process.argv[3] === "installed") {
  // Installing only after importing the bundle also proves the load is lazy.
  const packageDir = path.join(__dirname, "node_modules", specifier);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "index.js"),
    "exports.websocket = async (url) => ({ url, transport: 'runtime-package' });");
  const transport = loader.getCodexAppServerWebsocketTransport();
  assert.equal(typeof transport, "function");
  transport("wss://runtime.invalid").then((socket) => {
    assert.deepEqual(socket, { url: "wss://runtime.invalid", transport: "runtime-package" });
    assert.equal(loader.getCodexAppServerWebsocketTransport(), transport);
    assert.deepEqual(fs.readdirSync(path.join(__dirname, "node_modules")), [specifier]);
  }).catch((error) => { console.error(error); process.exitCode = 1; });
} else {
  assert.equal(loader.getCodexAppServerWebsocketTransport(), null);
}
`
    );
    for (const scenario of ["installed", "missing"]) {
      fs.rmSync(path.join(runtimeDir, "node_modules"), { recursive: true, force: true });
      const result = spawnSync(process.execPath, [runnerPath, "wreq-js", scenario], {
        // Deliberately not the entrypoint directory: resolution must anchor to argv[1].
        cwd: tempDir,
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, `${scenario}: ${result.stdout}\n${result.stderr}`);
      if (scenario === "installed") assert.equal(result.stderr, "");
      else assert.match(result.stderr, /wreq-js import failed, websocket disabled/);
    }
    return (report.warnings ?? []).map(renderIssue);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test("Webpack does not warn while parsing optional runtime modules", async () => {
  const warnings = await compileRuntimeRequireModules();
  const runtimeModuleWarnings = warnings.filter(
    (warning) =>
      warning.includes("module.createRequire failed parsing argument") ||
      warning.includes("Critical dependency: the request of a dependency is an expression") ||
      warning.includes(
        "Critical dependency: require function is used in a way in which dependencies cannot be statically extracted"
      )
  );

  assert.deepEqual(runtimeModuleWarnings, []);
});
