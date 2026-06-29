// @vitest-environment jsdom
//
// #4606: the provider-topology card was extracted into HomeProviderTopologySection
// and its activity fetch gated behind widget visibility in HomePageClient
// (`appearanceSettingsLoaded && showProviderTopologyOnHome`). This guards the
// extracted section: it renders the topology card and feeds live active-requests
// through selectActiveRequests into ProviderTopology (Rule #18 for the change).
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Use the shared next-intl test adapter backed by the real English messages.
// The contract is the visible legend, not the internal translation key names.
vi.mock("next/dynamic", () => ({
  default: () => (props: Record<string, unknown>) => (
    <div
      data-testid="provider-topology"
      data-providers={String((props.providers as unknown[])?.length ?? 0)}
      data-active={String((props.activeRequests as unknown[])?.length ?? 0)}
    />
  ),
}));
vi.mock("@/shared/components", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div data-testid="card">{children}</div>,
}));

// The live WS feed is stubbed so the merge with the poll-derived prop is deterministic.
const liveRequests: Array<{ provider: string; model: string }> = [];
vi.mock("@/hooks/useLiveDashboard", () => ({
  useLiveRequests: () => ({ activeRequests: liveRequests }),
}));

const { HomeProviderTopologySection } =
  await import("../../../src/app/(dashboard)/dashboard/HomeProviderTopologySection");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  liveRequests.length = 0;
  vi.clearAllMocks();
});

it("renders the topology card and forwards providers to ProviderTopology", () => {
  act(() => {
    root.render(
      <HomeProviderTopologySection
        providers={[
          { id: "p1", provider: "openai", name: "OpenAI" },
          { id: "p2", provider: "anthropic", name: "Anthropic" },
        ]}
        lastProvider="openai"
        errorProvider=""
      />
    );
  });

  expect(container.querySelector("[data-testid='card']")).not.toBeNull();
  const topology = container.querySelector("[data-testid='provider-topology']");
  expect(topology).not.toBeNull();
  expect(topology?.getAttribute("data-providers")).toBe("2");
  expect(container.querySelector("h2")?.textContent).toBe("Provider Topology");
  expect(container.querySelector("p")?.textContent).toBe("0 active · 0 error");
  const legend = Array.from(container.querySelectorAll("span"))
    .map((element) => element.textContent)
    .filter(Boolean);
  expect(legend).toEqual(["Active", "Recent", "Error"]);
});

it("forwards poll-derived active requests to ProviderTopology", () => {
  act(() => {
    root.render(
      <HomeProviderTopologySection
        providers={[{ id: "p1", provider: "openai", name: "OpenAI" }]}
        activeRequests={[
          { provider: "openai", model: "" },
          { provider: "anthropic", model: "" },
        ]}
        lastProvider="openai"
        errorProvider=""
      />
    );
  });

  const topology = container.querySelector("[data-testid='provider-topology']");
  expect(topology?.getAttribute("data-active")).toBe("2");
});

it("merges the live feed with poll-derived requests, deduped per provider", () => {
  liveRequests.push({ provider: "openai", model: "gpt-4o" });

  act(() => {
    root.render(
      <HomeProviderTopologySection
        providers={[{ id: "p1", provider: "openai", name: "OpenAI" }]}
        activeRequests={[
          { provider: "openai", model: "" },
          { provider: "anthropic", model: "" },
        ]}
        lastProvider="openai"
        errorProvider=""
      />
    );
  });

  // openai comes from the socket (with its model), anthropic only from polling:
  // the poll-only duplicate for openai is dropped, so two entries reach the topology.
  const topology = container.querySelector("[data-testid='provider-topology']");
  expect(topology?.getAttribute("data-active")).toBe("2");
  expect(container.querySelector("p")?.textContent).toBe("2 active · 0 error");
});

// The WS payload is unnormalized while the polled ids ran through
// normalizeProviderId, so a case difference must not resurrect a duplicate node
// or double-count the provider in the "{active} active" header.
it("dedupes across feeds when the live provider id differs only by case", () => {
  liveRequests.push({ provider: "OpenAI", model: "gpt-4o" });

  act(() => {
    root.render(
      <HomeProviderTopologySection
        providers={[{ id: "p1", provider: "openai", name: "OpenAI" }]}
        activeRequests={[{ provider: "openai", model: "" }]}
        lastProvider="openai"
        errorProvider=""
      />
    );
  });

  const topology = container.querySelector("[data-testid='provider-topology']");
  expect(topology?.getAttribute("data-active")).toBe("1");
  expect(container.querySelector("p")?.textContent).toBe("1 active · 0 error");
});
