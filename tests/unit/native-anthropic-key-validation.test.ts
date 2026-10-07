import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { validateProviderApiKey } from "../../src/lib/providers/validation.ts";
import { getDefaultExecutor } from "../../open-sse/executors/defaultResolver.ts";
import { SafeOutboundFetchError } from "../../src/shared/network/safeOutboundFetch.ts";

const originalFetch = globalThis.fetch;
const consoleKey = "sk-ant-api03-test-console-key";
const modelsUrl = "https://api.anthropic.com/v1/models";
const messagesUrl = "https://api.anthropic.com/v1/messages?beta=true";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function messageResponse() {
  return jsonResponse({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text: "OK" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 8, output_tokens: 1 },
  });
}

test("Console key validation authenticates the native catalog without a generation or model dependency", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || "GET" });
    const headers = new Headers(init.headers);
    if (headers.get("x-api-key") !== consoleKey) {
      return jsonResponse({ error: { type: "authentication_error" } }, 401);
    }
    if (headers.get("anthropic-version") !== "2023-06-01") {
      // In particular, reject the duplicated "2023-06-01, 2023-06-01"
      // generated when the registry and probe add different-case headers.
      return jsonResponse({ error: { type: "invalid_request_error" } }, 400);
    }
    assert.equal(headers.get("authorization"), null);
    assert.equal(String(url), modelsUrl);
    assert.equal(init.method || "GET", "GET");
    assert.equal(init.body, undefined);
    return jsonResponse({ data: [], has_more: false, first_id: null, last_id: null });
  };

  const result = await validateProviderApiKey({
    provider: "anthropic",
    apiKey: consoleKey,
    providerSpecificData: { validationModelId: "retired-model-not-in-catalog" },
  });

  assert.equal(result.valid, true);
  assert.equal(result.error, null);
  assert.deepEqual(requests, [{ url: modelsUrl, method: "GET" }]);
});

const catalogFailureStatuses = [400, 401, 403, 404, 422, 429, 500, 529];

for (const status of catalogFailureStatuses) {
  test(`native catalog HTTP ${status} is not reported as a valid key`, async () => {
    let calls = 0;
    globalThis.fetch = async (url, init = {}) => {
      calls++;
      assert.equal(String(url), modelsUrl);
      assert.equal(init.method || "GET", "GET");
      return jsonResponse({ error: { message: `upstream HTTP ${status}` } }, status);
    };

    const result = await validateProviderApiKey({ provider: "anthropic", apiKey: consoleKey });

    assert.equal(result.valid, false);
    assert.ok(result.error, "Failed validation must provide an error for Check/Save");
    assert.notEqual(result.unsupported, true, "Check/Save must not bypass this failure");
    assert.ok(calls > 0);
  });
}

test("native catalog transport failure is not mislabeled as invalid credentials or ignored for generation", async () => {
  globalThis.fetch = async (url) => {
    assert.equal(String(url), modelsUrl);
    throw new SafeOutboundFetchError("TLS connection failed", {
      code: "NETWORK_ERROR",
      url: modelsUrl,
      method: "GET",
      attempts: 1,
      isRetryable: false,
    });
  };

  const result = await validateProviderApiKey({ provider: "anthropic", apiKey: consoleKey });

  assert.equal(result.valid, false);
  assert.match(result.error || "", /TLS connection failed/i);
  assert.notEqual(result.unsupported, true);
});

test("native catalog timeout remains a transport error that blocks saving", async () => {
  globalThis.fetch = async () => {
    throw new SafeOutboundFetchError("Provider request timed out", {
      code: "TIMEOUT",
      url: modelsUrl,
      method: "GET",
      attempts: 1,
      isRetryable: false,
    });
  };

  const result = await validateProviderApiKey({ provider: "anthropic", apiKey: consoleKey });

  assert.equal(result.valid, false);
  assert.equal(result.timeout, true);
  assert.match(result.error || "", /timed out/i);
});

test("native base URL overrides never send a custom key to the official catalog", async () => {
  const requests: string[] = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    requests.push(target);
    assert.ok(target.startsWith("https://anthropic-proxy.example/v1/"));
    assert.equal(new Headers(init.headers).get("x-api-key"), consoleKey);
    if (target.endsWith("/models")) return jsonResponse({ error: "not found" }, 404);
    assert.equal(init.method, "POST");
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "account-custom-model");
    return messageResponse();
  };

  const result = await validateProviderApiKey({
    provider: "anthropic",
    apiKey: consoleKey,
    providerSpecificData: {
      baseUrl: "https://anthropic-proxy.example/v1/messages",
      validationModelId: "account-custom-model",
    },
  });

  assert.equal(result.valid, true);
  assert.deepEqual(requests, [
    "https://anthropic-proxy.example/v1/models",
    "https://anthropic-proxy.example/v1/messages?beta=true",
  ]);
});

