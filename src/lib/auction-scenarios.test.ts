import { describe, expect, it } from "vitest";
import {
  dvfReferenceForType,
  formatEuro,
  mapCourtSummaries,
  mapDvfHistory,
  mapLicitorHistory,
  mapScenarioSet,
  probabilityAtLeast,
} from "./auction-scenarios";

const RAW_SCENARIOS = {
  band: 2,
  court_sample: 165,
  national_sample: 1098,
  price_scope: "court",
  scenarios: [
    { key: "near_start", low_ratio: 0, high_ratio: 1.1, probability: 0.105 },
    { key: "up_to_1_5", low_ratio: 1.1, high_ratio: 1.5, probability: 0.05 },
    { key: "up_to_2", low_ratio: 1.5, high_ratio: 2, probability: 0.088 },
    { key: "up_to_3", low_ratio: 2, high_ratio: 3, probability: 0.239 },
    { key: "above_3", low_ratio: 3, high_ratio: null, probability: 0.518 },
    { key: "unknown", low_ratio: 9, high_ratio: null, probability: 1 },
  ],
  ratio_quartiles: { q25: 2.04, q50: 3.1, q75: 4.625 },
};

describe("auction scenarios mapping", () => {
  it("keeps the five known scenarios and the court's range", () => {
    const set = mapScenarioSet(RAW_SCENARIOS);
    expect(set?.scenarios.map((scenario) => scenario.key)).toEqual([
      "near_start",
      "up_to_1_5",
      "up_to_2",
      "up_to_3",
      "above_3",
    ]);
    expect(set).toMatchObject({ band: 2, courtSample: 165, priceScope: "court" });
    expect(set?.ratioQuartiles.q50).toBe(3.1);
    expect(probabilityAtLeast(set!.scenarios, 2)).toBeCloseTo(0.757, 3);
  });

  it("returns nothing without scenarios", () => {
    expect(mapScenarioSet(null)).toBeNull();
    expect(mapScenarioSet({ scenarios: [] })).toBeNull();
  });

  it("reads the court history and the official DVF prices", () => {
    const licitor = mapLicitorHistory({
      sample: 480,
      mean_starting_price: 101234,
      mean_hammer_price: 250500,
      at_least_double_rate: 0.5,
      by_year: [
        { year: 2024, sales: 160 },
        { year: 2025, sales: 170 },
      ],
    });
    expect(licitor).toMatchObject({ sample: 480, meanHammerPrice: 250500 });
    expect(licitor?.byYear).toHaveLength(2);
    expect(mapLicitorHistory({ sample: 0 })).toBeNull();

    const dvf = mapDvfHistory({
      sample: 350,
      by_type: [
        { property_type: "apartment", sample: 240, median_price_per_m2: 2160, surface_sample: 230 },
        { property_type: "house", sample: 60, median_price_per_m2: 2400, surface_sample: 4 },
      ],
    });
    expect(dvfReferenceForType(dvf, "apartment")?.medianPricePerM2).toBe(2160);
    expect(dvfReferenceForType(dvf, "house")).toBeNull();
    expect(dvfReferenceForType(dvf, "building")).toBeNull();
  });

  it("lists the courts of the comparison table", () => {
    const courts = mapCourtSummaries([
      {
        court_code: "justice_tj_1_210",
        court_name: "TJ Bobigny",
        licitor: { sample: 442, mean_starting_price: 60000 },
        dvf: null,
      },
      { court_name: "sans code" },
    ]);
    expect(courts).toEqual([
      expect.objectContaining({
        courtCode: "justice_tj_1_210",
        courtName: "TJ Bobigny",
        dvf: null,
      }),
    ]);
  });

  it("rounds amounts to the thousand euros", () => {
    expect(formatEuro(91_870).replace(/\s/g, " ")).toBe("92 000 €");
    expect(formatEuro(null)).toBe("—");
  });
});
