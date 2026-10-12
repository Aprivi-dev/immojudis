// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SalePassagesSection } from "./SalePassagesSection";

const mocks = vi.hoisted(() => ({ fetchSalePassages: vi.fn() }));
vi.mock("@/lib/client-api", () => ({ fetchSalePassages: mocks.fetchSalePassages }));

afterEach(cleanup);

function renderSection(enabled = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SalePassagesSection saleId="sale-1" startingPrice={188000} enabled={enabled} />
    </QueryClientProvider>,
  );
}

describe("SalePassagesSection", () => {
  it("shows the earlier passages and changes to an Analyse member", async () => {
    mocks.fetchSalePassages.mockResolvedValue({
      access: "full",
      timeline: [
        {
          kind: "first_seen",
          previous: null,
          value: null,
          observedAt: "2026-09-20T10:00:00Z",
          backfilled: false,
        },
        {
          kind: "starting_price_changed",
          previous: 200000,
          value: 188000,
          observedAt: "2026-10-01T10:00:00Z",
          backfilled: false,
        },
      ],
      previousPassages: [
        { saleDate: "2026-09-16T07:00:00Z", startingPriceEur: 170000, status: null },
      ],
      summary: { previousPassageCount: 1, priceChangePct: -6, postponementCount: 0 },
    });
    renderSection();
    const section = await screen.findByRole("region", { name: "Historique de la vente" });
    expect(section.textContent).toContain("Ce bien est déjà passé aux enchères.");
    expect(section.textContent).toContain("La mise à prix a baissé de 6 %.");
    expect(section.textContent).toContain("Audience du 16 septembre 2026");
    expect(section.textContent).toContain("Mise à prix baissée");
  });

  it("only tells a free account that a history exists", async () => {
    mocks.fetchSalePassages.mockResolvedValue({
      access: "teaser",
      summary: { previousPassageCount: 2, priceChangePct: -20, postponementCount: 0 },
    });
    renderSection();
    const section = await screen.findByRole("region", { name: "Historique de la vente" });
    expect(section.textContent).toContain("déjà passé 2 fois aux enchères");
    expect(section.textContent).not.toMatch(/septembre|€/);
    expect(screen.getByRole("link", { name: "Découvrir l’offre Analyse" })).toBeTruthy();
  });

  it("stays hidden for a free account when there is nothing to tell, and without a session", async () => {
    mocks.fetchSalePassages.mockResolvedValue({
      access: "teaser",
      summary: { previousPassageCount: 0, priceChangePct: null, postponementCount: 0 },
    });
    const { container } = renderSection();
    await vi.waitFor(() => expect(mocks.fetchSalePassages).toHaveBeenCalled());
    expect(container.textContent).toBe("");
    cleanup();
    mocks.fetchSalePassages.mockClear();
    renderSection(false);
    expect(mocks.fetchSalePassages).not.toHaveBeenCalled();
  });
});
