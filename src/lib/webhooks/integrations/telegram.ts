import { getAccountDisplayName } from "@/lib/display/names";

import type { WebhookEvent } from "../eventDescriptions";
import { resolveEventDescription } from "../resolveEventDescription";

export interface TelegramSendMessagePayload {
  chat_id: string;
  text: string;
  parse_mode: "Markdown";
}

function escapeMd(s: string): string {
  // Escape Telegram Markdown v1 special chars: _ * [ ] `
  // Hyphens and parentheses are safe in Markdown v1
  return s.replace(/[_*[\]`]/g, (c) => `\\${c}`);
}

// Severity dot by remaining %, matching the dashboard quota bars
// (QUOTA_BAR_YELLOW_THRESHOLD 20, GREEN 50 in ProviderLimits/index.tsx).
function remainingDot(remainingPct: number): string {
  if (remainingPct <= 20) return "🔴";
  if (remainingPct <= 50) return "🟡";
  return "🟢";
}

// Compact UTC timestamp — "14 May 10:30 UTC" instead of raw ISO with millis.
function formatTimestamp(date: Date): string {
  const day = date.getUTCDate();
  const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month} ${hh}:${mm} UTC`;
}

// Human "resets in Xd Yh" / "in Zm" from an ISO reset timestamp; null when
// the value is missing or already in the past.
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

function footer(): string {
  return `─ OmniRoute · ${formatTimestamp(new Date())}`;
}

// Telegram bot token format: <numeric_id>:<alphanumeric_secret> (min 35 chars after colon)
const BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{35,}$/;

export function buildTelegramUrl(botToken: string): string {
  if (!BOT_TOKEN_RE.test(botToken)) {
    throw new Error("Invalid Telegram bot token format (expected <id>:<secret>)");
  }
  return `https://api.telegram.org/bot${botToken}/sendMessage`;
}

export function buildTelegramPayload(
  event: WebhookEvent,
  data: Record<string, unknown>,
  chatId: string
): TelegramSendMessagePayload {
  const desc = resolveEventDescription(event);

  if (event === "usage.report") {
    return buildUsageReportPayload(desc.emoji, desc.label, data, chatId);
  }

  if (event === "combo.switched") {
    return buildComboSwitchedPayload(desc.emoji, desc.label, data, chatId);
  }

  const isApproaching = data.reason === "approaching-cutoff";
  const model = typeof data.model === "string" ? escapeMd(data.model) : null;
  const error = typeof data.error === "string" ? escapeMd(data.error) : null;
  const provider = typeof data.provider === "string" ? escapeMd(data.provider) : null;
  const combo = typeof data.combo === "string" ? escapeMd(data.combo) : null;
  const account =
    typeof data.account === "string" && data.account.trim().length > 0
      ? escapeMd(data.account)
      : null;
  const accountId = typeof data.accountId === "string" ? data.accountId.trim() : null;
  const accountDisplay =
    account || (accountId ? escapeMd(getAccountDisplayName({ id: accountId, name: null })) : null);
  const latencyMs =
    typeof data.latencyMs === "number" && Number.isFinite(data.latencyMs) ? data.latencyMs : null;
  const fallbackCount =
    typeof data.fallbackCount === "number" && Number.isFinite(data.fallbackCount)
      ? data.fallbackCount
      : null;
  const quotaWindow = typeof data.window === "string" ? escapeMd(data.window) : null;
  const remainingPct =
    typeof data.remainingPct === "number" && Number.isFinite(data.remainingPct)
      ? data.remainingPct
      : null;
  const resetInRaw = typeof data.resetAt === "string" ? formatResetIn(data.resetAt) : null;
  const resetIn = resetInRaw ? escapeMd(resetInRaw) : null;
  const status =
    typeof data.status === "number" && Number.isFinite(data.status)
      ? data.status
      : typeof data.status === "string"
        ? data.status
        : null;
  const failureCount =
    typeof data.failureCount === "number" && Number.isFinite(data.failureCount)
      ? data.failureCount
      : null;

  // Approaching-cutoff warnings get a dedicated header + severity dot so they
  // read as an early heads-up, not a hard "quota exceeded" block.
  const headerEmoji =
    isApproaching && remainingPct !== null ? remainingDot(remainingPct) : desc.emoji;
  const headerLabel = isApproaching ? "Approaching Quota Limit" : desc.label;

  const lines: string[] = [`${headerEmoji} *${headerLabel}*`, ""];

  const providerUpper = provider ? `*${provider.toUpperCase()}*` : null;
  const statusSuffix = status !== null ? ` · ${escapeMd(String(status))}` : "";
  const providerLine = [providerUpper, accountDisplay].filter(Boolean).join(" · ");
  if (providerLine) lines.push(`${providerLine}${statusSuffix}`);
  else if (status !== null) lines.push(`Status: \`${escapeMd(String(status))}\``);
  if (model) lines.push(`Model: ${model}`);
  if (combo) lines.push(`Combo: ${combo}`);
  if (quotaWindow) lines.push(`Window: ${quotaWindow}`);
  if (remainingPct !== null) {
    lines.push(`${remainingDot(remainingPct)} *${remainingPct}% remaining*`);
  }
  if (resetIn) lines.push(`Resets in ${resetIn}`);
  if (latencyMs !== null) lines.push(`Latency: ${latencyMs}ms`);
  if (fallbackCount !== null) lines.push(`Fallbacks: ${fallbackCount}`);
  if (error) lines.push(`Error: \`${error}\``);
  if (failureCount !== null && failureCount > 1) {
    lines.push(`_${failureCount} failures grouped_`);
  }
  lines.push("");
  lines.push(`_${footer()}_`);

  return {
    chat_id: chatId,
    text: lines.join("\n"),
    parse_mode: "Markdown",
  };
}

interface UsageReportWindow {
  name?: unknown;
  displayName?: unknown;
  remainingPct?: unknown;
  used?: unknown;
  total?: unknown;
  resetAt?: unknown;
  unlimited?: unknown;
}

interface UsageReportAccount {
  provider?: unknown;
  account?: unknown;
  worstRemainingPct?: unknown;
  windows?: unknown;
}

function numericOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Thin 10-cell bar with ▰ (filled) / ▱ (empty). Rendered inside inline
// monospace so the cells align; color is carried separately by remainingDot on
// the line. At least one filled cell for a low-but-nonzero value.
// e.g. 61% -> ▰▰▰▰▰▰▱▱▱▱ · 18% -> ▰▰▱▱▱▱▱▱▱▱
function thinBar(remainingPct: number, cells: number = 10): string {
  const clamped = Math.max(0, Math.min(100, remainingPct));
  let filled = Math.round((clamped / 100) * cells);
  if (clamped > 0 && filled === 0) filled = 1;
  return "▰".repeat(filled) + "▱".repeat(cells - filled);
}

function buildUsageReportPayload(
  emoji: string,
  label: string,
  data: Record<string, unknown>,
  chatId: string
): TelegramSendMessagePayload {
  const accounts = Array.isArray(data.accounts) ? (data.accounts as UsageReportAccount[]) : [];
  const intervalMinutes = numericOrNull(data.intervalMinutes);

  const header = intervalMinutes !== null ? `${label} · every ${intervalMinutes} min` : label;
  const lines: string[] = [`${emoji} *${header}*`];
  lines.push(`_${accounts.length} account${accounts.length === 1 ? "" : "s"}_`);

  const windowName = (w: UsageReportWindow): string =>
    typeof w.displayName === "string" && w.displayName.trim()
      ? w.displayName
      : typeof w.name === "string"
        ? w.name
        : "?";

  accounts.forEach((acc, idx) => {
    // Provider name UPPERCASED + bold so the account header stands out clearly
    // above its windows (the emoji dot can't be resized on Telegram, so the
    // contrast comes from the loud provider name instead).
    const prov = typeof acc.provider === "string" ? escapeMd(acc.provider.toUpperCase()) : "?";
    const name = typeof acc.account === "string" && acc.account.trim() ? escapeMd(acc.account) : "";
    const worst = numericOrNull(acc.worstRemainingPct);
    const dot = worst !== null ? remainingDot(worst) : "⚪";
    const nameSuffix = name ? ` — ${name}` : "";

    // Thin divider between accounts (not before the first) so sections are easy
    // to tell apart without heavy separators.
    lines.push("");
    if (idx > 0) {
      lines.push("┈┈┈┈┈┈┈┈┈┈┈┈");
      lines.push("");
    }
    // One color dot per account (the section marker); windows below stay
    // dot-free so the thin bar isn't visually overwhelmed.
    lines.push(`${dot} *${prov}*${nameSuffix}`);

    const windows = Array.isArray(acc.windows) ? (acc.windows as UsageReportWindow[]) : [];
    if (windows.length === 0) {
      lines.push("   _no quota data_");
      return;
    }

    // Windows are rendered as CHILDREN of the account header: a heavy rail +
    // deeper indent both nests them and links the account's rows, so provider
    // vs. its usage windows read as two clear levels.
    // Depleting windows (<100%, not unlimited) get a bar; full ones are named
    // on one trailing line so nothing is lost.
    const INDENT = "┃   ";
    const fullNames: string[] = [];
    let shownCount = 0;
    for (const w of windows) {
      const pct = numericOrNull(w.remainingPct);
      if (w.unlimited === true || pct === null || pct >= 100) {
        fullNames.push(windowName(w));
        continue;
      }
      const wlabel = escapeMd(windowName(w));
      const resetIn = typeof w.resetAt === "string" ? formatResetIn(w.resetAt) : null;
      const resetSuffix = resetIn ? ` · ${escapeMd(resetIn)}` : "";
      const pctStr = `${Math.round(pct)}`.padStart(3, " ");
      lines.push(`${INDENT}\`${thinBar(pct)}\` ${pctStr}%  ${wlabel}${resetSuffix}`);
      shownCount += 1;
    }
    if (fullNames.length > 0) {
      // Cap the full-window list: a long name list would wrap in Telegram and
      // the wrapped lines lose the rail/indent. Show the first few, summarize
      // the rest as "+N more".
      const FULL_CAP = 6;
      const shown = fullNames.slice(0, FULL_CAP).join(", ");
      const extra = fullNames.length - FULL_CAP;
      const suffix = extra > 0 ? `${shown}, +${extra} more` : shown;
      lines.push(`${INDENT}\`${thinBar(100)}\` 100%  ${escapeMd(suffix)}`);
    } else if (shownCount === 0) {
      lines.push(`${INDENT}_no quota data_`);
    }
  });

  if (accounts.length === 0) lines.push("\n_No accounts with quota data._");
  lines.push("");
  lines.push(`_${footer()}_`);

  return {
    chat_id: chatId,
    text: lines.join("\n"),
    parse_mode: "Markdown",
  };
}

function buildComboSwitchedPayload(
  emoji: string,
  label: string,
  data: Record<string, unknown>,
  chatId: string
): TelegramSendMessagePayload {
  const combo = typeof data.combo === "string" ? escapeMd(data.combo) : null;
  const fromProvider = typeof data.fromProvider === "string" ? data.fromProvider : null;
  const toProvider = typeof data.toProvider === "string" ? data.toProvider : null;
  const toModel = typeof data.toModel === "string" ? escapeMd(data.toModel) : null;
  const fromTier = typeof data.fromTier === "string" ? escapeMd(data.fromTier) : null;
  const toTier = typeof data.toTier === "string" ? escapeMd(data.toTier) : null;

  const fromLabel = fromProvider ? `*${escapeMd(fromProvider.toUpperCase())}*` : "premium tier";
  const toLabel = toProvider ? `*${escapeMd(toProvider.toUpperCase())}*` : "lower tier";

  const lines: string[] = [`${emoji} *${label}*`, ""];
  lines.push(`${fromLabel} ⤵️ ${toLabel}`);
  if (fromTier && toTier) lines.push(`Tier: ${fromTier} → ${toTier}`);
  if (combo) lines.push(`Combo: ${combo}`);
  if (toModel) lines.push(`Now serving: ${toModel}`);
  lines.push("");
  lines.push("_Front tier exhausted — falling back to a lower tier._");
  lines.push("");
  lines.push(`_${footer()}_`);

  return {
    chat_id: chatId,
    text: lines.join("\n"),
    parse_mode: "Markdown",
  };
}
