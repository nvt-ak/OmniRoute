/**
 * API: Webhook Send Current Usage
 * POST — Send a real usage.report (built from the latest CACHED quota, never an
 * upstream fetch) to a specific webhook and return delivery diagnostics.
 * Separate from the plain test-ping action so operators can push an on-demand
 * usage snapshot without triggering a live provider fetch.
 */

import { NextResponse } from "next/server";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { getWebhook } from "@/lib/localDb";
import { decryptMetadata } from "@/lib/webhookDispatcher";
import { buildSlackPayload } from "@/lib/webhooks/integrations/slack";
import { buildTelegramUrl, buildTelegramPayload } from "@/lib/webhooks/integrations/telegram";
import { buildDiscordPayload } from "@/lib/webhooks/integrations/discord";
import { buildUsageReportFromCache } from "@/lib/usage/providerLimits";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { insertDelivery } from "@/lib/db/webhookDeliveries";
import { recordWebhookDelivery } from "@/lib/localDb";
import { parseAndValidateWebhookUrl, isPrivateHost } from "@/shared/network/outboundUrlGuard";
import crypto from "crypto";

const MAX_RESPONSE_BODY = 2048;
const EVENT = "usage.report" as const;

async function deliver(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>
): Promise<{
  success: boolean;
  status: number;
  latencyMs: number;
  responseBody: string;
  error?: string;
}> {
  const start = Date.now();
  try {
    const parsed = parseAndValidateWebhookUrl(url);
    const redactBody = isPrivateHost(parsed.hostname);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "OmniRoute-Webhook/1.0",
          ...headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - start;
      let rawBody = "";
      try {
        rawBody = await res.text();
        if (rawBody.length > MAX_RESPONSE_BODY) rawBody = rawBody.slice(0, MAX_RESPONSE_BODY) + "…";
      } catch {
        rawBody = "";
      }
      return {
        success: res.ok,
        status: res.status,
        latencyMs,
        responseBody: redactBody ? "<redacted: private target>" : rawBody,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error: any) {
    return {
      success: false,
      status: 0,
      latencyMs: Date.now() - start,
      responseBody: "",
      error: error.message || "Network error",
    };
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;
    const webhook = getWebhook(id);
    if (!webhook) {
      return NextResponse.json({ error: "Webhook not found" }, { status: 404 });
    }

    const report = await buildUsageReportFromCache();
    if (!report || report.accountCount === 0) {
      return NextResponse.json(
        { error: "No cached quota available yet — open the Usage page or wait for the next sync." },
        { status: 422 }
      );
    }

    const data = report as unknown as Record<string, unknown>;
    const kind = webhook.kind ?? "custom";
    const payload = { event: EVENT, timestamp: new Date().toISOString(), data };

    let payloadSent: Record<string, unknown>;
    let fetchUrl: string;
    const extraHeaders: Record<string, string> = {};

    if (kind === "slack") {
      payloadSent = buildSlackPayload(EVENT, data) as Record<string, unknown>;
      fetchUrl = webhook.url;
    } else if (kind === "discord") {
      payloadSent = buildDiscordPayload(EVENT, data) as Record<string, unknown>;
      fetchUrl = webhook.url;
    } else if (kind === "telegram") {
      const meta = decryptMetadata(webhook.metadata_encrypted ?? null);
      const botToken = meta?.botToken;
      if (!botToken) {
        return NextResponse.json({ error: "Missing Telegram botToken" }, { status: 422 });
      }
      fetchUrl = buildTelegramUrl(botToken);
      payloadSent = buildTelegramPayload(EVENT, data, webhook.url) as Record<string, unknown>;
    } else {
      payloadSent = payload as Record<string, unknown>;
      fetchUrl = webhook.url;
      if (webhook.secret) {
        const bodyStr = JSON.stringify(payload);
        extraHeaders["X-Webhook-Signature"] =
          `sha256=${crypto.createHmac("sha256", webhook.secret).update(bodyStr).digest("hex")}`;
        extraHeaders["X-Webhook-Event"] = EVENT;
        extraHeaders["X-Webhook-Timestamp"] = payload.timestamp;
      }
    }

    const result = await deliver(fetchUrl, payloadSent, extraHeaders);

    try {
      insertDelivery({
        webhookId: webhook.id,
        eventType: EVENT,
        status: result.success ? "success" : "failed",
        httpStatus: result.status || null,
        latencyMs: result.latencyMs,
        error: result.error ?? null,
        payloadSnapshot: kind === "custom" ? JSON.stringify(payloadSent).slice(0, 2000) : null,
      });
    } catch {
      // delivery logging is best-effort
    }
    recordWebhookDelivery(webhook.id, result.status, result.success);

    return NextResponse.json({
      delivered: result.success,
      status: result.status,
      latencyMs: result.latencyMs,
      accountCount: report.accountCount,
      responseBody: result.responseBody,
      error: result.error ? sanitizeErrorMessage(result.error) : null,
    });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}
