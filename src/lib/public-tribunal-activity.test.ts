import { describe, expect, it } from "vitest";
import {
  courtShortName,
  mapPublicTribunalActivity,
  publicTribunalTotals,
  tribunalPriceFigure,
  tribunalSampleLabel,
} from "./public-tribunal-activity";

describe("public tribunal activity", () => {
  it("names a court by its city, without repeating « tribunal judiciaire »", () => {
    expect(courtShortName("TJ Bobigny")).toBe("Bobigny");
    expect(courtShortName("TJ Tribunal judiciaire du Mans")).toBe("Le Mans");
    expect(courtShortName("TJ Tribunal judiciaire des Sables-d'Olonne")).toBe(
      "Les Sables-d'Olonne",
    );
    expect(courtShortName("Tribunal judiciaire d’Évry")).toBe("Évry");
  });

  it("never shows the raw code of a court as its name (missing canonical name)", () => {
    expect(courtShortName("justice_tj_1_210")).toBe("Tribunal à confirmer");
    const [item] = mapPublicTribunalActivity([
      {
        tribunal_code: "justice_tj_1_210",
        tribunal_name: null,
        tribunal_city: null,
        department: "93",
        upcoming_count: 4,
        next_sale_date: null,
        median_starting_price_eur: null,
        house_count: 0,
        apartment_count: 4,
        other_count: 0,
      },
    ]);
    expect(item.name).toBe("Tribunal à confirmer");
    expect(item.code).toBe("justice_tj_1_210");
  });

  it("keeps courts with upcoming sales, busiest first, and totals them", () => {
    const items = mapPublicTribunalActivity([
      {
        tribunal_code: "pau",
        tribunal_name: "TJ Pau",
        tribunal_city: "Pau",
        department: "64",
        upcoming_count: 7,
        next_sale_date: "2026-10-16T00:00:00Z",
        median_starting_price_eur: "59000",
        house_count: 4,
        apartment_count: 3,
        other_count: 0,
      },
      {
        tribunal_code: "bobigny",
        tribunal_name: "TJ Bobigny",
        tribunal_city: "Bobigny",
        department: "93",
        upcoming_count: 107,
        next_sale_date: null,
        median_starting_price_eur: null,
        house_count: 17,
        apartment_count: 67,
        other_count: 23,
      },
      {
        tribunal_code: "empty",
        tribunal_name: "TJ Vide",
        tribunal_city: null,
        department: null,
        upcoming_count: 0,
        next_sale_date: null,
        median_starting_price_eur: null,
        house_count: 0,
        apartment_count: 0,
        other_count: 0,
      },
    ]);
    expect(items.map((item) => item.name)).toEqual(["Bobigny", "Pau"]);
    expect(items[1].medianStartingPriceEur).toBe(59_000);
    expect(publicTribunalTotals(items)).toEqual({ tribunals: 2, upcoming: 114 });
  });
});

describe("tribunalPriceFigure : seuils de publication des prix", () => {
  const base = {
    upcomingCount: 40,
    medianStartingPriceEur: 80_000,
    minStartingPriceEur: 30_000,
    maxStartingPriceEur: 150_000,
  };

  it("ne publie aucun chiffre sous 5 ventes chiffrées, seulement leur nombre", () => {
    expect(tribunalPriceFigure({ ...base, pricedCount: 4 })).toEqual({
      kind: "none",
      sampleSize: 4,
    });
    expect(tribunalPriceFigure({ ...base, pricedCount: 0 })).toEqual({
      kind: "none",
      sampleSize: 0,
    });
  });

  it("publie la fourchette observée de 5 à 9 ventes, jamais une médiane", () => {
    for (const pricedCount of [5, 9]) {
      expect(tribunalPriceFigure({ ...base, pricedCount })).toEqual({
        kind: "range",
        sampleSize: pricedCount,
        min: 30_000,
        max: 150_000,
      });
    }
  });

  it("publie la médiane dès 10 ventes chiffrées", () => {
    expect(tribunalPriceFigure({ ...base, pricedCount: 10 })).toEqual({
      kind: "median",
      sampleSize: 10,
      median: 80_000,
    });
  });

  it("ne tire pas de chiffre d'une valeur absente", () => {
    expect(
      tribunalPriceFigure({ ...base, pricedCount: 12, medianStartingPriceEur: null }).kind,
    ).toBe("none");
    expect(tribunalPriceFigure({ ...base, pricedCount: 7, minStartingPriceEur: null }).kind).toBe(
      "none",
    );
  });

  it("ne publie rien quand la base ne dit pas combien de ventes sont chiffrées", () => {
    // Le nombre de ventes à venir ne tient pas lieu de « n » : ni médiane ni fourchette, seulement « — ».
    for (const upcomingCount of [3, 30, 400]) {
      expect(tribunalPriceFigure({ ...base, upcomingCount })).toEqual({
        kind: "none",
        sampleSize: 0,
      });
    }
    expect(tribunalPriceFigure({ ...base, pricedCount: null })).toEqual({
      kind: "none",
      sampleSize: 0,
    });
  });

  it("remplace la médiane sans minimum de l'activité par les chiffres soumis aux seuils", () => {
    const row = {
      tribunal_code: "pau",
      tribunal_name: "TJ Pau",
      tribunal_city: "Pau",
      department: "64",
      upcoming_count: 7,
      next_sale_date: null,
      median_starting_price_eur: "59000",
      house_count: 4,
      apartment_count: 3,
      other_count: 0,
    };
    const [withFigures] = mapPublicTribunalActivity(
      [row],
      [
        {
          tribunal_code: "pau",
          priced_count: 6,
          min_starting_price_eur: "20000",
          max_starting_price_eur: "90000",
          median_starting_price_eur: null,
        },
      ],
    );
    expect(tribunalPriceFigure(withFigures)).toEqual({
      kind: "range",
      sampleSize: 6,
      min: 20_000,
      max: 90_000,
    });
    // Un tribunal absent des chiffres de prix n'a aucune vente chiffrée.
    const [without] = mapPublicTribunalActivity([row], []);
    expect(tribunalPriceFigure(without)).toEqual({ kind: "none", sampleSize: 0 });
    // Sans lecture des chiffres (fonction pas encore déployée) : l'activité seule, comme avant.
    const [legacy] = mapPublicTribunalActivity([row]);
    expect(legacy.pricedCount).toBeUndefined();
  });

  it("écrit le nombre de ventes chiffrées", () => {
    expect(tribunalSampleLabel(1)).toBe("1 vente chiffrée");
    expect(tribunalSampleLabel(3)).toBe("3 ventes chiffrées");
  });
});
