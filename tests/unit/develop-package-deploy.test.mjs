import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import net from "node:net";

const workflow = process.env.DEPLOY_TEST_BASE_REF
  ? execFileSync(
      "git",
      ["show", `${process.env.DEPLOY_TEST_BASE_REF}:.github/workflows/develop-package-deploy.yml`],
      { encoding: "utf8" }
    )
  : readFileSync(
      new URL("../../.github/workflows/develop-package-deploy.yml", import.meta.url),
      "utf8"
    );
const remote = workflow
  .split("<<'REMOTE_SCRIPT'\n")[1]
  .split("          REMOTE_SCRIPT")[0]
  .replace(/^          /gm, "");

test("prerequisites exclude OmniRoute and report missing tools", () => {
  const check = workflow.split("- name: Upload package to server")[0];
  assert.doesNotMatch(check, /command -v omniroute/);
  assert.match(check, /for tool in node npm curl tar/);
  assert.match(check, /Missing prerequisites/);
  assert.match(check, /Node.js 24/);
});

test("remote script has valid bash syntax", () => {
  const result = spawnSync("bash", ["-n"], { input: remote, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

async function fixture(t, { fail = false, previous = false, occupied = false, pid } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "omniroute-deploy-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "tools");
  const prefix = path.join(dir, "prefix");
  const deploy = path.join(dir, ".omniroute/deploy");
  for (const folder of [bin, `${prefix}/bin`, `${deploy}/incoming`, `${deploy}/releases`])
    mkdirSync(folder, { recursive: true });
  const executable = (name, source) =>
    writeFileSync(`${bin}/${name}`, `#!/bin/bash\n${source}\n`, { mode: 0o755 });
  executable("node", `exec '${process.execPath}' "$@"`);
  executable(
    "npm",
    `case "$1" in
prefix) echo "$TEST_PREFIX";;
root) echo "$TEST_PREFIX/lib/node_modules";;
install) printf '%s\\n' "$3" >> "$TEST_ROOT/installs"; cp "$TEST_ROOT/cli" "$TEST_PREFIX/bin/omniroute"; chmod +x "$TEST_PREFIX/bin/omniroute"; printf '%s' "$3" > "$TEST_ROOT/current";;
*) exit 1;; esac`
  );
  executable("tar", "echo abc123");
  executable(
    "curl",
    `if [ "$TEST_FAIL" = 1 ] && ! grep -q last-known-good "$TEST_ROOT/current"; then exit 1; fi; echo '{"status":"healthy"}'`
  );
  executable("sleep", "exit 0");
  // Retention uses GNU find/sort on Ubuntu; this isolated fixture has no old releases.
  executable("find", "exit 0");
  executable("sort", "cat");
  executable("cut", "cat");
  writeFileSync(`${dir}/cli`, '#!/bin/bash\nprintf "%s\\n" "$*" >> "$TEST_ROOT/cli-calls"\n');
  writeFileSync(`${deploy}/incoming/omniroute-abc123.tgz`, "candidate");
  if (pid) {
    mkdirSync(`${dir}/.omniroute/server`, { recursive: true });
    writeFileSync(`${dir}/.omniroute/server/.pid`, String(pid));
  }
  if (previous) writeFileSync(`${deploy}/last-known-good.tgz`, "previous");
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "0.0.0.0", resolve));
  const port = listener.address().port;
  if (!occupied) await new Promise((resolve) => listener.close(resolve));
  else t.after(() => listener.close());
  const result = spawnSync("bash", ["-s", "--", "abc123", String(port), "5"], {
    // GNU retention is outside this fixture; emulate empty mapfile on macOS Bash 3.
    input: "mapfile() { release_files=(); }\n" + remote,
    encoding: "utf8",
    timeout: 15000,
    env: {
      ...process.env,
      HOME: dir,
      DATA_DIR: `${dir}/.omniroute`,
      PATH: `${bin}:/usr/bin:/bin`,
      TEST_PREFIX: prefix,
      TEST_ROOT: dir,
      TEST_FAIL: fail ? "1" : "0",
    },
  });
  return { result, dir, deploy };
}

test("clean server installs fork tarball and creates first last-known-good", async (t) => {
  const { result, dir, deploy } = await fixture(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(`${deploy}/last-known-good.tgz`, "utf8"), "candidate");
  assert.match(readFileSync(`${dir}/cli-calls`, "utf8"), /serve --daemon --port/);
});

test("first-install failure explicitly reports unavailable rollback", async (t) => {
  const { result, deploy } = await fixture(t, { fail: true });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /automatic rollback is unavailable/);
  assert.equal(existsSync(`${deploy}/last-known-good.tgz`), false);
});

test("failed update reinstalls previous tarball but keeps deployment failed", async (t) => {
  const { result, dir, deploy } = await fixture(t, { fail: true, previous: true });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Rollback succeeded/);
  assert.match(readFileSync(`${dir}/installs`, "utf8"), /last-known-good.tgz/);
  assert.equal(readFileSync(`${deploy}/last-known-good.tgz`, "utf8"), "previous");
});

