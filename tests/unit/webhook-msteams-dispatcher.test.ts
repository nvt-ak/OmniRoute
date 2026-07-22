import test from "node:test";
import assert from "node:assert/strict";

import { WEBHOOK_EVENT_VALUES } from "../../src/lib/webhooks/eventDescriptions.ts";

const { buildMsTeamsPayload } = await import("../../src/lib/webhooks/integrations/msteams.ts");

const ADAPTIVE_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive";

test("buildMsTeamsPayload — wraps an Adaptive Card in the message/attachments envelope", () => {
  const payload = buildMsTeamsPayload("test.ping", { message: "hi" });
  assert.equal(payload.type, "message", "top-level type must be 'message'");
  assert.ok(Array.isArray(payload.attachments) && payload.attachments.length === 1);
  const att = payload.attachments[0];
  assert.equal(
    att.contentType,
    ADAPTIVE_CONTENT_TYPE,
    "contentType must be the adaptive card type"
  );
  assert.equal(att.contentUrl, null);
  assert.equal(att.content.type, "AdaptiveCard");
  assert.equal(att.content.version, "1.5", "must target Adaptive Card schema 1.5");
  assert.ok(Array.isArray(att.content.body) && att.content.body.length > 0);
});

test("buildMsTeamsPayload — request.failed renders a FactSet with model + error", () => {
  const payload = buildMsTeamsPayload("request.failed", {
    model: "claude-opus-4-7",
    error: "503 Service Unavailable",
  });
  const combined = JSON.stringify(payload);
  assert.ok(combined.includes("claude-opus-4-7"), "should include model name");
  assert.ok(combined.includes("503 Service Unavailable"), "should include error text");

  const factSet = payload.attachments[0].content.body.find((el) => el.type === "FactSet");
  assert.ok(factSet, "a FactSet element must be present when structured fields exist");
  const facts = (factSet as unknown as { facts: { title: string; value: string }[] }).facts;
  assert.ok(
    facts.some((f) => f.title === "Model" && f.value === "claude-opus-4-7"),
    "FactSet must contain the Model fact"
  );
  assert.ok(
    facts.some((f) => f.title === "Error"),
    "FactSet must contain the Error fact"
  );
});

test("buildMsTeamsPayload — every event yields a valid card with a bold title", () => {
  const events = WEBHOOK_EVENT_VALUES;

  for (const event of events) {
    const payload = buildMsTeamsPayload(event, {});
    const body = payload.attachments[0].content.body;
    assert.ok(body.length >= 1, `event ${event} must have a non-empty body`);

    // First element is a Container whose first item is the bold title TextBlock.
    const container = body[0] as { type: string; items?: { type: string; weight?: string }[] };
    assert.equal(container.type, "Container", `event ${event} first element must be a Container`);
    const title = container.items?.[0];
    assert.ok(
      title && title.type === "TextBlock" && title.weight === "Bolder",
      `event ${event} must have a bold title`
    );
  }
});

test("buildMsTeamsPayload — sets msteams.width Full and truncates oversized values", () => {
  const longError = "x".repeat(5000);
  const payload = buildMsTeamsPayload("request.failed", { provider: "openai", error: longError });
  assert.equal(payload.attachments[0].content.msteams?.width, "Full");

  const serialized = JSON.stringify(payload);
  // The whole event payload must stay well under Teams' 28KB limit.
  assert.ok(
    serialized.length < 2000,
    `payload should be truncated small, got ${serialized.length}`
  );
  assert.ok(serialized.includes("…"), "oversized value should be truncated with an ellipsis");
});

test("buildMsTeamsPayload — falls back to the event description when no structured fields", () => {
  const payload = buildMsTeamsPayload("combo.switched", {});
  const body = payload.attachments[0].content.body;
  const hasFactSet = body.some((el) => el.type === "FactSet");
  assert.equal(hasFactSet, false, "no FactSet expected when there are no structured fields");
  // A descriptive TextBlock (besides the title container + footer) must be present.
  const textBlocks = body.filter((el) => el.type === "TextBlock");
  assert.ok(textBlocks.length >= 1, "should include a descriptive TextBlock");
});

test("buildMsTeamsPayload — usage.report renders per-account quota, not the generic description", () => {
  const data = {
    intervalMinutes: 70,
    accountCount: 2,
    accounts: [
      {
        provider: "codex",
        account: "me@example.com",
        worstRemainingPct: 18,
        windows: [
          { name: "weekly", displayName: "Weekly", remainingPct: 18, unlimited: false },
          { name: "session", displayName: "Session", remainingPct: 74, unlimited: false },
        ],
      },
      {
        provider: "claude",
        account: "team@example.com",
        worstRemainingPct: 88,
        windows: [{ name: "session", displayName: "Session", remainingPct: 88, unlimited: false }],
      },
    ],
  };
  const payload = buildMsTeamsPayload("usage.report", data);
  const combined = JSON.stringify(payload);

  // Rich account/window data must be present — the whole point of this fix.
  assert.ok(combined.includes("CODEX"), "must show the provider name");
  assert.ok(combined.includes("me@example.com"), "must show the account");
  assert.ok(combined.includes("Weekly"), "must show the window display name");
  assert.ok(combined.includes("18%"), "must show the remaining percentage");
  // It must NOT collapse to the generic event description.
  assert.ok(
    !combined.includes("Periodic OAuth quota summary"),
    "must not fall back to the generic description when account data exists"
  );
  // ColumnSet rows carry the bar + %; they are nested inside per-account
  // Containers, so assert the serialized card contains at least one.
  assert.ok(combined.includes('"ColumnSet"'), "depleting windows must render as ColumnSet rows");
});

test("buildMsTeamsPayload — usage.report with no accounts still yields a valid card", () => {
  const payload = buildMsTeamsPayload("usage.report", { intervalMinutes: 70, accounts: [] });
  const body = payload.attachments[0].content.body;
  assert.ok(body.length >= 1, "must have a non-empty body");
  const combined = JSON.stringify(payload);
  assert.ok(combined.includes("No accounts"), "empty state must be shown");
});

test("buildMsTeamsPayload — combo.switched shows from/to providers, not the generic description", () => {
  const payload = buildMsTeamsPayload("combo.switched", {
    combo: "always-on",
    fromProvider: "codex",
    fromTier: "premium",
    toProvider: "glm",
    toModel: "glm/glm-5.1",
    toTier: "cheap",
  });
  const combined = JSON.stringify(payload);
  assert.ok(combined.includes("CODEX"), "must show the from provider");
  assert.ok(combined.includes("GLM"), "must show the to provider");
  assert.ok(combined.includes("glm/glm-5.1"), "must show the model now serving");
  assert.ok(combined.includes("always-on"), "must show the combo name");
});

test("buildMsTeamsPayload — usage.report stays well under the 28KB Teams limit", () => {
  // A pathological report: many accounts, each with many windows.
  const accounts = Array.from({ length: 30 }, (_, i) => ({
    provider: `provider-${i}`,
    account: `account-${i}@example.com`,
    worstRemainingPct: 5,
    windows: Array.from({ length: 8 }, (_, j) => ({
      name: `window-${j}`,
      displayName: `Window ${j}`,
      remainingPct: (j * 11) % 100,
      unlimited: false,
    })),
  }));
  const payload = buildMsTeamsPayload("usage.report", { intervalMinutes: 70, accounts });
  const serialized = JSON.stringify(payload);
  assert.ok(
    serialized.length < 28_000,
    `payload must stay under the 28KB Teams limit, got ${serialized.length}`
  );
});
