"use client";

import { useState } from "react";
import Badge from "@/shared/components/Badge";
import Button from "@/shared/components/Button";
import Icon from "@/shared/components/Icon";
import { WebhookDeliveriesPanel } from "./WebhookDeliveriesPanel";

export type WebhookKind = "slack" | "telegram" | "discord" | "msteams" | "custom";

export interface WebhookItem {
  id: string;
  url: string;
  events: string[];
  secret: string | null;
  enabled: boolean;
  description: string;
  created_at: string;
  last_triggered_at: string | null;
  last_status: number | null;
  failure_count: number;
  kind: WebhookKind;
  metadata_encrypted?: string | null;
}

const KIND_ICONS: Record<WebhookKind, string> = {
  slack: "chat",
  telegram: "send",
  discord: "forum",
  msteams: "groups",
  custom: "webhook",
};

const KIND_COLORS: Record<WebhookKind, string> = {
  slack: "text-chart-1",
  telegram: "text-chart-2",
  discord: "text-chart-3",
  msteams: "text-chart-5",
  custom: "text-chart-4",
};

function getStatus(wh: WebhookItem): "active" | "inactive" | "errored" {
  if (!wh.enabled) return "inactive";
  if (wh.failure_count > 0 || (wh.last_status !== null && wh.last_status >= 400)) return "errored";
  return "active";
}

interface WebhookCardProps {
  webhook: WebhookItem;
  t: (key: string, opts?: Record<string, unknown>) => string;
  testingId: string | null;
  sendingUsageId?: string | null;
  onTest: (wh: WebhookItem) => void;
  onSendUsage?: (wh: WebhookItem) => void;
  onToggleEnabled: (wh: WebhookItem) => void;
  onEdit: (wh: WebhookItem) => void;
  onDelete: (wh: WebhookItem) => void;
}

export function WebhookCard({
  webhook,
  t,
  testingId,
  sendingUsageId,
  onTest,
  onSendUsage,
  onToggleEnabled,
  onEdit,
  onDelete,
}: WebhookCardProps) {
  const [expanded, setExpanded] = useState(false);
  const status = getStatus(webhook);
  const isTesting = testingId === webhook.id;
  const isSendingUsage = sendingUsageId === webhook.id;

  return (
    <div className="rounded-xl border border-border bg-surface">
      <div className="flex min-w-0 flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 basis-0 items-center gap-3">
          <Icon
            name={KIND_ICONS[webhook.kind]}
            size={22}
            className={`shrink-0 ${KIND_COLORS[webhook.kind]}`}
          />
          <div className="min-w-0 flex-1">
            <p
              className="truncate text-sm font-semibold text-text-main"
              title={webhook.description || t("unnamedWebhook")}
            >
              <span aria-hidden="true">{webhook.description || t("unnamedWebhook")}</span>
              <span className="sr-only">{webhook.description || t("unnamedWebhook")}</span>
            </p>
            <p className="truncate text-xs text-text-muted" title={webhook.url}>
              <span aria-hidden="true">{webhook.url}</span>
              <span className="sr-only">{webhook.url}</span>
            </p>
          </div>
          <Badge
            className="shrink-0"
            variant={status === "active" ? "success" : status === "errored" ? "error" : "default"}
          >
            {t(status)}
          </Badge>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1 sm:ml-auto sm:justify-end">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onTest(webhook)}
            disabled={isTesting}
            title={t("testWebhook")}
            aria-label={t("testWebhook")}
          >
            <Icon
              name={isTesting ? "sync" : "send"}
              size={18}
              className={isTesting ? "animate-spin" : undefined}
            />
          </Button>
          {onSendUsage && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onSendUsage(webhook)}
              disabled={isSendingUsage}
              title={t("sendUsage")}
              aria-label={t("sendUsage")}
            >
              <Icon
                name={isSendingUsage ? "sync" : "monitoring"}
                size={18}
                className={isSendingUsage ? "animate-spin" : undefined}
              />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            icon={webhook.enabled ? "toggle_on" : "toggle_off"}
            onClick={() => onToggleEnabled(webhook)}
            title={webhook.enabled ? t("disable") : t("enable")}
            // Stable name + pressed state ("Enabled, pressed"); a flipping action label
            // next to aria-pressed would read "Disable, pressed".
            aria-label={t("enabled")}
            aria-pressed={webhook.enabled}
          />
          <Button
            variant="ghost"
            size="icon"
            icon="edit"
            onClick={() => onEdit(webhook)}
            title={t("edit")}
            aria-label={t("edit")}
          />
          <Button
            variant="ghost"
            size="icon"
            icon="delete"
            className="text-error"
            onClick={() => onDelete(webhook)}
            title={t("delete")}
            aria-label={t("delete")}
          />
          <Button
            variant="ghost"
            size="icon"
            icon={expanded ? "expand_less" : "expand_more"}
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? t("collapseDetails") : t("expandDetails")}
            aria-label={expanded ? t("collapseDetails") : t("expandDetails")}
            aria-expanded={expanded}
          />
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border px-4 pb-4 pt-3">
          <div className="mb-3 flex flex-wrap gap-1">
            {webhook.events.map((ev) => (
              <Badge key={ev} size="sm">
                {ev === "*" ? t("allEvents") : ev}
              </Badge>
            ))}
          </div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-text-muted">
            {t("deliveries.title")}
          </p>
          <WebhookDeliveriesPanel webhookId={webhook.id} t={t} />
        </div>
      )}
    </div>
  );
}
