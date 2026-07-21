import type { WebhookEvent } from "../eventDescriptions";
import { EVENT_DESCRIPTIONS } from "../eventDescriptions";

/**
 * Microsoft Teams payload builder.
 *
 * Targets the modern **Workflows (Power Automate)** incoming webhook — the
 * replacement for the retired Office 365 Connectors (classic
 * `*.webhook.office.com` URLs stopped working May 2026). The Workflows trigger
 * requires an Adaptive Card wrapped in a `{ type: "message", attachments: [...] }`
 * envelope; posting a bare AdaptiveCard returns 2xx but renders nothing.
 *
 * Notes:
 * - `contentType` must be exactly `application/vnd.microsoft.card.adaptive`.
 * - Adaptive Card schema 1.5 is the current, fully-supported version (2026).
 * - The same payload posts to a channel OR a group chat — the destination is
 *   fixed when the Workflow is created in Teams, not in the HTTP body.
 * - Teams may return 2xx even on failure (error text is in the body) and
 *   enforces a 28KB payload limit + ~4 req/s rate limit. This builder keeps
 *   payloads tiny and truncates free-form strings defensively.
 */

const ADAPTIVE_CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive";
const ADAPTIVE_CARD_SCHEMA = "http://adaptivecards.io/schemas/adaptive-card.json";
const ADAPTIVE_CARD_VERSION = "1.5";

// Cap free-form values so a single event can never approach the 28KB Teams limit.
const MAX_VALUE_LEN = 512;

/** Adaptive Card container style per event (attention/warning/good/accent). */
const EVENT_STYLES: Partial<Record<WebhookEvent, string>> = {
  "request.completed": "good",
  "request.failed": "attention",
  "provider.error": "warning",
  "provider.recovered": "good",
  "quota.exceeded": "warning",
  "usage.report": "accent",
  "combo.switched": "accent",
  "test.ping": "accent",
};

export interface AdaptiveCardFact {
  title: string;
  value: string;
}

export interface AdaptiveCardElement {
  type: string;
  [key: string]: unknown;
}

export interface AdaptiveCardContent {
  $schema: string;
  type: "AdaptiveCard";
  version: string;
  body: AdaptiveCardElement[];
  msteams?: { width: string };
}

export interface MsTeamsAttachment {
  contentType: string;
  contentUrl: null;
  content: AdaptiveCardContent;
}

export interface MsTeamsPayload {
  type: "message";
  attachments: MsTeamsAttachment[];
}

function truncate(value: string): string {
  return value.length > MAX_VALUE_LEN ? `${value.slice(0, MAX_VALUE_LEN)}…` : value;
}

/**
 * Build a Teams Workflows Adaptive Card payload for a webhook event.
 *
 * Renders a bold title (emoji + label), an optional FactSet of the well-known
 * fields present on the event data (model / provider / error / …), and a footer
 * line with the OmniRoute attribution + timestamp.
 */
export function buildMsTeamsPayload(
  event: WebhookEvent,
  data: Record<string, unknown>
): MsTeamsPayload {
  const desc = EVENT_DESCRIPTIONS[event];

  // Collect well-known scalar fields into a FactSet, in a stable, useful order.
  const factKeys = ["model", "provider", "combo", "error", "reason"] as const;
  const facts: AdaptiveCardFact[] = [];
  for (const key of factKeys) {
    const raw = data[key];
    if (typeof raw === "string" && raw.length > 0) {
      const title = key.charAt(0).toUpperCase() + key.slice(1);
      facts.push({ title, value: truncate(raw) });
    } else if (typeof raw === "number") {
      const title = key.charAt(0).toUpperCase() + key.slice(1);
      facts.push({ title, value: String(raw) });
    }
  }

  const body: AdaptiveCardElement[] = [
    {
      type: "Container",
      style: EVENT_STYLES[event] ?? "accent",
      bleed: true,
      items: [
        {
          type: "TextBlock",
          text: `${desc.emoji} ${desc.label}`,
          weight: "Bolder",
          size: "Medium",
          wrap: true,
        },
      ],
    },
  ];

  if (facts.length > 0) {
    body.push({ type: "FactSet", facts });
  } else {
    // No structured fields — fall back to the human description of the event.
    body.push({ type: "TextBlock", text: desc.description, wrap: true, isSubtle: true });
  }

  body.push({
    type: "TextBlock",
    text: `OmniRoute · ${new Date().toISOString()}`,
    wrap: true,
    isSubtle: true,
    size: "Small",
    spacing: "Medium",
  });

  return {
    type: "message",
    attachments: [
      {
        contentType: ADAPTIVE_CARD_CONTENT_TYPE,
        contentUrl: null,
        content: {
          $schema: ADAPTIVE_CARD_SCHEMA,
          type: "AdaptiveCard",
          version: ADAPTIVE_CARD_VERSION,
          body,
          msteams: { width: "Full" },
        },
      },
    ],
  };
}
