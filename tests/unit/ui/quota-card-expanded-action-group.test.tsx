// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("../../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils", () => ({
  formatCountdown: () => null,
  formatQuotaLabel: (name: string) => name,
  getBarColor: () => ({ bar: "#000", text: "#000" }),
  getQuotaRemainingPercentage: (quota: { remainingPercentage?: number }) =>
    quota.remainingPercentage ?? 0,
  shouldShowQuotaUsageCount: () => false,
}));

vi.mock(
  "../../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaMiniBar",
  () => ({ default: () => <div data-testid="quota-mini-bar" /> })
);

vi.mock(
  "../../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/i18nFallback",
  () => ({
    translateUsageOrFallback: (
      _translate: (key: string) => string,
      _key: string,
      fallback: string
    ) => fallback,
  })
);

vi.mock(
  "../../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/quotaParsing",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    hasFixedQuotaOrder: () => false,
  })
);

const { default: QuotaCardExpanded } =
  await import("../../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/parts/QuotaCardExpanded");

describe("QuotaCardExpanded action group layout", () => {
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    if (root && container) {
      act(() => root?.unmount());
    }
    container?.remove();
    container = null;
    root = null;
  });

  it("keeps the action group shrinkable when all cutoff actions are rendered", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);

    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(
        <QuotaCardExpanded
          quotas={[
            { name: "reset", isResetCredits: true, creditCount: 2 },
            { name: "credits", isCredits: true, creditCount: 10, currency: "USD" },
            { name: "session", remainingPercentage: 90, used: 1, total: 10 },
          ]}
          providerId="test"
          loading={false}
          error={null}
          hasStaleData={false}
          onRefresh={vi.fn()}
          onOpenCutoff={vi.fn()}
          onOpenCost={vi.fn()}
          onRedeemResetCredit={vi.fn()}
          canEditCutoff={true}
          hasCutoffOverrides={false}
          canRedeemResetCredit={true}
        />
      );
    });

    const actionGroup = container.querySelector("div.grid.min-w-0");
    const buttons = actionGroup?.querySelectorAll("button") ?? [];

    expect(actionGroup).not.toBeNull();
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button.classList.contains("min-w-0")).toBe(true);
    }
  });
});
