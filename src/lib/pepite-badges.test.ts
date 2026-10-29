import { describe, expect, it } from "vitest";
import {
  PEPITE_BADGE_DOUBLE_EXIT,
  PEPITE_DOUBLE_EXIT_MIN_GROSS_YIELD,
  computePepiteBadges,
  estimatedMonthlyRentEur,
} from "./pepite-badges";

const anil = { source: "anil_commune", reliability: "reliable" } as const;

describe("badge « double sortie »", () => {
  it("prend le rendement brut minimal de 8 % du coût total", () => {
    expect(PEPITE_DOUBLE_EXIT_MIN_GROSS_YIELD).toBe(0.08);
  });

  it("est donné à partir de 8 % de rendement brut du coût total, loyer de l'ANIL", () => {
    // 800 x 12 = 9 600 ; 9 600 / 120 000 = 8 % pile.
    const [badge] = computePepiteBadges({
      monthlyRentEur: 800,
      rent: anil,
      totalCostEur: 120_000,
    });
    expect(badge).toEqual({
      key: PEPITE_BADGE_DOUBLE_EXIT,
      label: "Double sortie",
      grossYieldPct: 8,
      monthlyRentEur: 800,
      totalCostEur: 120_000,
      rentSource: "anil_commune",
      rentReliability: "reliable",
    });
  });

  it("n'est pas donné sous 8 %", () => {
    expect(computePepiteBadges({ monthlyRentEur: 800, rent: anil, totalCostEur: 120_001 })).toEqual(
      [],
    );
    expect(computePepiteBadges({ monthlyRentEur: 500, rent: anil, totalCostEur: 200_000 })).toEqual(
      [],
    );
  });

  it("accepte toutes les sources de la carte ANIL, indicatives comprises, et note leur fiabilité", () => {
    for (const source of [
      "anil_maille",
      "anil_epci",
      "anil_arrondissements_median",
      "anil_department_median",
    ] as const) {
      const [badge] = computePepiteBadges({
        monthlyRentEur: 1_000,
        rent: { source, reliability: "indicative" },
        totalCostEur: 100_000,
      });
      expect(badge.rentSource).toBe(source);
      expect(badge.rentReliability).toBe("indicative");
    }
  });

  it("n'est jamais donné avec le repli départemental ni sans référence", () => {
    expect(
      computePepiteBadges({
        monthlyRentEur: 2_000,
        rent: { source: "department_estimate", reliability: "indicative" },
        totalCostEur: 100_000,
      }),
    ).toEqual([]);
    expect(
      computePepiteBadges({ monthlyRentEur: 2_000, rent: null, totalCostEur: 100_000 }),
    ).toEqual([]);
  });

  it("n'est pas donné sans loyer ni coût total exploitables", () => {
    for (const [monthlyRentEur, totalCostEur] of [
      [null, 100_000],
      [0, 100_000],
      [1_000, null],
      [1_000, 0],
      [1_000, -5],
    ] as const) {
      expect(
        computePepiteBadges({ monthlyRentEur, rent: anil, totalCostEur }),
        `${monthlyRentEur}/${totalCostEur}`,
      ).toEqual([]);
    }
  });

  it("n'a pas de badge « remise en vente » : un seul badge existe", () => {
    const [badge, ...others] = computePepiteBadges({
      monthlyRentEur: 2_000,
      rent: anil,
      totalCostEur: 100_000,
    });
    expect(others).toEqual([]);
    expect(badge.key).toBe("double_exit");
  });
});

describe("loyer mensuel estimé", () => {
  it("multiplie la surface habitable par le loyer de référence, arrondi à l'euro", () => {
    expect(estimatedMonthlyRentEur(62, { rentPerM2: 13.4 })).toBe(831);
    expect(estimatedMonthlyRentEur(null, { rentPerM2: 13.4 })).toBeNull();
    expect(estimatedMonthlyRentEur(62, null)).toBeNull();
    expect(estimatedMonthlyRentEur(0, { rentPerM2: 13.4 })).toBeNull();
    expect(estimatedMonthlyRentEur(62, { rentPerM2: 0 })).toBeNull();
  });
});
