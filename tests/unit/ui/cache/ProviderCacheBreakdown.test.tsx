// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import ProviderCacheBreakdown, {
  type CacheProviderStat,
} from "@/app/(dashboard)/dashboard/cache/components/ProviderCacheBreakdown";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const resolveProviderName = (provider: string) => provider;

function stat(overrides: Partial<CacheProviderStat>): CacheProviderStat {
  return {
    requests: 10,
    totalRequests: 10,
    cachedRequests: 10,
    inputTokens: 1_000,
    cachedTokens: 900,
    cacheCreationTokens: 0,
    cacheCreationReported: true,
    ...overrides,
  };
}

describe("ProviderCacheBreakdown", () => {
  it("renders N/A for a provider that caches without reporting writes", () => {
    render(
      <ProviderCacheBreakdown
        entries={[["codex", stat({ cacheCreationReported: false, cachedTokens: 430_000_000 })]]}
        resolveProviderName={resolveProviderName}
      />
    );

    // "0" would claim the provider wrote zero tokens; the metric does not exist.
    expect(screen.getByText("usage.notApplicable")).toBeInTheDocument();
    expect(screen.getByTitle("requestLogger.detail.usageAbsent")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("renders the write count when the backend reports one", () => {
    render(
      <ProviderCacheBreakdown
        entries={[["anthropic", stat({ cacheCreationTokens: 2048 })]]}
        resolveProviderName={resolveProviderName}
      />
    );

    expect(screen.getByText("2,048")).toBeInTheDocument();
    expect(screen.queryByText("usage.notApplicable")).not.toBeInTheDocument();
  });

  it("expands a provider into its models on toggle", () => {
    render(
      <ProviderCacheBreakdown
        entries={[["kz-omniroute", stat({ totalRequests: 2_874, cachedRequests: 1_594 })]]}
        byProviderModel={{
          "kz-omniroute": {
            "pool-main-sol": stat({
              totalRequests: 1_541,
              cachedRequests: 807,
              cachedTokens: 55_740_000,
            }),
            "pool-main-opus": stat({
              totalRequests: 647,
              cachedRequests: 506,
              cachedTokens: 120_000_000,
              cacheCreationTokens: 4_750_000,
            }),
          },
        }}
        resolveProviderName={resolveProviderName}
      />
    );

    expect(screen.queryByText("pool-main-sol")).not.toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: "tableModel: kz-omniroute" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("pool-main-sol")).toBeInTheDocument();
    expect(screen.getByText("pool-main-opus")).toBeInTheDocument();
    // Model rows are ordered by cached tokens: opus first.
    const models = screen.getAllByText(/^pool-main-/).map((node) => node.textContent);
    expect(models).toEqual(["pool-main-opus", "pool-main-sol"]);
  });

  it("keeps a real number on the provider while a write-silent model shows N/A", () => {
    render(
      <ProviderCacheBreakdown
        entries={[["kz-omniroute", stat({ cacheCreationTokens: 4_750_000 })]]}
        byProviderModel={{
          "kz-omniroute": {
            "pool-main-sol": stat({ cacheCreationReported: false }),
            "pool-main-opus": stat({ cacheCreationTokens: 4_750_000 }),
          },
        }}
        resolveProviderName={resolveProviderName}
      />
    );

    // The provider row already shows the write count (opus wrote).
    expect(screen.getByText("4,750,000")).toBeInTheDocument();
    expect(screen.queryByText("usage.notApplicable")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "tableModel: kz-omniroute" }));

    // Now both rows exist: the pooled provider total plus the silent model's N/A.
    expect(screen.getAllByText("4,750,000")).toHaveLength(2);
    expect(screen.getByText("usage.notApplicable")).toBeInTheDocument();
  });

  it("does not render an expand toggle for a single-model provider", () => {
    render(
      <ProviderCacheBreakdown
        entries={[["anthropic", stat({ cacheCreationTokens: 100 })]]}
        resolveProviderName={resolveProviderName}
      />
    );

    expect(screen.queryByRole("button", { name: /tableModel/ })).not.toBeInTheDocument();
  });

  it("renders the empty state when there is nothing to show", () => {
    render(<ProviderCacheBreakdown entries={[]} resolveProviderName={resolveProviderName} />);

    expect(screen.getByText("byProvider")).toBeInTheDocument();
    expect(screen.getByText("noPromptCacheData")).toBeInTheDocument();
  });
});
