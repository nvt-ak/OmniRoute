"use client";

import { Fragment, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@omniroute/ui-kit/table";
import Icon from "@/shared/components/Icon";

export interface CacheProviderStat {
  requests: number;
  totalRequests?: number;
  cachedRequests?: number;
  inputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  /**
   * False when the provider/model caches (reads > 0) but never reported a single
   * write token — implicit-cache backends (OpenAI `cached_tokens`, Gemini
   * `cachedContentTokenCount`) have no write counter at all. Render "N/A": a `0`
   * there claims "wrote zero tokens" for a metric the upstream never reports.
   */
  cacheCreationReported?: boolean;
}

export interface ProviderCacheBreakdownProps {
  /** `[providerId, stats]` pairs, already sorted by the caller. */
  entries: Array<[string, CacheProviderStat]>;
  /** Optional: older cached API responses predate the per-model split. */
  byProviderModel?: Record<string, Record<string, CacheProviderStat>>;
  resolveProviderName: (provider: string) => string;
}

function reuseRatioOf(data: CacheProviderStat): number {
  return data.inputTokens > 0 ? (data.cachedTokens / data.inputTokens) * 100 : 0;
}

function cacheRateOf(data: CacheProviderStat): number {
  const cachedRequests = data.cachedRequests ?? data.requests;
  const totalRequests = data.totalRequests ?? cachedRequests;
  return totalRequests > 0 ? (cachedRequests / totalRequests) * 100 : 0;
}

function requestsOf(data: CacheProviderStat): { cached: number; total: number } {
  const cached = data.cachedRequests ?? data.requests;
  return { cached, total: data.totalRequests ?? cached };
}

/**
 * Provider-side prompt-cache breakdown.
 *
 * A provider row can pool several backends with different caching models (a
 * remote router, a combo target). One blended number hides that — `haiku 89%`
 * plus `gpt 32%` reads as `73%`, which looks like one mediocre provider instead
 * of two very different ones. Rows expand into their models so the split is
 * visible, and a backend with no cache-write counter renders `N/A` instead of a
 * misleading `0`.
 */
export default function ProviderCacheBreakdown({
  entries,
  byProviderModel,
  resolveProviderName,
}: ProviderCacheBreakdownProps) {
  const t = useTranslations("cache");
  const tRoot = useTranslations();
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({});

  const renderCacheWrite = (data: CacheProviderStat) =>
    data.cacheCreationReported === false ? (
      <span
        className="cursor-help text-text-muted"
        title={tRoot("requestLogger.detail.usageAbsent")}
      >
        {tRoot("usage.notApplicable")}
      </span>
    ) : (
      data.cacheCreationTokens.toLocaleString()
    );

  if (entries.length === 0) {
    return (
      <div className="w-full rounded-xl border border-border bg-bg-subtle p-5">
        <div>
          <h3 className="text-sm font-medium text-text-main">{t("byProvider")}</h3>
          <p className="mt-1 text-sm text-text-muted">{t("providerCacheRateDesc")}</p>
        </div>
        <div className="mt-3 rounded-lg border border-dashed border-border px-4 py-6 text-sm text-text-muted">
          {t("noPromptCacheData")}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full rounded-xl border border-border bg-bg-subtle p-5">
      <div>
        <h3 className="text-sm font-medium text-text-main">{t("byProvider")}</h3>
        <p className="mt-1 text-sm text-text-muted">{t("providerCacheRateDesc")}</p>
      </div>

      <Table className="text-sm" containerClassName="mt-3" scrollbarLabel={t("byProvider")}>
        <TableHeader>
          <TableRow>
            <TableHead>{t("provider")}</TableHead>
            <TableHead>{t("inputTokens")}</TableHead>
            <TableHead>{t("cachedTokensCol")}</TableHead>
            <TableHead>{t("cacheCreation")}</TableHead>
            <TableHead>{t("cacheReuseRatio")}</TableHead>
            <TableHead>{t("cacheRate")}</TableHead>
            <TableHead>{t("cachedRequests")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map(([provider, data]) => {
            const { cached: cachedRequests, total: totalRequests } = requestsOf(data);
            const modelEntries = Object.entries(byProviderModel?.[provider] ?? {}).sort(
              ([, left], [, right]) => right.cachedTokens - left.cachedTokens
            );
            const isExpanded = expandedProviders[provider] === true;
            const providerName = resolveProviderName(provider);

            return (
              <Fragment key={provider}>
                <TableRow>
                  <TableCell>
                    <div className="flex items-start gap-1">
                      {modelEntries.length > 0 ? (
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedProviders((previous) => ({
                              ...previous,
                              [provider]: !previous[provider],
                            }))
                          }
                          aria-expanded={isExpanded}
                          aria-label={`${t("tableModel")}: ${providerName}`}
                          className="-ml-1 mt-0.5 rounded p-0.5 text-text-muted transition-colors hover:text-text-main"
                        >
                          <Icon
                            name="chevron_right"
                            size={16}
                            className={
                              isExpanded ? "rotate-90 transition-transform" : "transition-transform"
                            }
                          />
                        </button>
                      ) : (
                        <span className="w-4" aria-hidden="true" />
                      )}
                      <div>
                        <div className="font-medium text-text-main">{providerName}</div>
                        <div className="mt-1 text-xs text-text-muted">
                          {totalRequests.toLocaleString()} {t("requests").toLowerCase()}
                          {modelEntries.length > 0
                            ? ` · ${modelEntries.length} ${t("tableModel").toLowerCase()}`
                            : ""}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="tabular-nums text-text-main">
                    {data.inputTokens.toLocaleString()}
                  </TableCell>
                  <TableCell className="tabular-nums text-chart-2">
                    {data.cachedTokens.toLocaleString()}
                  </TableCell>
                  <TableCell className="tabular-nums text-chart-4">
                    {renderCacheWrite(data)}
                  </TableCell>
                  <TableCell className="font-semibold tabular-nums text-info">
                    {reuseRatioOf(data).toFixed(1)}%
                  </TableCell>
                  <TableCell className="font-semibold tabular-nums text-success">
                    {cacheRateOf(data).toFixed(1)}%
                  </TableCell>
                  <TableCell className="tabular-nums text-text-main">
                    {cachedRequests.toLocaleString()} / {totalRequests.toLocaleString()}
                  </TableCell>
                </TableRow>
                {isExpanded
                  ? modelEntries.map(([model, modelData]) => {
                      const { cached: modelCached, total: modelTotal } = requestsOf(modelData);
                      return (
                        <TableRow key={`${provider}::${model}`} className="bg-bg-subtle/40">
                          <TableCell className="pl-8">
                            <div className="text-text-main">{model || "—"}</div>
                            <div className="mt-1 text-xs text-text-muted">
                              {modelTotal.toLocaleString()} {t("requests").toLowerCase()}
                            </div>
                          </TableCell>
                          <TableCell className="tabular-nums text-text-main">
                            {modelData.inputTokens.toLocaleString()}
                          </TableCell>
                          <TableCell className="tabular-nums text-chart-2">
                            {modelData.cachedTokens.toLocaleString()}
                          </TableCell>
                          <TableCell className="tabular-nums text-chart-4">
                            {renderCacheWrite(modelData)}
                          </TableCell>
                          <TableCell className="tabular-nums text-info">
                            {reuseRatioOf(modelData).toFixed(1)}%
                          </TableCell>
                          <TableCell className="tabular-nums text-success">
                            {cacheRateOf(modelData).toFixed(1)}%
                          </TableCell>
                          <TableCell className="tabular-nums text-text-main">
                            {modelCached.toLocaleString()} / {modelTotal.toLocaleString()}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  : null}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
