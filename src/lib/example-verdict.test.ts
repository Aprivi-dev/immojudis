import { describe, expect, it } from "vitest";
import { bidVerdict } from "./bid-verdict";
import { EXAMPLE_SALE_RECORDS, exampleHeadlineFigures } from "./example-sale";
import { exampleVerdictData, findExampleScenario } from "./example-verdict";

describe("données de la fiche exemple de l'accueil", () => {
  const data = exampleVerdictData();

  it("calcule un plafond pour chaque projet, occupation et niveau de travaux", () => {
    expect(data.scenarios).toHaveLength(18);
    expect(data.scenarios.every((scenario) => scenario.ceiling >= 0)).toBe(true);
  });

  it("donne, dans la situation par défaut, le même plafond que /annonce-exemple", () => {
    const scenario = findExampleScenario(data.scenarios, "habiter", "occupe", "rafraichissement");
    expect(scenario?.ceiling).toBe(exampleHeadlineFigures().ceiling);
  });

  it("couvre les trois verdicts, pour que la démonstration aille du vert au rouge", () => {
    const verdicts = new Set(
      data.scenarios.map((scenario) => bidVerdict(scenario.ceiling, data.startingPrice)),
    );
    expect(verdicts).toEqual(new Set(["go", "tight", "pass"]));
  });

  it("reprend les faits de l'annonce exemple, sans valeur saisie à la main", () => {
    const { sale, marketEstimate } = EXAMPLE_SALE_RECORDS.bordeaux;
    expect(data.startingPrice).toBe(sale.starting_price_eur);
    expect(data.value).toBe(marketEstimate.estimatedValueEur);
    expect(data.comparables).toBe(marketEstimate.sampleSize);
    expect(data.sameBuilding).toMatchObject({
      year: 2024,
      month: "septembre",
      totalPrice: 226_000,
    });
    expect(data.startingGapPct).toBe(59);
    expect(data.occupationPage).toBe(3);
    expect(data.registrationRatePct).toBe(6.32);
    expect(data.photo).toBe("/media/landing/dossier-apartment.webp");
    expect(sale.media?.[0]?.url.startsWith(`${data.photo}?`)).toBe(true);
  });
});
