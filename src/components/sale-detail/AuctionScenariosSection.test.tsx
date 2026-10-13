// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuctionScenariosResponse } from "@/lib/auction-scenarios";

const fetchAuctionScenarios = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-api", () => ({ fetchAuctionScenarios }));

import { AuctionScenariosSection } from "./AuctionScenariosSection";

const RESPONSE: AuctionScenariosResponse = {
  courtName: "TJ Bobigny",
  startingPrice: 45_000,
  propertyType: "apartment",
  surfaceM2: 52,
  scenarios: {
    band: 2,
    courtSample: 165,
    nationalSample: 1098,
    priceScope: "court",
    scenarios: [
      { key: "near_start", lowRatio: 0, highRatio: 1.1, probability: 0.105 },
      { key: "up_to_1_5", lowRatio: 1.1, highRatio: 1.5, probability: 0.05 },
      { key: "up_to_2", lowRatio: 1.5, highRatio: 2, probability: 0.088 },
      { key: "up_to_3", lowRatio: 2, highRatio: 3, probability: 0.239 },
      { key: "above_3", lowRatio: 3, highRatio: null, probability: 0.518 },
    ],
    ratioQuartiles: { q25: 2.04, q50: 3.1, q75: 4.625 },
  },
  history: {
    licitor: {
      sample: 442,
      firstSale: "2023-10-20",
      lastSale: "2026-09-03",
      meanStartingPrice: 61_000,
      meanHammerPrice: 140_000,
      medianStartingPrice: 50_000,
      medianHammerPrice: 121_000,
      medianRatio: 2.28,
      aboveStartingRate: 0.91,
      atLeastDoubleRate: 0.57,
      byYear: [
        { year: 2024, sales: 160 },
        { year: 2025, sales: 170 },
      ],
    },
    dvf: {
      sample: 350,
      firstDate: "2023-01-04",
      lastDate: "2025-12-18",
      meanPrice: 150_000,
      medianPrice: 122_000,
      byType: [
        {
          propertyType: "apartment",
          sample: 240,
          medianPrice: 110_000,
          medianPricePerM2: 2160,
          surfaceSample: 230,
        },
      ],
    },
  },
};

function renderSection(enabled = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuctionScenariosSection saleId="sale-1" enabled={enabled} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AuctionScenariosSection", () => {
  it("shows the observed distribution of outcomes, the likely range and the court's averages", async () => {
    fetchAuctionScenarios.mockResolvedValue(RESPONSE);
    renderSection();

    expect(await screen.findByText(/D’après 165 adjudications du TJ Bobigny/)).toBeTruthy();
    expect(screen.getByText(/Prix final le plus fréquent/)).toBeTruthy();
    expect(screen.getByText(/92\s000\s€ à 208\s000\s€/)).toBeTruthy();
    expect(screen.getByText("Plus de 3 fois la mise à prix")).toBeTruthy();
    expect(screen.getByText(/^52\s%$/)).toBeTruthy();
    expect(screen.getByLabelText("Répartition observée des issues")).toBeTruthy();
    expect(screen.getByText(/adjugées au moins au double de la mise à prix/).textContent).toMatch(
      /Part des ventes comparables.*76\s%/,
    );
    expect(screen.queryByText(/Chance/)).toBeNull();
    expect(
      screen.getByText(/ne constituent pas une probabilité pour cette vente/).textContent,
    ).toMatch(/Fréquences observées dans le passé sur un échantillon limité/);
    expect(screen.getByText("Prix final moyen")).toBeTruthy();
    expect(screen.getByText(/2024 : 160 · 2025 : 170/)).toBeTruthy();
    expect(screen.getByText(/2\s160 €\/m², soit environ 112\s000\s€ pour 52 m²/)).toBeTruthy();
    expect(fetchAuctionScenarios).toHaveBeenCalledWith("sale-1");
  });

  it("says when there are not enough comparable sales", async () => {
    fetchAuctionScenarios.mockResolvedValue({ ...RESPONSE, scenarios: null });
    renderSection();
    expect(await screen.findByText(/Pas assez d’adjudications comparables/)).toBeTruthy();
  });

  it("reads nothing when the member has no access", () => {
    renderSection(false);
    expect(fetchAuctionScenarios).not.toHaveBeenCalled();
  });
});
