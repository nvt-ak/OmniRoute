"use client";

import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";

import { Card } from "@/shared/components";
import { useLiveRequests } from "@/hooks/useLiveDashboard";
import { selectActiveRequests, type TopologyActiveRequest } from "../home/topologyUtils";

const ProviderTopology = dynamic(() => import("../home/ProviderTopology"), { ssr: false });

type TopologyProvider = {
  id: string;
  provider: string;
  name?: string;
  /** Connection-health base state, so the topology can colour a node at rest. */
  status?: "active" | "error" | "idle";
};

export function HomeProviderTopologySection({
  providers,
  activeRequests: polledActiveRequests = [],
  lastProvider,
  errorProvider,
  enabled = true,
}: {
  providers: TopologyProvider[];
  /** Poll-derived pending requests from /api/provider-metrics (HomePageClient). */
  activeRequests?: TopologyActiveRequest[];
  lastProvider: string;
  errorProvider: string;
  enabled?: boolean;
}) {
  const t = useTranslations("home");
  // #4596: gate the live-WS connection so it only opens while the topology
  // section is actually shown on the home page.
  const { activeRequests: liveActiveRequests } = useLiveRequests({ enabled });
  // Both feeds are merged: the live socket carries per-model detail, while the
  // poll-derived pending counts from /api/provider-metrics (owned by
  // HomePageClient) keep a provider lit when the socket is closed or missed it.
  // The two feeds do NOT share a key space — polled ids run through
  // HomePageClient's normalizeProviderId (trim + lowercase + alias resolution)
  // while live ids are the raw WS payload — so both sides are keyed lowercase,
  // matching what <ProviderTopology> does internally before it lights a node.
  const liveRequests = selectActiveRequests(liveActiveRequests);
  const liveProviders = new Set(liveRequests.map(({ provider }) => provider.toLowerCase()));
  const activeRequests = [
    ...liveRequests,
    ...polledActiveRequests.filter(({ provider }) => !liveProviders.has(provider.toLowerCase())),
  ];
  const activeProviderCount = new Set(
    activeRequests.map(({ provider }) => provider.toLowerCase())
  ).size;

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold">{t("providerTopology")}</h2>
          <p className="text-xs text-text-muted">
            {t("activeError", { active: activeProviderCount, errors: errorProvider ? 1 : 0 })}
          </p>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-text-muted">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-success" />
            {t("topologyLegendActive")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-warning" />
            {t("topologyLegendRecent")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-error" />
            {t("topologyLegendError")}
          </span>
        </div>
      </div>
      <ProviderTopology
        providers={providers}
        activeRequests={activeRequests}
        lastProvider={lastProvider}
        errorProvider={errorProvider}
      />
    </Card>
  );
}
