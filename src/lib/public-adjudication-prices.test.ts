import { describe, expect, it } from "vitest";
import {
  adjudicationDirectoryFixture,
  COURT_CODE_MARKERS,
  distributionOf,
  TRIBUNAL_MARKERS,
} from "@/test/adjudication-price-directory";
import {
  buildPublicAdjudicationPrices,
  isPublicAdjudicationPricesEnabled,
  PUBLIC_ADJUDICATION_MIN_SAMPLE,
} from "./public-adjudication-prices";

describe("isPublicAdjudicationPricesEnabled", () => {
  const open = {
    PUBLIC_ADJUDICATION_PRICES_ENABLED: "true",
    ADJUDICATION_PRICE_STATISTICS_ENABLED: "true",
  };

  it("est fermé par défaut", () => {
    expect(isPublicAdjudicationPricesEnabled({})).toBe(false);
  });

  it("ne s'ouvre qu'avec exactement « true » sur les deux interrupteurs", () => {
    expect(isPublicAdjudicationPricesEnabled(open)).toBe(true);
    for (const value of ["", "TRUE", "True", "1", "yes", " true", "true ", "false"]) {
      expect(
        isPublicAdjudicationPricesEnabled({ ...open, PUBLIC_ADJUDICATION_PRICES_ENABLED: value }),
      ).toBe(false);
      expect(
        isPublicAdjudicationPricesEnabled({
          ...open,
          ADJUDICATION_PRICE_STATISTICS_ENABLED: value,
        }),
      ).toBe(false);
    }
  });

  it("reste fermé quand l'interrupteur d'arrêt des statistiques est coupé", () => {
    expect(isPublicAdjudicationPricesEnabled({ PUBLIC_ADJUDICATION_PRICES_ENABLED: "true" })).toBe(
      false,
    );
    expect(
      isPublicAdjudicationPricesEnabled({ ADJUDICATION_PRICE_STATISTICS_ENABLED: "true" }),
    ).toBe(false);
  });
});

describe("buildPublicAdjudicationPrices", () => {
  it("expose la médiane, les parts, la période et les dates de calcul nationales", () => {
    const result = buildPublicAdjudicationPrices(adjudicationDirectoryFixture());
    expect(result).toMatchObject({
      periodStart: "2023-10-01",
      periodEnd: "2026-09-30",
      builtAt: "2026-10-05T08:00:00.000Z",
      reviewedAt: "2026-10-07T09:30:00.000Z",
      sampleSize: 200,
      medianRatio: 1.3,
      aboveStartingRate: 0.7,
      atLeastDoubleRate: 0.2,
    });
  });

  it("ventile par type de bien et masque les types sous le seuil minimal", () => {
    const directory = adjudicationDirectoryFixture();
    // Un type à 9 résultats ne passerait pas le schéma ; le garde-fou de la page doit tenir seul.
    directory.national.propertyTypes = [
      ...(directory.national.propertyTypes ?? []),
      { propertyType: "land", distribution: distributionOf([2, 2, 3, 1, 1]) },
    ];
    expect(directory.national.propertyTypes.at(-1)?.distribution.sampleSize).toBe(9);

    const result = buildPublicAdjudicationPrices(directory);
    expect(result?.propertyTypes.map((item) => item.propertyType)).toEqual([
      "apartment",
      "house",
      "parking",
    ]);
    expect(
      result?.propertyTypes.every((item) => item.sampleSize >= PUBLIC_ADJUDICATION_MIN_SAMPLE),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain("Terrain");
    expect(result?.propertyTypes[0]).toMatchObject({
      label: "Appartement",
      sampleSize: 80,
      aboveStartingRate: 0.625,
    });
  });

  it("ne publie rien quand l'échantillon national est sous le seuil", () => {
    const directory = adjudicationDirectoryFixture();
    directory.national.sampleSize = PUBLIC_ADJUDICATION_MIN_SAMPLE - 1;
    expect(buildPublicAdjudicationPrices(directory)).toBeNull();
  });

  it("répartit les prix par tranche sous forme de parts, sans effectif", () => {
    const result = buildPublicAdjudicationPrices(adjudicationDirectoryFixture());
    expect(result?.bands).toEqual([
      { label: "Sous la mise à prix", share: 0.2 },
      { label: "À la mise à prix", share: 0.1 },
      { label: "Au-dessus de la mise, moins de × 1,5", share: 0.3 },
      { label: "De × 1,5 à moins de × 2", share: 0.2 },
      { label: "Au moins × 2", share: 0.2 },
    ]);
  });

  it("compte les tribunaux suffisamment fournis sans jamais les nommer", () => {
    const directory = adjudicationDirectoryFixture();
    const result = buildPublicAdjudicationPrices({
      ...directory,
      tribunals: [...directory.tribunals, { ...directory.tribunals[0], sampleSize: 9 }],
    });
    expect(result?.tribunalCount).toBe(2);
  });

  it("n'expose aucune donnée individuelle : ni vente, ni adresse, ni nom, ni tribunal", () => {
    const result = buildPublicAdjudicationPrices(adjudicationDirectoryFixture());
    const serialized = JSON.stringify(result);
    for (const marker of [...TRIBUNAL_MARKERS, ...COURT_CODE_MARKERS, "Région-Marqueur"]) {
      expect(serialized).not.toContain(marker);
    }
    // Les médianes propres aux tribunaux de la fixture (777 777 € / 333 333 €) ne sortent pas.
    expect(serialized).not.toContain("777777");
    expect(serialized).not.toContain("333333");
    expect(Object.keys(result ?? {}).sort()).toEqual(
      [
        "aboveStartingRate",
        "atLeastDoubleRate",
        "bands",
        "builtAt",
        "medianHammerPriceEur",
        "medianRatio",
        "medianStartingPriceEur",
        "periodEnd",
        "periodStart",
        "propertyTypes",
        "reliability",
        "reviewedAt",
        "sampleSize",
        "sourceLabel",
        "tribunalCount",
        "warning",
      ].sort(),
    );
    expect(serialized).not.toMatch(/https?:\/\/|source_url|address|adresse|lawyer|avocat/i);
  });
});