test("foreign listener is preserved and installation is refused", async (t) => {
  const { result, dir } = await fixture(t, { occupied: true });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /EADDRINUSE/);
  assert.equal(existsSync(`${dir}/installs`), false);
});

test("stale PID does not block installation on a free port", async (t) => {
  const { result } = await fixture(t, { pid: 2147483647 });
  assert.equal(result.status, 0, result.stderr);
});

test("foreign live PID is never signalled or replaced", async (t) => {
  const { result, dir } = await fixture(t, { pid: process.pid });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(existsSync(`${dir}/installs`), false);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});

// ── Loopback-bind tests ────────────────────────────────────────────────────

test("remote script exports OMNIROUTE_SERVER_HOST defaulting to loopback", () => {
  assert.match(
    remote,
    /export OMNIROUTE_SERVER_HOST="\$\{OMNIROUTE_SERVER_HOST:-127\.0\.0\.1\}"/
  );
});

/**
 * Shared fixture builder for .env persistence tests.
 * Creates a minimal fixture with a pre-populated ~/.omniroute/.env and
 * runs the remote script, then returns the fixture dir and result.
 */
async function envFixture(t, { initialEnv = null, extraKeys = "" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "omniroute-env-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "tools");
  const prefix = path.join(dir, "prefix");
  const deploy = path.join(dir, ".omniroute/deploy");
  const omnirouteDir = path.join(dir, ".omniroute");
  for (const folder of [bin, `${prefix}/bin`, `${deploy}/incoming`, `${deploy}/releases`, omnirouteDir])
    mkdirSync(folder, { recursive: true });
  const executable = (name, source) =>
    writeFileSync(`${bin}/${name}`, `#!/bin/bash\n${source}\n`, { mode: 0o755 });
  executable("node", `exec '${process.execPath}' "$@"`);
  executable(
    "npm",
    `case "$1" in\nprefix) echo "$TEST_PREFIX";;\nroot) echo "$TEST_PREFIX/lib/node_modules";;\ninstall) printf '%s\\n' "$3" >> "$TEST_ROOT/installs"; cp "$TEST_ROOT/cli" "$TEST_PREFIX/bin/omniroute"; chmod +x "$TEST_PREFIX/bin/omniroute"; printf '%s' "$3" > "$TEST_ROOT/current";;\n*) exit 1;; esac`
  );
  executable("tar", "echo abc123");
  executable("curl", `echo '{"status":"healthy"}'`);
  executable("sleep", "exit 0");
  executable("find", "exit 0");
  executable("sort", "cat");
  executable("cut", "cat");
  writeFileSync(`${dir}/cli`, '#!/bin/bash\nprintf "%s\\n" "$*" >> "$TEST_ROOT/cli-calls"\nprintf "SERVER_HOST=%s\\n" "${OMNIROUTE_SERVER_HOST:-UNSET}" >> "$TEST_ROOT/cli-env"\n', { mode: 0o755 });
  writeFileSync(`${deploy}/incoming/omniroute-abc123.tgz`, "candidate");

  // Write initial .env content if provided
  const envPath = path.join(omnirouteDir, ".env");
  if (initialEnv !== null) {
    writeFileSync(envPath, initialEnv, { mode: 0o600 });
  }

  const net = (await import("node:net")).default;
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "0.0.0.0", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));

  const { spawnSync } = await import("node:child_process");
  const result = spawnSync("bash", ["-s", "--", "abc123", String(port), "5"], {
    input: "mapfile() { release_files=(); }\n" + remote,
    encoding: "utf8",
    timeout: 15000,
    env: {
      ...process.env,
      HOME: dir,
      DATA_DIR: omnirouteDir,
      PATH: `${bin}:/usr/bin:/bin`,
      TEST_PREFIX: prefix,
      TEST_ROOT: dir,
      TEST_FAIL: "0",
      // unset OMNIROUTE_SERVER_HOST so we test default behaviour
      OMNIROUTE_SERVER_HOST: "",
    },
  });
  return { result, dir, envPath };
}

