import test from "node:test";
import assert from "node:assert/strict";

// The Anthropic API-key probe treated every non-401/403 answer as a valid key, so a key that
// fails EVERY request (no credit, or not scoped to a workspace) still passed the connection
// test. It also never sent the connection's custom headers, which the chat path does send.

const { validateProviderApiKey } = await import("../../src/lib/providers/validation.ts");

const originalFetch = globalThis.fetch;
const PROBE_URL = "https://api.anthropic.com/v1/models";
const KEY = "sk-ant-api-key-fixture";

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

function toPlainHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  return Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => [key, String(value)])
  );
}

function anthropicError(message: string) {
  return JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } });
}

function mockProbe(status: number, body: string) {
  const seen: Record<string, string>[] = [];
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target === PROBE_URL) {
      assert.equal(init?.method || "GET", "GET");
      assert.equal(init?.body, undefined);
      seen.push(toPlainHeaders(init?.headers));
      return new Response(body, { status });
    }
    assert.fail(`Unexpected validation request: ${target}`);
  };
  return seen;
}

test("a key with no credit balance fails the test", async () => {
  mockProbe(
    400,
    anthropicError(
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."
    )
  );
  const result = await validateProviderApiKey({ provider: "anthropic", apiKey: KEY });
  assert.equal(result.valid, false);
  assert.match(String(result.error), /credit balance/i);
});

test("a key not scoped to a workspace fails the test and names the header", async () => {
  mockProbe(
    400,
    anthropicError(
      "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace."
    )
  );
  const result = await validateProviderApiKey({ provider: "anthropic", apiKey: KEY });
  assert.equal(result.valid, false);
  assert.match(String(result.error), /anthropic-workspace-id/);
});

test("an unrecognized native catalog 400 fails validation", async () => {
  mockProbe(400, anthropicError("max_tokens: must be greater than 1"));
  const result = await validateProviderApiKey({ provider: "anthropic", apiKey: KEY });
  assert.equal(result.valid, false);
  assert.match(String(result.error), /rejected validation request \(400\)/);
});

test("the probe sends the connection's custom headers but they cannot replace auth", async () => {
  const seen = mockProbe(200, JSON.stringify({ data: [], has_more: false }));
  const result = await validateProviderApiKey({
    provider: "anthropic",
    apiKey: KEY,
    providerSpecificData: {
      customHeaders: {
        "anthropic-workspace-id": "wrkspc_fixture",
        "X-Api-Key": "attacker-key",
        Authorization: "Bearer attacker",
        "x-bad": "a\r\nb",
      },
    },
  });
  assert.equal(result.valid, true);
  assert.equal(seen.length, 1);
  const headers = seen[0];
  assert.equal(headers["anthropic-workspace-id"], "wrkspc_fixture");
  assert.equal(headers["x-api-key"], KEY);
  assert.ok(!("X-Api-Key" in headers));
  assert.ok(!Object.keys(headers).some((k) => k.toLowerCase() === "authorization"));
  assert.ok(!("x-bad" in headers));
});

test("without custom headers the probe headers are unchanged", async () => {
  const seen = mockProbe(200, JSON.stringify({ data: [], has_more: false }));
  await validateProviderApiKey({ provider: "anthropic", apiKey: KEY });
  assert.ok(!Object.keys(seen[0]).some((k) => k.toLowerCase() === "anthropic-workspace-id"));
  assert.equal(seen[0]["x-api-key"], KEY);
});

test("a native catalog 400 body that never ends fails without hanging", async () => {
  globalThis.fetch = async (url: string | URL | Request) => {
    if (String(url) !== PROBE_URL) return new Response("{}", { status: 404 });
    const stalled = new ReadableStream<Uint8Array>({ start() {} });
    return new Response(stalled, { status: 400 });
  };
  const started = Date.now();
  const result = await validateProviderApiKey({ provider: "anthropic", apiKey: KEY });
  assert.equal(result.valid, false);
  assert.match(String(result.error), /rejected validation request \(400\)/);
  assert.ok(Date.now() - started < 10_000);
});

test("only the first 8 KB of a huge native catalog 400 body are inspected", async () => {
  globalThis.fetch = async (url: string | URL | Request) => {
    if (String(url) !== PROBE_URL) return new Response("{}", { status: 404 });
    const filler = new TextEncoder().encode("x".repeat(16 * 1024));
    const tail = new TextEncoder().encode(anthropicError("Your credit balance is too low"));
    // never closes: if the reader ignored the cap it would wait for the timeout
    const huge = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(filler);
        controller.enqueue(tail);
      },
    });
    return new Response(huge, { status: 400 });
  };
  const started = Date.now();
  const result = await validateProviderApiKey({ provider: "anthropic", apiKey: KEY });
  assert.equal(result.valid, false);
  assert.match(String(result.error), /rejected validation request \(400\)/);
  assert.ok(Date.now() - started < 2_000);
});

test("the native catalog error prefix is capped in bytes, not decoded characters", async () => {
  const body = "é".repeat(4096) + anthropicError("Your credit balance is too low");
  mockProbe(400, body);
  const result = await validateProviderApiKey({ provider: "anthropic", apiKey: KEY });
  assert.equal(result.valid, false);
  assert.match(String(result.error), /rejected validation request \(400\)/);
});

test("an unrecognized compatible message 400 still counts as auth passed", async () => {
  const requests: string[] = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push(String(url));
    if (String(url) === "https://anthropic-proxy.example/v1/models") {
      return new Response("{}", { status: 404 });
    }
    assert.equal(String(url), "https://anthropic-proxy.example/v1/messages?beta=true");
    assert.equal(init.method, "POST");
    return new Response(anthropicError("max_tokens: must be greater than 1"), { status: 400 });
  };
  const result = await validateProviderApiKey({
    provider: "anthropic",
    apiKey: KEY,
    providerSpecificData: { baseUrl: "https://anthropic-proxy.example/v1/messages" },
  });
  assert.equal(result.valid, true);
  assert.equal(requests.length, 2);
});

test("an anthropic-compatible node pointed at Anthropic gets the same key errors", async () => {
  globalThis.fetch = async (url: string | URL | Request) => {
    const target = String(url);
    if (target.endsWith("/models")) {
      return new Response(anthropicError("not scoped to a workspace"), { status: 400 });
    }
    return new Response(
      anthropicError(
        "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header"
      ),
      { status: 400 }
    );
  };
  const result = await validateProviderApiKey({
    provider: "anthropic-compatible-fixture",
    apiKey: KEY,
    providerSpecificData: { baseUrl: "https://api.anthropic.com/v1" },
  });
  assert.equal(result.valid, false);
  assert.match(String(result.error), /anthropic-workspace-id/);
});
