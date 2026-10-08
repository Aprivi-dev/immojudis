// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdjudicationBarometer } from "./AdjudicationBarometer";
import {
  ADJUDICATION_PRICE_STATISTICS_WARNING,
  type AdjudicationPriceStatisticsDirectoryResponse,
} from "@/lib/adjudication-price-statistics";
import { bidBands } from "@/lib/adjudication-distributions";

const distribution = {
  sampleSize: 20,
  hammerPriceMiddle50Eur: { p25: 60000, p75: 120000 },
  ratioMiddle50: { p25: 1, p75: 2 },
  bidDistribution: bidBands.map((band) => ({ band, count: 4, share: 0.2 })),
};
const directory: AdjudicationPriceStatisticsDirectoryResponse = {
  national: {
    scopeType: "national",
    courtCode: null,
    label: "France entière",
    judicialRegion: null,
    periodStart: "2023-09-20",
    periodEnd: "2026-09-20",
    sampleSize: 100,
    reliability: "extended",
    metrics: {
      medianHammerToStartingRatio: 1.8,
      medianHammerPriceEur: 150000,
      medianStartingPriceEur: 70000,
      aboveStartingRate: 0.6,
      atLeastDoubleRate: 0.2,
    },
    propertyTypes: [{ propertyType: "house", distribution }],
  },
  tribunals: [],
  meta: {
    sourceName: "licitor",
    sourceLabel: "Résultats d’adjudication publiés par Licitor",
    methodologyVersion: "licitor_canonical_price_statistics_v1",
    builtAt: "2026-09-20T10:00:00Z",
    reviewedAt: "2026-09-20T11:00:00Z",
    experimental: true,
    warning: ADJUDICATION_PRICE_STATISTICS_WARNING,
  },
};
directory.tribunals = [
  {
    ...directory.national,
    scopeType: "tribunal",
    courtCode: "saint-etienne",
    label: "TJ Saint-Étienne",
    sampleSize: 60,
    judicialRegion: "Lyon",
    reliability: "descriptive",
  },
  {
    ...directory.national,
    scopeType: "tribunal",
    courtCode: "paris",
    label: "TJ Paris",
    sampleSize: 20,
    judicialRegion: "Paris",
    reliability: "limited",
    propertyTypes: [],
  },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("AdjudicationBarometer", () => {
  it("change tout le dénominateur pour un type et ne lui attribue pas les médianes nationales", () => {
    render(<AdjudicationBarometer data={directory} initialCourtCode={null} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Type de bien" }), {
      target: { value: "house" },
    });
    const summary = screen.getByRole("region", { name: "France entière" });
    expect(within(summary).getByText(/20 prix publiés/)).toBeTruthy();
    expect(within(summary).queryByText(/150\s?000/)).toBeNull();
    expect(within(summary).getAllByText("—")).toHaveLength(3);
    expect(screen.getByRole("list", { name: "Répartition de 20 adjudications" })).toBeTruthy();
    expect(screen.getByText(/DVF · non disponible/)).toBeTruthy();
  });
  it("affiche les vraies médianes de type quand une nouvelle publication les fournit", () => {
    const enriched = structuredClone(directory);
    enriched.national.propertyTypes![0].distribution.summary = {
      medianHammerPriceEur: 90000,
      medianStartingPriceEur: 50000,
      medianHammerToStartingRatio: 1.5,
      meanHammerToStartingRatio: 1.7,
    };
    render(<AdjudicationBarometer data={enriched} initialCourtCode={null} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Type de bien" }), {
      target: { value: "house" },
    });
    const summary = screen.getByRole("region", { name: "France entière" });
    expect(within(summary).getByText(/90\s?000/)).toBeTruthy();
    expect(within(summary).getByText("1,50×")).toBeTruthy();
    expect(within(summary).getByText(/Moyenne des multiples : 1,70×/)).toBeTruthy();
  });
  it("recherche sans accents, ouvre le tribunal exact puis réinitialise une sélection vide", () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(<AdjudicationBarometer data={directory} initialCourtCode={null} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "saint-etienne" } });
    const table = screen.getByRole("region", { name: "Comparaison des tribunaux" });
    expect(within(table).queryByRole("button", { name: "Analyser TJ Paris" })).toBeNull();
    fireEvent.click(within(table).getByRole("button", { name: "Analyser TJ Saint-Étienne" }));
    expect(screen.getByRole("heading", { name: "TJ Saint-Étienne" })).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Tribunal" }) as HTMLSelectElement).value).toBe(
      "saint-etienne",
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Effectif minimum" }), {
      target: { value: "100" },
    });
    expect((screen.getByRole("button", { name: /Exporter/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Réinitialiser les filtres" }));
    expect(screen.getByRole("button", { name: "Analyser TJ Paris" })).toBeTruthy();
  });
});