test("env file absent: created with 127.0.0.1 and mode 600", async (t) => {
  const { result, envPath } = await envFixture(t, { initialEnv: null });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(envPath), ".env should be created");
  const content = readFileSync(envPath, "utf8");
  assert.match(content, /OMNIROUTE_SERVER_HOST=127\.0\.0\.1/);
  // Check mode 600 (octal 33152 = 0o100600)
  const { statSync } = await import("node:fs");
  const mode = statSync(envPath).mode & 0o777;
  assert.equal(mode, 0o600, `.env should be mode 600, got 0o${mode.toString(8)}`);
});

test("env file has OMNIROUTE_SERVER_HOST=0.0.0.0: replaced with 127.0.0.1, other keys untouched", async (t) => {
  const initial =
    "NODE_ENV=production\nSTORAGE_ENCRYPTION_KEY=secret123\nOMNIROUTE_SERVER_HOST=0.0.0.0\nJWT_SECRET=tok456\n";
  const { result, envPath } = await envFixture(t, { initialEnv: initial });
  assert.equal(result.status, 0, result.stderr);
  const content = readFileSync(envPath, "utf8");
  assert.match(content, /OMNIROUTE_SERVER_HOST=127\.0\.0\.1/);
  assert.doesNotMatch(content, /OMNIROUTE_SERVER_HOST=0\.0\.0\.0/);
  assert.match(content, /NODE_ENV=production/);
  assert.match(content, /STORAGE_ENCRYPTION_KEY=secret123/);
  assert.match(content, /JWT_SECRET=tok456/);
});

test("env file has other keys but no OMNIROUTE_SERVER_HOST: key appended", async (t) => {
  const initial = "NODE_ENV=production\nSTORAGE_ENCRYPTION_KEY=secret123\n";
  const { result, envPath } = await envFixture(t, { initialEnv: initial });
  assert.equal(result.status, 0, result.stderr);
  const content = readFileSync(envPath, "utf8");
  assert.match(content, /OMNIROUTE_SERVER_HOST=127\.0\.0\.1/);
  assert.match(content, /NODE_ENV=production/);
  assert.match(content, /STORAGE_ENCRYPTION_KEY=secret123/);
});

test("daemon is started with OMNIROUTE_SERVER_HOST=127.0.0.1 in its environment", async (t) => {
  const { result, dir } = await envFixture(t, { initialEnv: null });
  assert.equal(result.status, 0, result.stderr);
  const envCapture = readFileSync(path.join(dir, "cli-env"), "utf8");
  assert.match(envCapture, /SERVER_HOST=127\.0\.0\.1/, "daemon must start with loopback bind");
});
