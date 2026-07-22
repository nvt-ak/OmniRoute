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

// Hard caps on the usage.report card so a large fleet of accounts/windows can
// never blow past Teams' 28KB payload limit; overflow is summarized as "+N more".
const MAX_ACCOUNTS = 10;
const MAX_WINDOWS_PER_ACCOUNT = 6;

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

function numericOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Severity dot by remaining %, matching the dashboard quota bars and the
// Telegram integration (YELLOW ≤20, GREEN ≤50).
function remainingDot(remainingPct: number): string {
  if (remainingPct <= 20) return "🔴";
  if (remainingPct <= 50) return "🟡";
  return "🟢";
}

// Thin 10-cell bar with ▰ (filled) / ▱ (empty), mirroring the Telegram card so
// both channels read identically. At least one filled cell for a low-but-nonzero
// value. e.g. 61% -> ▰▰▰▰▰▰▱▱▱▱
function thinBar(remainingPct: number, cells: number = 10): string {
  const clamped = Math.max(0, Math.min(100, remainingPct));
  let filled = Math.round((clamped / 100) * cells);
  if (clamped > 0 && filled === 0) filled = 1;
  return "▰".repeat(filled) + "▱".repeat(cells - filled);
}

// Human "resets in Xd Yh" / "in Zm" from an ISO reset timestamp; null when the
// value is missing or already in the past.
function formatResetIn(resetAt: string | null, now: number = Date.now()): string | null {
  if (!resetAt) return null;
  const ts = new Date(resetAt).getTime();
  if (!Number.isFinite(ts) || ts <= now) return null;
  let mins = Math.round((ts - now) / 60000);
  const days = Math.floor(mins / 1440);
  mins -= days * 1440;
  const hours = Math.floor(mins / 60);
  mins -= hours * 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (days === 0 && hours === 0) parts.push(`${mins}m`);
  return parts.join(" ");
}

interface UsageReportWindow {
  name?: unknown;
  displayName?: unknown;
  remainingPct?: unknown;
  resetAt?: unknown;
  unlimited?: unknown;
}

interface UsageReportAccount {
  provider?: unknown;
  account?: unknown;
  worstRemainingPct?: unknown;
  windows?: unknown;
}

function windowName(w: UsageReportWindow): string {
  if (typeof w.displayName === "string" && w.displayName.trim()) return w.displayName;
  if (typeof w.name === "string") return w.name;
  return "?";
}

/**
 * Build the card body for a `usage.report` event.
 *
 * The scalar FactSet builder can't express the nested accounts→windows shape,
 * so this renders a per-account section: a bold provider header line (with a
 * severity dot), then one `ColumnSet` row per depleting window — a monospace
 * bar + remaining % + window name + reset ETA. Full/unlimited windows are
 * summarized on a single trailing line. Mirrors the Telegram integration so
 * both channels read identically.
 */
