import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { default: loadJsConfig } = require("next/dist/build/load-jsconfig");

test("Next resolves TypeScript aliases without spawning the compiler CLI", async () => {
  const { default: config } = await import("../../next.config.mjs");
  const originalSpawn = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = function () {
    throw Object.assign(new Error("spawn EBADF"), { code: "EBADF", syscall: "spawn" });
  };
  try {
    const result = await loadJsConfig(process.cwd(), config);
    assert.equal(result.useTypeScript, true);
    assert.equal(result.resolvedBaseUrl.baseUrl, process.cwd());
    assert.deepEqual(result.jsConfig.compilerOptions.paths, {
      "@/*": ["./src/*"],
      "@omniroute/open-sse": ["./open-sse"],
      "@omniroute/open-sse/*": ["./open-sse/*"],
      "@omniroute/browser-pool": ["./packages/browser-pool/src"],
    });
  } finally {
    ChildProcess.prototype.spawn = originalSpawn;
  }
});

test("Next dev static-path worker runs when child-process spawning is unavailable", async () => {
  const originalEnv = process.env.NODE_ENV;
  const originalSpawn = ChildProcess.prototype.spawn;
  process.env.NODE_ENV = "development";
  let worker;
  try {
    const { default: config } = await import("../../next.config.mjs?worker-regression");
    const { default: DevServer } = require("next/dist/server/dev/next-dev-server");
    ChildProcess.prototype.spawn = function (options) {
      if (options.args.some((arg: string) => arg.includes("processChild.js"))) {
        throw Object.assign(new Error("spawn EBADF"), { code: "EBADF", syscall: "spawn" });
      }
      return Reflect.apply(originalSpawn, this, [options]);
    };
    worker = DevServer.prototype.getStaticPathsWorker.call({ nextConfig: config });
    // Execute the actual threaded static-path entry. Its missing fixture
    // must reach the manifest read, not fail creating a child process.
    await assert.rejects(
      worker.loadStaticPaths({
        dir: process.cwd(),
        distDir: "/missing-next-worker-test-artifacts",
        pathname: "/missing-worker-regression-page",
        page: "/missing-worker-regression-page",
        isAppPath: true,
        runtimeConfig: {},
        httpAgentOptions: { keepAlive: true },
      }),
      (error: Error) =>
        /ENOENT.*missing-next-worker-test-artifacts.*build-manifest\.json/.test(error.message)
    );
  } finally {
    if (worker) await worker.end();
    ChildProcess.prototype.spawn = originalSpawn;
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
  }
});