for (const { status, error } of [
  { status: 404, error: /validation model or endpoint not found.*404/i },
  { status: 429, error: /rate limited.*429/i },
  { status: 503, error: /provider unavailable.*503/i },
]) {
  test(`Anthropic message fallback HTTP ${status} does not turn a failed probe into a valid key`, async () => {
    globalThis.fetch = async (url, init = {}) => {
      assert.ok(String(url).startsWith("https://anthropic-proxy.example/"));
      if ((init.method || "GET") === "GET") return jsonResponse({}, 404);
      return jsonResponse({ error: "probe failed" }, status);
    };

    const result = await validateProviderApiKey({
      provider: "anthropic",
      apiKey: consoleKey,
      providerSpecificData: { baseUrl: "https://anthropic-proxy.example/v1/messages" },
    });

    assert.equal(result.valid, false);
    assert.match(result.error || "", error);
  });
}

test("an OAuth token still uses Claude OAuth auth and messages, not the Console catalog", async () => {
  const token = "sk-ant-oat-test-oauth-token";
  const requests: string[] = [];
  let rejectedOAuthRequests = 0;
  globalThis.fetch = async (url, init = {}) => {
    requests.push(String(url));
    const headers = new Headers(init.headers);
    if (headers.get("authorization") !== `Bearer ${token}` || headers.has("x-api-key")) {
      rejectedOAuthRequests++;
      return jsonResponse({ error: { type: "authentication_error" } }, 401);
    }
    if (String(url) === "https://api.anthropic.com/api/claude_cli/bootstrap") {
      return jsonResponse({
        oauth_account: {
          account_uuid: "00000000-0000-4000-8000-000000000001",
          account_email: "oauth@example.test",
          organization_uuid: "00000000-0000-4000-8000-000000000002",
          organization_name: "Test OAuth Organization",
          organization_type: "individual",
          organization_rate_limit_tier: "default_claude_max_5x",
        },
      });
    }
    assert.equal(String(url), messagesUrl);
    assert.equal(init.method, "POST");
    const betas = (headers.get("anthropic-beta") || "").split(",");
    // Lightweight OAuth probes have no tools: selectBetaFlags keeps OAuth +
    // CLI metadata, but only full-agent (system + tools) requests get code beta.
    if (!betas.includes("oauth-2025-04-20") || headers.get("x-app") !== "cli") {
      return jsonResponse({ error: { message: "OAuth CLI identity required" } }, 403);
    }
    return messageResponse();
  };

  const result = await validateProviderApiKey({
    provider: "anthropic",
    apiKey: token,
    providerSpecificData: { validationModelId: "claude-haiku-4-5-20251001" },
  });

  assert.equal(result.valid, true);
  assert.equal(rejectedOAuthRequests, 0);
  assert.ok(requests.includes(messagesUrl));
  assert.ok(!requests.includes(modelsUrl), "OAuth must not use the Console catalog");
});

test("the native Console executor can use monthly API credits without interactive Claude Code classification", async () => {
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(String(url), messagesUrl);
    assert.equal(init.method, "POST");
    const headers = new Headers(init.headers);
    if (
      headers.get("x-api-key") !== consoleKey ||
      headers.has("authorization") ||
      headers.get("anthropic-version") !== "2023-06-01"
    ) {
      return jsonResponse({ error: { type: "authentication_error" } }, 401);
    }
    const betas = (headers.get("anthropic-beta") || "").split(",");
    if (betas.includes("claude-code-20250219") || betas.includes("oauth-2025-04-20")) {
      return jsonResponse(
        { error: { type: "invalid_request_error", message: "Your credit balance is too low" } },
        400
      );
    }
    return messageResponse();
  };

  const executed = await getDefaultExecutor("anthropic").execute({
    model: "claude-haiku-4-5-20251001",
    body: {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1,
      messages: [{ role: "user", content: "Reply OK" }],
    },
    stream: false,
    credentials: { apiKey: consoleKey },
    clientHeaders: {
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
    },
  });

  assert.equal(executed.response.status, 200);
  assert.equal((await executed.response.json()).content[0].text, "OK");
});

test("a Claude Code compatible gateway retains its intentional full-agent CLI beta classification", async () => {
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(String(url), "https://cc-gateway.example/v1/messages?beta=true");
    const headers = new Headers(init.headers);
    const betas = (headers.get("anthropic-beta") || "").split(",");
    if (
      !betas.includes("claude-code-20250219") ||
      headers.get("x-app") !== "cli" ||
      headers.get("authorization") !== `Bearer ${consoleKey}`
    ) {
      return jsonResponse({ error: { message: "unauthorized client detected" } }, 403);
    }
    return messageResponse();
  };

  const executed = await getDefaultExecutor("anthropic-compatible-cc-credit-test").execute({
    model: "claude-haiku-4-5-20251001",
    body: {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1,
      messages: [{ role: "user", content: "Reply OK" }],
      system: "Use the weather tool when needed.",
      tools: [
        {
          name: "get_weather",
          description: "Get the weather for a city.",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
    },
    stream: false,
    credentials: {
      apiKey: consoleKey,
      providerSpecificData: { baseUrl: "https://cc-gateway.example" },
    },
  });

  assert.equal(executed.response.status, 200);
  assert.equal((await executed.response.json()).content[0].text, "OK");
});
