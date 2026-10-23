// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuctionScenariosResponse } from "@/lib/auction-scenarios";

const fetchAuctionScenarios = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-api", () => ({ fetchAuctionScenarios }));

import { AuctionScenariosSection } from "./AuctionScenariosSection";

const RESPONSE: AuctionScenariosResponse = {
  courtName: "TJ Bobigny",
  startingPrice: 45_000,
  propertyType: "apartment",
  unavailable: null,
  dataAsOf: "2026-10-22T14:03:00+00:00",
  scenarios: {
    status: "ok",
    band: 2,
    courtSample: 165,
    nationalSample: 1098,
    basis: "court",
    reliability: "good",
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
  it("shows the observed distribution of outcomes, the likely range and the court's medians", async () => {
    fetchAuctionScenarios.mockResolvedValue(RESPONSE);
    renderSection();

    expect(await screen.findByText(/D’après 165 adjudications du TJ Bobigny/)).toBeTruthy();
    expect(screen.getByText(/D’après 165 adjudications du TJ Bobigny/).textContent).toMatch(
      /1\s098 sur les tribunaux couverts/,
    );
    expect(screen.queryByText(/en France/)).toBeNull();
    expect(
      screen.getByText(
        "Fourchette centrale des prix d’adjudication (estimation à partir des ventes passées)",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Prix final le plus fréquent/)).toBeNull();
    const range = screen.getByText(
      /Dans la moitié centrale des ventes comparables du TJ Bobigny, le prix d’adjudication, avant éventuelle surenchère,/,
    ).textContent;
    expect(range).toMatch(/entre ×2,0 et ×4,6 la mise à prix\. Appliqué à cette vente/);
    expect(range).toMatch(
      /cela donne environ 92\s000\s€ à 208\s000\s€, hors frais, avec un prix médian d’environ/,
    );
    expect(range).toMatch(/\(×3,1\)\. Ce n’est pas une prévision\.$/);
    expect(screen.getByText(/^92\s000\s€ à 208\s000\s€$/)).toBeTruthy();
    expect(screen.getByText("Plus de 3 fois la mise à prix")).toBeTruthy();
    expect(screen.getByText(/^52\s%$/)).toBeTruthy();
    expect(screen.getByLabelText("Répartition observée des issues")).toBeTruthy();
    expect(screen.getByText(/adjugées à au moins 2 fois la mise à prix :/).textContent).toMatch(
      /Part estimée des ventes comparables.*76\s%/,
    );
    expect(screen.queryByText(/Chance/)).toBeNull();
    expect(
      screen.getByText(/ne constituent pas une probabilité pour cette vente/).textContent,
    ).toMatch(/Fréquences observées dans le passé sur un échantillon limité/);
    expect(screen.getByText("Mise à prix médiane")).toBeTruthy();
    expect(
      screen.getByText(/Prix d’adjudication médian \(avant éventuelle surenchère, hors frais\)/),
    ).toBeTruthy();
    expect(screen.queryByText(/moyen/i)).toBeNull();
    expect(screen.getByText(/2024 : 160 · 2025 : 170/)).toBeTruthy();
    expect(fetchAuctionScenarios).toHaveBeenCalledWith("sale-1");
  });

  it("n'affiche plus la référence DVF « Y € pour Z m² »", async () => {
    fetchAuctionScenarios.mockResolvedValue({ ...RESPONSE, surfaceM2: 52 });
    renderSection();
    await screen.findByText(/D’après 165 adjudications/);
    expect(screen.queryByText(/€\/m²/)).toBeNull();
    expect(screen.queryByText(/pour 52 m²/)).toBeNull();
    expect(screen.getByText(/Prix officiels \(DVF\) : 350 adjudications/).textContent).toMatch(
      /prix médian 122\s000\s€\.$/,
    );
  });

  it("met l'avertissement sur le biais de survie en tête, avant les chiffres", async () => {
    fetchAuctionScenarios.mockResolvedValue(RESPONSE);
    renderSection();
    const warning = await screen.findByText(/À lire avant les chiffres/);
    const paragraph = warning.closest("p")!;
    expect(paragraph.textContent).toMatch(
      /ne comptent ni les reports ni les ventes restées sans enchérisseur/,
    );
    expect(paragraph.textContent).toMatch(/créancier poursuivant/);
    expect(paragraph.textContent).toMatch(/tirent les rapports observés vers le haut/);
    expect(paragraph.textContent).not.toMatch(/article|L\.\s?\d|R\.\s?\d/);
    const headline = screen.getByText(/^Fourchette centrale/);
    expect(
      paragraph.compareDocumentPosition(headline) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("répartit les pourcentages pour totaliser exactement 100 % dans une barre empilée", async () => {
    fetchAuctionScenarios.mockResolvedValue({
      ...RESPONSE,
      scenarios: {
        ...RESPONSE.scenarios!,
        // 33,4 / 33,3 / 33,3 / 0 / 0 : arrondis chacun seul, 33 + 33 + 33 = 99.
        scenarios: [
          { key: "near_start", lowRatio: 0, highRatio: 1.1, probability: 0.334 },
          { key: "up_to_1_5", lowRatio: 1.1, highRatio: 1.5, probability: 0.333 },
          { key: "up_to_2", lowRatio: 1.5, highRatio: 2, probability: 0.333 },
          { key: "up_to_3", lowRatio: 2, highRatio: 3, probability: 0 },
          { key: "above_3", lowRatio: 3, highRatio: null, probability: 0 },
        ],
      },
    });
    const { container } = renderSection();
    const list = await screen.findByLabelText("Répartition observée des issues");
    const shown = [...list.querySelectorAll("li strong")].map((item) =>
      Number((item.textContent ?? "").replace(/\D/g, "")),
    );
    expect(shown.reduce((sum, value) => sum + value, 0)).toBe(100);
    expect(container.querySelectorAll("div[aria-hidden='true'] > span")).toHaveLength(5);
  });

  it("annonce le niveau de fiabilité renvoyé et le repli national", async () => {
    fetchAuctionScenarios.mockResolvedValue({
      ...RESPONSE,
      scenarios: { ...RESPONSE.scenarios!, courtSample: 6, basis: "national", reliability: "low" },
    });
    renderSection();
    const reliability = await screen.findByText(/Niveau de fiabilité/);
    expect(reliability.textContent).toMatch(/faible/);
    expect(reliability.getAttribute("data-reliability")).toBe("low");
    expect(screen.getByText(/Moins de 10 ventes comparables au TJ Bobigny \(6\)/)).toBeTruthy();
  });

  it("affiche la date des données et marque l'année en cours comme partielle", async () => {
    const year = new Date().getFullYear();
    fetchAuctionScenarios.mockResolvedValue({
      ...RESPONSE,
      history: {
        ...RESPONSE.history,
        licitor: {
          ...RESPONSE.history.licitor!,
          byYear: [
            { year: year - 1, sales: 160 },
            { year, sales: 40 },
          ],
        },
      },
    });
    renderSection();
    expect(await screen.findByText("Données au 22/10")).toBeTruthy();
    expect(screen.getByText(new RegExp(`${year} \\(partielle\\) : 40`))).toBeTruthy();
    expect(screen.queryByText(new RegExp(`${year - 1} \\(partielle\\)`))).toBeNull();
  });

  it.each([
    ["no_starting_price", /n’a pas de mise à prix connue/],
    ["starting_price_too_low", /inférieure à 1\s000 €/],
    ["no_court_code", /tribunal de cette vente n’est pas encore identifié/],
  ] as const)("dit la cause quand il n'y a pas de scénario : %s", async (reason, message) => {
    fetchAuctionScenarios.mockResolvedValue({
      ...RESPONSE,
      scenarios: null,
      unavailable: reason,
      history: { licitor: null, dvf: null },
    });
    renderSection();
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByText(/Données insuffisantes/)).toBeNull();
  });

  it("affiche l'effectif quand les données sont insuffisantes", async () => {
    fetchAuctionScenarios.mockResolvedValue({
      ...RESPONSE,
      unavailable: "insufficient_data",
      scenarios: {
        status: "insufficient",
        band: 2,
        courtSample: 3,
        nationalSample: 18,
        basis: "national",
        reliability: null,
        priceScope: "national",
        scenarios: [],
        ratioQuartiles: { q25: null, q50: null, q75: null },
      },
    });
    renderSection();
    const message = await screen.findByText(/Données insuffisantes/);
    expect(message.textContent).toMatch(/18 ventes comparables seulement/);
    expect(message.textContent).toMatch(/dont 3 au TJ Bobigny/);
    expect(message.textContent).toMatch(/au moins 30 nécessaires/);
    expect(screen.queryByText(/Fourchette centrale/)).toBeNull();
    expect(screen.queryByLabelText("Répartition observée des issues")).toBeNull();
    expect(screen.queryByText(/Niveau de fiabilité/)).toBeNull();
  });

  it("dit que les statistiques n'ont pas pu être chargées et permet de réessayer", async () => {
    fetchAuctionScenarios.mockRejectedValueOnce(new Error("HTTP 500"));
    renderSection();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Les statistiques du tribunal n’ont pas pu être chargées.");
    expect(screen.queryByText(/Données insuffisantes/)).toBeNull();

    fetchAuctionScenarios.mockResolvedValue(RESPONSE);
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(await screen.findByText(/D’après 165 adjudications du TJ Bobigny/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetchAuctionScenarios).toHaveBeenCalledTimes(2);
  });

  it("reads nothing when the member has no access", () => {
    renderSection(false);
    expect(fetchAuctionScenarios).not.toHaveBeenCalled();
  });
});
