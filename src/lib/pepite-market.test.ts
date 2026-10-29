import { describe, expect, it } from "vitest";
import {
  dvfInseeCode,
  marketPropertyType,
  marketTrendKey,
  parseMarketTrendRow,
} from "./pepite-market";

describe("type de logement du marché local", () => {
  it("fait correspondre house à Maison et apartment à Appartement", () => {
    expect(marketPropertyType("house")).toBe("Maison");
    expect(marketPropertyType(" Apartment ")).toBe("Appartement");
    expect(marketPropertyType("maison")).toBe("Maison");
    expect(marketPropertyType("appartement")).toBe("Appartement");
  });

  it("n'a pas d'agrégat pour un autre type", () => {
    for (const type of [
      "land",
      "building",
      "commercial",
      "mixed",
      "other",
      "unknown",
      "",
      null,
      undefined,
    ]) {
      expect(marketPropertyType(type), String(type)).toBeNull();
    }
  });
});

describe("code commune de DVF", () => {
  it("préfère l'arrondissement à la commune de Paris, Lyon et Marseille", () => {
    expect(dvfInseeCode({ communeInsee: "75056", arrondissementInsee: "75111" })).toBe("75111");
    expect(dvfInseeCode({ communeInsee: "13055", arrondissementInsee: "13208" })).toBe("13208");
    expect(dvfInseeCode({ communeInsee: "33063", arrondissementInsee: null })).toBe("33063");
    expect(dvfInseeCode({ communeInsee: "75056", arrondissementInsee: null })).toBe("75056");
    expect(dvfInseeCode(null)).toBeNull();
    expect(dvfInseeCode(undefined)).toBeNull();
  });
});

describe("ligne de l'agrégat de marché", () => {
  const raw = {
    insee_code: "33063",
    property_type: "Appartement",
    reference_year: 2025,
    sales_12_months: 412,
    median_recent_eur_m2: "4120.5",
    median_baseline_eur_m2: 3600,
    sales_recent_year: 398,
    sales_baseline_year: 371,
  };

  it("lit une ligne complète, médianes numériques ou textuelles", () => {
    expect(parseMarketTrendRow(raw)).toEqual({
      key: marketTrendKey("33063", "Appartement"),
      aggregate: {
        referenceYear: 2025,
        sales12Months: 412,
        medianRecentEurM2: 4120.5,
        medianBaselineEurM2: 3600,
        salesRecentYear: 398,
        salesBaselineYear: 371,
      },
    });
  });

  it("garde une médiane absente à null (jamais inventée)", () => {
    expect(
      parseMarketTrendRow({ ...raw, median_baseline_eur_m2: null, sales_baseline_year: 0 })
        ?.aggregate,
    ).toMatchObject({ medianBaselineEurM2: null, salesBaselineYear: 0 });
  });

  it("écarte une ligne inexploitable", () => {
    for (const bad of [
      null,
      undefined,
      {},
      { ...raw, insee_code: 33063 },
      { ...raw, property_type: "Terrain" },
      { ...raw, reference_year: null },
      { ...raw, sales_12_months: -1 },
      { ...raw, sales_recent_year: "x" },
    ]) {
      expect(parseMarketTrendRow(bad as never), JSON.stringify(bad)).toBeNull();
    }
  });
});
