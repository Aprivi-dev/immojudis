// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MarketEstimate } from "@/lib/market.server";
import { dvfPeriodLabel, MarketPriceDistribution } from "./BidCeilingMarket";

afterEach(cleanup);

const plain = (text: string | null) => (text ?? "").replace(/[\u00a0\u202f]/g, " ");

function estimate(overrides: Partial<MarketEstimate> = {}): MarketEstimate {
  return {
    source: "DVF normalisé",
    radiusM: 600,
    yearsBack: 3,
    areaKind: "urban",
    commune: "Bordeaux",
    sampleSize: 18,
    samplePeriod: { from: "2023-11-20", to: "2026-05-04" },
    parcelSampleSize: 18,
    totalNearbySampleSize: 40,
    outliersRemoved: 1,
    qualityScore: 80,
    qualityLabel: "forte",
    qualityWarnings: [],
    comparableMode: "surface_matched",
    surfaceMinM2: 40,
    surfaceMaxM2: 70,
    medianPricePerM2: 4_000,
    p25PricePerM2: 3_600,
    p75PricePerM2: 4_500,
    minPricePerM2: 3_000,
    maxPricePerM2: 5_200,
    deviationPct: null,
    addressHistory: [],
    recentTransactions: [
      {
        date: "2023-11-20",
        pricePerM2: 3_900,
        surface: 50,
        totalPrice: 195_000,
        type: "Appartement",
        distanceM: 120,
      },
      {
        date: "2026-05-04",
        pricePerM2: 4_200,
        surface: 52,
        totalPrice: 218_400,
        type: "Appartement",
        distanceM: 300,
      },
    ],
    ...overrides,
  } as MarketEstimate;
}

describe("MarketPriceDistribution (n° 24)", () => {
  it("annonce le nombre de ventes et la période DVF dans l'en-tête", () => {
    const { container } = render(<MarketPriceDistribution estimate={estimate()} />);
    const text = plain(container.textContent);
    expect(text).toContain("18 ventes comparables (une par parcelle)");
    expect(text).toContain("DVF normalisé");
    expect(text).toContain("du 20 novembre 2023 au 04 mai 2026");
  });

  it("affiche la vraie médiane quand elle existe", () => {
    const { container } = render(<MarketPriceDistribution estimate={estimate()} />);
    expect(plain(container.textContent)).toMatch(/médiane\s*4.000/);
    expect(container.querySelector('[title^="Médiane"]')).not.toBeNull();
  });

  it("n'invente pas de médiane au milieu de p25 et p75 quand elle manque", () => {
    const { container } = render(
      <MarketPriceDistribution estimate={estimate({ medianPricePerM2: null })} />,
    );
    const text = plain(container.textContent);
    expect(text).toContain("médiane non disponible");
    // (3 600 + 4 500) / 2 = 4 050 serait la médiane fabriquée.
    expect(text).not.toMatch(/4.050/);
    expect(container.querySelector('[title^="Médiane"]')).toBeNull();
  });

  it("dessine la zone interquartile d'une couleur unie, sans dégradé", () => {
    const { container } = render(<MarketPriceDistribution estimate={estimate()} />);
    const html = container.innerHTML;
    expect(html).not.toContain("bg-gradient");
    expect(html).not.toContain("signal-opportunity");
    expect(html).not.toContain("signal-watch");
    expect(container.querySelector(".bg-foreground\\/35")).not.toBeNull();
  });

  it("affiche la période de tout l'échantillon, pas celle des seules ventes listées", () => {
    const wide = estimate({ samplePeriod: { from: "2021-03-02", to: "2026-05-04" } });
    // Les ventes listées (2023 à 2026) ne couvrent qu'une partie de l'échantillon (2021 à 2026).
    const label = plain(dvfPeriodLabel(wide));
    expect(label).toMatch(/^du .*2021.* au .*2026/);
    expect(label).not.toContain("2023");
    const single = estimate({ samplePeriod: { from: "2025-02-03", to: "2025-02-03" } });
    expect(dvfPeriodLabel(single)).toMatch(/^le /);
  });

  it("retombe sur la profondeur d'historique sans période d'échantillon", () => {
    // Même avec des ventes listées : elles ne dateraient que les meilleurs comparables.
    expect(dvfPeriodLabel(estimate({ samplePeriod: undefined }))).toBe(
      "sur les 3 dernières années",
    );
    expect(dvfPeriodLabel(estimate({ samplePeriod: null }))).toBe("sur les 3 dernières années");
    expect(dvfPeriodLabel(estimate({ samplePeriod: { from: "x", to: "y" } }))).toBe(
      "sur les 3 dernières années",
    );
  });
});