function buildUsageReportBody(data: Record<string, unknown>): AdaptiveCardElement[] {
  const accounts = Array.isArray(data.accounts) ? (data.accounts as UsageReportAccount[]) : [];
  const intervalMinutes = numericOrNull(data.intervalMinutes);
  const body: AdaptiveCardElement[] = [];

  const header =
    intervalMinutes !== null
      ? `${EVENT_DESCRIPTIONS["usage.report"].emoji} ${EVENT_DESCRIPTIONS["usage.report"].label} · every ${intervalMinutes} min`
      : `${EVENT_DESCRIPTIONS["usage.report"].emoji} ${EVENT_DESCRIPTIONS["usage.report"].label}`;

  body.push({
    type: "Container",
    style: EVENT_STYLES["usage.report"] ?? "accent",
    bleed: true,
    items: [
      { type: "TextBlock", text: header, weight: "Bolder", size: "Medium", wrap: true },
      {
        type: "TextBlock",
        text: `${accounts.length} account${accounts.length === 1 ? "" : "s"}`,
        isSubtle: true,
        size: "Small",
        spacing: "None",
        wrap: true,
      },
    ],
  });

  if (accounts.length === 0) {
    body.push({
      type: "TextBlock",
      text: "No accounts with quota data.",
      wrap: true,
      isSubtle: true,
    });
    return body;
  }

  // Row helper: two columns — a monospace bar + right-aligned % (fixed width),
  // and the window label + reset ETA. Renders cleanly on Teams' Adaptive Card.
  const windowRow = (pct: number, label: string, resetIn: string | null): AdaptiveCardElement => {
    const pctStr = `${Math.round(pct)}`.padStart(3, " ");
    const resetSuffix = resetIn ? ` · resets in ${resetIn}` : "";
    return {
      type: "ColumnSet",
      spacing: "Small",
      columns: [
        {
          type: "Column",
          width: "auto",
          items: [
            {
              type: "TextBlock",
              text: `\`${thinBar(pct)}\` ${pctStr}%`,
              fontType: "Monospace",
              wrap: false,
            },
          ],
        },
        {
          type: "Column",
          width: "stretch",
          items: [
            {
              type: "TextBlock",
              text: truncate(`${label}${resetSuffix}`),
              wrap: true,
              isSubtle: true,
            },
          ],
        },
      ],
    };
  };

  const shownAccounts = accounts.slice(0, MAX_ACCOUNTS);
  for (const acc of shownAccounts) {
    const prov = typeof acc.provider === "string" ? acc.provider.toUpperCase() : "?";
    const name =
      typeof acc.account === "string" && acc.account.trim() ? ` — ${truncate(acc.account)}` : "";
    const worst = numericOrNull(acc.worstRemainingPct);
    const dot = worst !== null ? remainingDot(worst) : "⚪";

    const items: AdaptiveCardElement[] = [
      { type: "TextBlock", text: `${dot} **${prov}**${name}`, weight: "Bolder", wrap: true },
    ];

    const windows = Array.isArray(acc.windows) ? (acc.windows as UsageReportWindow[]) : [];
    const fullNames: string[] = [];
    let shownCount = 0;
    let hiddenDepleting = 0;
    for (const w of windows) {
      const pct = numericOrNull(w.remainingPct);
      if (w.unlimited === true || pct === null || pct >= 100) {
        fullNames.push(windowName(w));
        continue;
      }
      if (shownCount >= MAX_WINDOWS_PER_ACCOUNT) {
        hiddenDepleting += 1;
        continue;
      }
      const resetIn = typeof w.resetAt === "string" ? formatResetIn(w.resetAt) : null;
      items.push(windowRow(pct, windowName(w), resetIn));
      shownCount += 1;
    }
    if (hiddenDepleting > 0) {
      items.push({
        type: "TextBlock",
        text: `+${hiddenDepleting} more window${hiddenDepleting === 1 ? "" : "s"}`,
        isSubtle: true,
        size: "Small",
        wrap: true,
      });
    }
    if (fullNames.length > 0) {
      const FULL_CAP = 6;
      const shown = fullNames.slice(0, FULL_CAP).join(", ");
      const extra = fullNames.length - FULL_CAP;
      const suffix = extra > 0 ? `${shown}, +${extra} more` : shown;
      items.push(windowRow(100, suffix, null));
    } else if (shownCount === 0) {
      items.push({ type: "TextBlock", text: "no quota data", isSubtle: true, wrap: true });
    }

    // Each account is its own bordered container so the sections are clearly
    // delineated (Container borders/rounded corners are Teams-supported).
    body.push({ type: "Container", spacing: "Medium", separator: true, items });
  }

  if (accounts.length > MAX_ACCOUNTS) {
    body.push({
      type: "TextBlock",
      text: `+${accounts.length - MAX_ACCOUNTS} more account${accounts.length - MAX_ACCOUNTS === 1 ? "" : "s"} not shown`,
      isSubtle: true,
      wrap: true,
      spacing: "Medium",
    });
  }

  return body;
}

/**
 * Build the card body for a `combo.switched` event — a front-tier drop.
 * Renders the from→to provider/tier transition and the model now serving,
 * mirroring the Telegram integration.
 */
function buildComboSwitchedBody(data: Record<string, unknown>): AdaptiveCardElement[] {
  const desc = EVENT_DESCRIPTIONS["combo.switched"];
  const combo = typeof data.combo === "string" ? truncate(data.combo) : null;
  const fromProvider = typeof data.fromProvider === "string" ? data.fromProvider : null;
  const toProvider = typeof data.toProvider === "string" ? data.toProvider : null;
  const toModel = typeof data.toModel === "string" ? truncate(data.toModel) : null;
  const fromTier = typeof data.fromTier === "string" ? truncate(data.fromTier) : null;
  const toTier = typeof data.toTier === "string" ? truncate(data.toTier) : null;

  const fromLabel = fromProvider ? fromProvider.toUpperCase() : "premium tier";
  const toLabel = toProvider ? toProvider.toUpperCase() : "lower tier";

  const body: AdaptiveCardElement[] = [
    {
      type: "Container",
      style: EVENT_STYLES["combo.switched"] ?? "accent",
      bleed: true,
      items: [
        { type: "TextBlock", text: `${desc.emoji} ${desc.label}`, weight: "Bolder", size: "Medium", wrap: true },
      ],
    },
    { type: "TextBlock", text: `**${fromLabel}** ⤵️ **${toLabel}**`, wrap: true },
  ];

  const facts: AdaptiveCardFact[] = [];
  if (fromTier && toTier) facts.push({ title: "Tier", value: `${fromTier} → ${toTier}` });
  if (combo) facts.push({ title: "Combo", value: combo });
  if (toModel) facts.push({ title: "Now serving", value: toModel });
  if (facts.length > 0) body.push({ type: "FactSet", facts });

  body.push({
    type: "TextBlock",
    text: "Front tier exhausted — falling back to a lower tier.",
    wrap: true,
    isSubtle: true,
  });

  return body;
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

  if (event === "usage.report") {
    return wrapCard(buildUsageReportBody(data));
  }
  if (event === "combo.switched") {
    return wrapCard(buildComboSwitchedBody(data));
  }

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

  return wrapCard(body);
}

function wrapCard(body: AdaptiveCardElement[]): MsTeamsPayload {
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
