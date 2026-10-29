// Règles pepite-v1.2 et pepite-v2.1 (validées le 29/10/2026) : coût de rénovation énergétique dans le test C, marché
// local, taille et valeur, copropriété en difficulté, table de capacités par version. Les versions v1, v1.1 et v2
// restent rejouables à l'identique : leurs tests (`pepite-policy.test.ts`, `pepite-policy.characterization.test.ts`)
// ne changent pas, et ce fichier vérifie en plus qu'elles ignorent toutes les entrées de la v1.2.
import { describe, expect, it } from "vitest";
import type { AuctionScenario } from "@/lib/auction-scenarios";
import {
  PEPITE_BLOCKING_CRITERIA,
  PEPITE_CRITERIA,
  PEPITE_DPE_MIN_CONFIDENCE,
  PEPITE_ENERGY_RENOVATION_EUR_PER_M2,
  PEPITE_LATEST_RULE_VERSION,
  PEPITE_MARKET_MAX_DECLINE_SHARE,
  PEPITE_MARKET_MIN_SALES_12_MONTHS,
  PEPITE_MARKET_TREND_MIN_SALES_PER_YEAR,
  PEPITE_MAX_CENTRAL_VALUE_EUR,
  PEPITE_MAX_HABITABLE_SURFACE_M2,
  PEPITE_RULE_CAPABILITIES,
  PEPITE_V1_1_RULE_VERSION,
  PEPITE_V1_2_RULE_VERSION,
  PEPITE_V1_RULE_VERSION,
  PEPITE_V2_1_RULE_VERSION,
  PEPITE_V2_RULE_VERSION,
  applyPepiteStability,
  energyRenovationCostEur,
  evaluateLocalMarket,
  evaluatePepite,
  pepiteReasonCodes,
  pepiteRuleCapabilities,
  readsPepiteV12Data,
  type PepiteInput,
  type PepiteMarketAggregate,
  type PepiteRuleVersion,
} from "./pepite-policy";

const BUCKETS: AuctionScenario[] = [
  { key: "near_start", lowRatio: 0, highRatio: 1.1, probability: 0.2 },
  { key: "up_to_1_5", lowRatio: 1.1, highRatio: 1.5, probability: 0.3 },
  { key: "up_to_2", lowRatio: 1.5, highRatio: 2, probability: 0.25 },
  { key: "up_to_3", lowRatio: 2, highRatio: 3, probability: 0.15 },
  { key: "above_3", lowRatio: 3, highRatio: null, probability: 0.1 },
];

const START = 100_000;
const CENTRAL = 300_000;

/**
 * Tribunal favorable : B (part 0,75) et C (prix probable 150 000, coût 172 500, ratio 0,575). Marge avant le seuil
 * d'entrée de 75 % : 52 500 EUR de coût en plus ; avant le seuil de maintien de 80 % : 67 500 EUR.
 */
function court(overrides: Partial<PepiteInput> = {}): PepiteInput {
  return {
    regime: "tribunal",
    upcoming: true,
    startingPriceEur: START,
    estimate: {
      actionable: true,
      reliability: "correcte",
      effectiveSampleSize: 12,
      surfaceEstimated: false,
      publicGatePassed: true,
      centralValueEur: CENTRAL,
      lowValueEur: 250_000,
    },
    ceiling: { available: true, referenceEur: 200_000, totalCostAt: (price) => price * 1.15 },
    scenarios: {
      reliability: "good",
      buckets: BUCKETS,
      q25: 1.2,
      q50: 1.5,
      q75: 2,
      courtSample: 40,
      nationalSample: 900,
    },
    signals: {
      landOrMixed: false,
      occupancy: "libre",
      degradedCondition: false,
      valuationConflict: false,
      aiBlocked: false,
      verificationConflict: false,
      probableDuplicate: false,
      unqualifiedRisks: false,
    },
    flood: { verdict: "none_found", ppriChecked: true },
    ...overrides,
  };
}

const AGGREGATE: PepiteMarketAggregate = {
  referenceYear: 2025,
  sales12Months: 80,
  medianRecentEurM2: 3_000,
  medianBaselineEurM2: 3_200,
  salesRecentYear: 75,
  salesBaselineYear: 70,
};

/** Une vente favorable sous la règle v1.2, avec les entrées de cette version. */
function v12(overrides: Partial<PepiteInput> = {}): PepiteInput {
  return court({
    habitableSurfaceM2: 80,
    energy: { dpeClass: "D", dpeSource: "ademe" },
    market: { propertyType: "Appartement", aggregate: AGGREGATE },
    ...overrides,
  });
}

const evaluate = (input: PepiteInput, version: PepiteRuleVersion = PEPITE_V1_2_RULE_VERSION) =>
  evaluatePepite(input, version);

describe("versions et table de capacités", () => {
  it("nomme les cinq versions et fait de pepite-v2.1 la version courante", () => {
    expect(PEPITE_V1_RULE_VERSION).toBe("pepite-v1");
    expect(PEPITE_V1_1_RULE_VERSION).toBe("pepite-v1.1");
    expect(PEPITE_V2_RULE_VERSION).toBe("pepite-v2");
    expect(PEPITE_V1_2_RULE_VERSION).toBe("pepite-v1.2");
    expect(PEPITE_V2_1_RULE_VERSION).toBe("pepite-v2.1");
    expect(PEPITE_LATEST_RULE_VERSION).toBe(PEPITE_V2_1_RULE_VERSION);
    expect(Object.keys(PEPITE_RULE_CAPABILITIES).sort()).toEqual([
      "pepite-v1",
      "pepite-v1.1",
      "pepite-v1.2",
      "pepite-v2",
      "pepite-v2.1",
    ]);
  });

  it("donne à chaque version exactement ses capacités", () => {
    const none = {
      energyCost: false,
      localMarket: false,
      sizeValueCap: false,
      coproDistress: false,
    };
    const all = { energyCost: true, localMarket: true, sizeValueCap: true, coproDistress: true };
    expect(pepiteRuleCapabilities("pepite-v1")).toEqual({
      corrected: false,
      flood: false,
      ...none,
    });
    expect(pepiteRuleCapabilities("pepite-v1.1")).toEqual({
      corrected: true,
      flood: false,
      ...none,
    });
    expect(pepiteRuleCapabilities("pepite-v2")).toEqual({ corrected: true, flood: true, ...none });
    expect(pepiteRuleCapabilities("pepite-v1.2")).toEqual({
      corrected: true,
      flood: false,
      ...all,
    });
    expect(pepiteRuleCapabilities("pepite-v2.1")).toEqual({ corrected: true, flood: true, ...all });
    expect(readsPepiteV12Data("pepite-v1")).toBe(false);
    expect(readsPepiteV12Data("pepite-v1.1")).toBe(false);
    expect(readsPepiteV12Data("pepite-v2")).toBe(false);
    expect(readsPepiteV12Data("pepite-v1.2")).toBe(true);
    expect(readsPepiteV12Data("pepite-v2.1")).toBe(true);
  });

  it("reprend les seuils validés le 29/10/2026", () => {
    expect(PEPITE_ENERGY_RENOVATION_EUR_PER_M2).toEqual({ F: 250, G: 400 });
    expect(PEPITE_DPE_MIN_CONFIDENCE).toBe(0.8);
    expect(PEPITE_MARKET_MIN_SALES_12_MONTHS).toBe(20);
    expect(PEPITE_MARKET_MAX_DECLINE_SHARE).toBe(0.15);
    expect(PEPITE_MARKET_TREND_MIN_SALES_PER_YEAR).toBe(10);
    expect(PEPITE_MAX_HABITABLE_SURFACE_M2).toBe(250);
    expect(PEPITE_MAX_CENTRAL_VALUE_EUR).toBe(1_500_000);
  });

  it("classe no_copro_distress parmi les critères bloquants, et pas les critères de marché ni de taille", () => {
    expect(PEPITE_BLOCKING_CRITERIA).toContain("no_copro_distress");
    for (const id of ["market_liquid", "market_not_declining", "size_value_supported"] as const) {
      expect(PEPITE_BLOCKING_CRITERIA).not.toContain(id);
      expect(PEPITE_CRITERIA).toContain(id);
    }
  });
});

describe("pepite-v1.2 : une vente favorable", () => {
  it("est retenue, avec tous les nouveaux critères réussis et les mesures du DPE et du marché", () => {
    const evaluation = evaluate(v12());
    expect(evaluation.status).toBe("pepite");
    expect(evaluation.ruleVersion).toBe("pepite-v1.2");
    expect(evaluation.passed).toEqual(
      expect.arrayContaining([
        "size_value_supported",
        "market_liquid",
        "market_not_declining",
        "no_copro_distress",
      ]),
    );
    expect(evaluation.missed).toEqual([]);
    expect(evaluation.metrics).toMatchObject({
      dpeClass: "D",
      dpeSource: "ademe",
      energyRenovationEur: 0,
      habitableSurfaceM2: 80,
      totalCostEur: 172_500,
      costRatio: 0.575,
      market: {
        propertyType: "Appartement",
        aggregateAbsent: false,
        sales12Months: 80,
        trendEvaluated: true,
        declinePct: 6.25,
      },
    });
  });

  it("garde le test C inchangé : 75 % au tribunal, 65 % en vente notariale, maintien à 80 % et 70 %", () => {
    // 172 500 / 300 000 = 0,575 ; on monte le coût sans DPE pour retrouver les seuils.
    const at = (ratio: number, regime: "tribunal" | "notary_auction" = "tribunal") =>
      evaluate(
        v12({
          regime,
          scenarios: regime === "tribunal" ? court().scenarios : null,
          ceiling: {
            available: true,
            referenceEur: 200_000,
            totalCostAt: (price) =>
              (CENTRAL * ratio * price) / (regime === "tribunal" ? 150_000 : START),
          },
        }),
      );
    expect(at(0.75).passed).toContain("test_c_cost");
    expect(at(0.76).missed).toContain("test_c_cost");
    expect(at(0.8).holds).toBe(true);
    expect(at(0.81).holds).toBe(false);
    expect(at(0.65, "notary_auction").passed).toContain("test_c_cost");
    expect(at(0.66, "notary_auction").missed).toContain("test_c_cost");
    expect(at(0.7, "notary_auction").holds).toBe(true);
    expect(at(0.71, "notary_auction").holds).toBe(false);
  });
});

describe("pepite-v1.2 : coût de rénovation énergétique dans le test C", () => {
  it("ajoute 250 EUR/m2 pour un DPE F, au coût total et au rapport du test C", () => {
    const evaluation = evaluate(
      v12({ habitableSurfaceM2: 100, energy: { dpeClass: "F", dpeSource: "ademe" } }),
    );
    expect(evaluation.metrics.energyRenovationEur).toBe(25_000);
    expect(evaluation.metrics.totalCostEur).toBe(172_500 + 25_000);
    expect(evaluation.metrics.costRatio).toBeCloseTo(197_500 / CENTRAL, 10);
    expect(evaluation.status).toBe("pepite");
  });

  it("ajoute 400 EUR/m2 pour un DPE G et fait échouer le test C quand le coût passe le seuil", () => {
    // 80 m2 x 400 = 32 000 : 204 500 / 300 000 = 0,682, encore sous 75 %.
    const ok = evaluate(
      v12({ habitableSurfaceM2: 80, energy: { dpeClass: "G", dpeSource: "listing" } }),
    );
    expect(ok.metrics.energyRenovationEur).toBe(32_000);
    expect(ok.metrics.dpeSource).toBe("listing");
    expect(ok.passed).toContain("test_c_cost");
    // 200 m2 x 400 = 80 000 : 252 500 / 300 000 = 0,842, au-dessus des seuils d'entrée et de maintien.
    const ko = evaluate(
      v12({ habitableSurfaceM2: 200, energy: { dpeClass: "G", dpeSource: "ademe" } }),
    );
    expect(ko.metrics.energyRenovationEur).toBe(80_000);
    expect(ko.metrics.costRatio).toBeCloseTo(252_500 / CENTRAL, 10);
    expect(ko.missed).toContain("test_c_cost");
    expect(ko.holdMissed).toContain("test_c_cost");
    expect(ko.status).toBe("not_pepite");
    expect(ko.holds).toBe(false);
  });

  it("applique le coût aussi au seuil de maintien : un DPE F peut sortir du seuil d'entrée sans sortir du maintien", () => {
    // 220 m2 x 250 = 55 000 : 227 500 / 300 000 = 0,758 : manqué à l'entrée (75 %), tenu au maintien (80 %).
    const evaluation = evaluate(
      v12({ habitableSurfaceM2: 220, energy: { dpeClass: "F", dpeSource: "ademe" } }),
    );
    expect(evaluation.missed).toContain("test_c_cost");
    expect(evaluation.holdMissed).not.toContain("test_c_cost");
    expect(evaluation.holds).toBe(true);
  });

  it("ajoute 0 pour les classes A à E", () => {
    for (const dpeClass of ["A", "B", "C", "D", "E"] as const) {
      const evaluation = evaluate(v12({ energy: { dpeClass, dpeSource: "ademe" } }));
      expect(evaluation.metrics.energyRenovationEur, dpeClass).toBe(0);
      expect(evaluation.metrics.totalCostEur, dpeClass).toBe(172_500);
    }
  });

  it("n'ajoute rien quand le DPE est inconnu, et le signale (dpeClass nul)", () => {
    const evaluation = evaluate(v12({ energy: { dpeClass: null, dpeSource: null } }));
    expect(evaluation.metrics.dpeClass).toBeNull();
    expect(evaluation.metrics.dpeSource).toBeNull();
    expect(evaluation.metrics.energyRenovationEur).toBeNull();
    expect(evaluation.metrics.totalCostEur).toBe(172_500);
    expect(evaluation.status).toBe("pepite");
    // Entrée absente : même résultat.
    const absent = evaluate(v12({ energy: undefined }));
    expect(absent.metrics.dpeClass).toBeNull();
    expect(absent.metrics.totalCostEur).toBe(172_500);
  });

  it("n'ajoute rien à un DPE F ou G dont la surface habitable est inconnue (coût incalculable, signalé par null)", () => {
    const evaluation = evaluate(
      v12({ habitableSurfaceM2: null, energy: { dpeClass: "G", dpeSource: "ademe" } }),
    );
    expect(evaluation.metrics.dpeClass).toBe("G");
    expect(evaluation.metrics.energyRenovationEur).toBeNull();
    expect(evaluation.metrics.totalCostEur).toBe(172_500);
  });

  it("calcule le coût par une fonction pure arrondie à l'euro", () => {
    expect(energyRenovationCostEur("F", 63.5)).toBe(15_875);
    expect(energyRenovationCostEur("G", 63.5)).toBe(25_400);
    expect(energyRenovationCostEur("E", 63.5)).toBe(0);
    expect(energyRenovationCostEur(null, 63.5)).toBeNull();
    expect(energyRenovationCostEur("F", null)).toBeNull();
    expect(energyRenovationCostEur("F", 0)).toBeNull();
  });
});

describe("pepite-v1.2 : marché local", () => {
  const withAggregate = (changes: Partial<PepiteMarketAggregate>) =>
    v12({ market: { propertyType: "Maison", aggregate: { ...AGGREGATE, ...changes } } });

  it("réussit les deux critères quand l'agrégat est absent, et le note dans les détails", () => {
    for (const market of [
      { propertyType: "Maison" as const, aggregate: null },
      { propertyType: null, aggregate: null },
    ]) {
      const evaluation = evaluate(v12({ market }));
      expect(evaluation.passed).toEqual(
        expect.arrayContaining(["market_liquid", "market_not_declining"]),
      );
      expect(evaluation.status).toBe("pepite");
      expect(evaluation.metrics.market).toMatchObject({
        aggregateAbsent: true,
        trendEvaluated: false,
        declinePct: null,
        sales12Months: null,
      });
    }
    // Entrée absente : pareil.
    const absent = evaluate(v12({ market: undefined }));
    expect(absent.passed).toEqual(
      expect.arrayContaining(["market_liquid", "market_not_declining"]),
    );
    expect(absent.metrics.market?.aggregateAbsent).toBe(true);
  });

  it("market_liquid : au moins 20 ventes sur 12 mois ; moins de 20 ventes avec un agrégat présent échoue", () => {
    expect(evaluate(withAggregate({ sales12Months: 20 })).passed).toContain("market_liquid");
    const thin = evaluate(withAggregate({ sales12Months: 19 }));
    expect(thin.missed).toEqual(["market_liquid"]);
    expect(thin.status).toBe("not_pepite");
    expect(thin.favorable).toBe(false);
    expect(thin.blocking).toBe(false);
    // Un agrégat à zéro vente existe : c'est une donnée, pas une absence.
    const empty = evaluate(
      withAggregate({ sales12Months: 0, salesRecentYear: 0, salesBaselineYear: 0 }),
    );
    expect(empty.missed).toContain("market_liquid");
    expect(empty.metrics.market?.aggregateAbsent).toBe(false);
  });

  it("market_not_declining : échoue au-delà de 15 % de baisse, réussit à 15 % pile et en hausse", () => {
    const decline = (pct: number) =>
      evaluate(
        withAggregate({
          medianBaselineEurM2: 4_000,
          medianRecentEurM2: Math.round(4_000 * (1 - pct / 100)),
        }),
      );
    const exactly = decline(15);
    expect(exactly.passed).toContain("market_not_declining");
    expect(exactly.metrics.market?.declinePct).toBe(15);
    const worse = decline(15.5);
    expect(worse.missed).toEqual(["market_not_declining"]);
    expect(worse.metrics.market).toMatchObject({ trendEvaluated: true, declinePct: 15.5 });
    expect(worse.status).toBe("not_pepite");
    const rising = evaluate(
      withAggregate({ medianBaselineEurM2: 3_000, medianRecentEurM2: 3_300 }),
    );
    expect(rising.passed).toContain("market_not_declining");
    expect(rising.metrics.market?.declinePct).toBe(-10);
  });

  it("market_not_declining : évalué seulement si chacune des deux années a 10 ventes, sinon réussi et noté", () => {
    const falling = { medianBaselineEurM2: 4_000, medianRecentEurM2: 2_000 };
    for (const sparse of [
      { salesRecentYear: 9 },
      { salesBaselineYear: 9 },
      { salesRecentYear: 0 },
    ]) {
      const evaluation = evaluate(withAggregate({ ...falling, ...sparse }));
      expect(evaluation.passed, JSON.stringify(sparse)).toContain("market_not_declining");
      expect(evaluation.metrics.market).toMatchObject({ trendEvaluated: false, declinePct: null });
    }
    expect(
      evaluate(withAggregate({ ...falling, salesRecentYear: 10, salesBaselineYear: 10 })).missed,
    ).toContain("market_not_declining");
    // Une médiane manquante empêche aussi l'évaluation.
    const noMedian = evaluate(withAggregate({ medianBaselineEurM2: null }));
    expect(noMedian.passed).toContain("market_not_declining");
    expect(noMedian.metrics.market?.trendEvaluated).toBe(false);
  });

  it("n'est pas bloquant : une pépite publiée gelée à J-7 le reste, mais sort à un recalcul normal", () => {
    const evaluation = evaluate(withAggregate({ sales12Months: 5 }));
    expect(evaluation.blocking).toBe(false);
    expect(evaluation.holds).toBe(false);
    expect(evaluation.holdMissed).toContain("market_liquid");
    const published = {
      isPepite: true,
      favorableStreak: 2,
      frozenAt: null,
      lastFavorableAt: "2026-11-01T00:00:00.000Z",
      dataMissingSince: null,
      inputStartingPriceEur: START,
      ruleVersion: "pepite-v1.2",
    };
    const stability = (saleDate: string) =>
      applyPepiteStability({
        previous: published,
        evaluation,
        startingPriceEur: START,
        saleDate,
        now: new Date("2026-11-10T00:00:00.000Z"),
      });
    expect(stability("2026-11-13T00:00:00.000Z")).toMatchObject({
      isPepite: true,
      codes: ["stab:frozen"],
    });
    expect(stability("2026-12-20T00:00:00.000Z")).toMatchObject({
      isPepite: false,
      codes: ["stab:exit"],
    });
  });

  it("l'évaluation pure ne dépend que de l'agrégat", () => {
    expect(evaluateLocalMarket(undefined)).toMatchObject({ liquid: true, notDeclining: true });
    expect(evaluateLocalMarket({ propertyType: "Maison", aggregate: AGGREGATE })).toMatchObject({
      liquid: true,
      notDeclining: true,
    });
  });
});

describe("pepite-v1.2 : taille et valeur", () => {
  it("écarte un bien de plus de 250 m2 habitables, pas un bien de 250 m2", () => {
    expect(evaluate(v12({ habitableSurfaceM2: 250 })).passed).toContain("size_value_supported");
    const big = evaluate(v12({ habitableSurfaceM2: 250.5 }));
    expect(big.missed).toEqual(["size_value_supported"]);
    expect(big.status).toBe("not_pepite");
    expect(big.blocking).toBe(false);
  });

  it("écarte une valeur centrale (P50) de plus de 1 500 000 EUR, pas de 1 500 000 EUR", () => {
    const priced = (central: number) =>
      v12({
        startingPriceEur: 500_000,
        estimate: { ...court().estimate!, centralValueEur: central, lowValueEur: central * 0.8 },
        ceiling: {
          available: true,
          referenceEur: central * 0.7,
          totalCostAt: (price) => price * 1.1,
        },
        scenarios: { ...court().scenarios!, q50: 1.1, q25: 1, q75: 1.5 },
      });
    expect(evaluate(priced(1_500_000)).passed).toContain("size_value_supported");
    const rich = evaluate(priced(1_500_001));
    expect(rich.missed).toContain("size_value_supported");
    expect(rich.status).toBe("not_pepite");
  });

  it("ne dit rien d'une surface inconnue (c'est surface_known qui s'en charge)", () => {
    const evaluation = evaluate(v12({ habitableSurfaceM2: null }));
    expect(evaluation.passed).toContain("size_value_supported");
  });
});

describe("pepite-v1.2 : copropriété en difficulté", () => {
  const distress = () => v12({ signals: { ...court().signals, coproDistress: true } });

  it("est bloquante : pas une pépite, sortie immédiate, même gelée à J-7", () => {
    const evaluation = evaluate(distress());
    expect(evaluation.missed).toEqual(["no_copro_distress"]);
    expect(evaluation.blocking).toBe(true);
    expect(evaluation.favorable).toBe(false);
    expect(evaluation.status).toBe("not_pepite");
    const stability = applyPepiteStability({
      previous: {
        isPepite: true,
        favorableStreak: 2,
        frozenAt: "2026-11-09T00:00:00.000Z",
        lastFavorableAt: "2026-11-01T00:00:00.000Z",
        dataMissingSince: null,
        inputStartingPriceEur: START,
        ruleVersion: "pepite-v1.2",
      },
      evaluation,
      startingPriceEur: START,
      saleDate: "2026-11-13T00:00:00.000Z",
      now: new Date("2026-11-10T00:00:00.000Z"),
    });
    expect(stability).toMatchObject({ isPepite: false, codes: ["stab:exit_blocking"] });
  });

  it("un signal absent ou faux ne change rien", () => {
    expect(evaluate(v12()).passed).toContain("no_copro_distress");
    expect(evaluate(v12({ signals: { ...court().signals, coproDistress: false } })).missed).toEqual(
      [],
    );
  });

  it("donne le code de motif fail:no_copro_distress", () => {
    expect(pepiteReasonCodes(evaluate(distress()))).toContain("fail:no_copro_distress");
  });
});

describe("pepite-v2.1 : v1.2 plus l'inondation de pepite-v2", () => {
  it("applique les critères de la v1.2 et ceux de l'inondation", () => {
    const ok = evaluate(v12(), PEPITE_V2_1_RULE_VERSION);
    expect(ok.status).toBe("pepite");
    expect(ok.passed).toEqual(
      expect.arrayContaining([
        "flood_risk_known",
        "no_high_flood_risk",
        "size_value_supported",
        "market_liquid",
      ]),
    );
    const high = evaluate(
      v12({ flood: { verdict: "high", ppriChecked: true } }),
      PEPITE_V2_1_RULE_VERSION,
    );
    expect(high.blocking).toBe(true);
    expect(high.missed).toContain("no_high_flood_risk");
    const unknown = evaluate(
      v12({ flood: { verdict: "unknown", ppriChecked: true } }),
      PEPITE_V2_1_RULE_VERSION,
    );
    expect(unknown.missed).toEqual(["flood_risk_known"]);
    expect(unknown.holds).toBe(true);
    const copro = evaluate(
      v12({ signals: { ...court().signals, coproDistress: true } }),
      PEPITE_V2_1_RULE_VERSION,
    );
    expect(copro.blocking).toBe(true);
  });

  it("la v1.2 ignore le verdict d'inondation, même le pire", () => {
    const evaluation = evaluate(v12({ flood: { verdict: "high", ppriChecked: false } }));
    expect(evaluation.status).toBe("pepite");
    expect(evaluation.passed).not.toContain("flood_risk_known");
    expect(evaluation.passed).not.toContain("no_high_flood_risk");
  });

  it("v2.1 donne les mêmes mesures de la v1.2 pour un verdict sans conséquence", () => {
    const a = evaluate(v12());
    const b = evaluate(v12(), PEPITE_V2_1_RULE_VERSION);
    expect(b.metrics).toEqual(a.metrics);
    expect(b.favorable).toBe(a.favorable);
    expect(b.holds).toBe(a.holds);
  });
});

describe("rejeu à l'identique de pepite-v1, pepite-v1.1 et pepite-v2", () => {
  // Les entrées de la v1.2 sont ignorées par les versions antérieures : même verdict, mêmes mesures, mêmes motifs,
  // que ces entrées soient présentes (et défavorables) ou absentes.
  const hostile: Partial<PepiteInput> = {
    habitableSurfaceM2: 900,
    energy: { dpeClass: "G", dpeSource: "ademe" },
    market: {
      propertyType: "Maison",
      aggregate: {
        referenceYear: 2025,
        sales12Months: 1,
        medianRecentEurM2: 1_000,
        medianBaselineEurM2: 4_000,
        salesRecentYear: 50,
        salesBaselineYear: 50,
      },
    },
  };
  const hostileSignals = { ...court().signals, coproDistress: true };

  const previousVersions: PepiteRuleVersion[] = [
    PEPITE_V1_RULE_VERSION,
    PEPITE_V1_1_RULE_VERSION,
    PEPITE_V2_RULE_VERSION,
  ];
  const bases: Array<[string, PepiteInput]> = [
    ["tribunal favorable", court()],
    [
      "tribunal, coût au-dessus du maintien",
      court({ ceiling: { available: true, referenceEur: 200_000, totalCostAt: (p) => p * 1.9 } }),
    ],
    [
      "bougie",
      court({
        regime: "notary_auction",
        scenarios: null,
        estimate: { ...court().estimate!, centralValueEur: 200_000, lowValueEur: 180_000 },
        ceiling: { available: true, referenceEur: 120_000, totalCostAt: (p) => p * 1.2 },
      }),
    ],
    ["sans estimation", court({ estimate: null })],
  ];

  for (const version of previousVersions) {
    for (const [name, base] of bases) {
      it(`${version} : « ${name} » ne bouge pas avec ou sans les entrées de la v1.2`, () => {
        const plain = evaluate(base, version);
        const withV12 = evaluate({ ...base, ...hostile, signals: hostileSignals }, version);
        expect(withV12).toEqual(plain);
        // Aucune mesure ni aucun critère de la v1.2 n'apparaît dans une version antérieure.
        for (const key of ["dpeClass", "energyRenovationEur", "market", "habitableSurfaceM2"]) {
          expect(Object.keys(withV12.metrics)).not.toContain(key);
        }
        for (const id of [
          "size_value_supported",
          "market_liquid",
          "market_not_declining",
          "no_copro_distress",
        ] as const) {
          expect([...withV12.passed, ...withV12.missed, ...withV12.holdMissed]).not.toContain(id);
        }
      });
    }
  }

  it("la même vente hostile est écartée par la v1.2 et par la v2.1", () => {
    for (const version of [PEPITE_V1_2_RULE_VERSION, PEPITE_V2_1_RULE_VERSION] as const) {
      const evaluation = evaluate({ ...court(), ...hostile, signals: hostileSignals }, version);
      expect(evaluation.status).toBe("not_pepite");
      expect(evaluation.blocking).toBe(true);
      expect(evaluation.missed).toEqual(
        expect.arrayContaining([
          "size_value_supported",
          "market_liquid",
          "market_not_declining",
          "no_copro_distress",
          "test_c_cost",
        ]),
      );
    }
  });
});

describe("les badges n'entrent pas dans la règle", () => {
  it("evaluatePepite ne lit ni badge ni loyer : une entrée portant un loyer rend le même verdict", () => {
    const input = v12();
    const withRent = {
      ...input,
      badges: ["double_exit"],
      monthlyRentEur: 5_000,
    } as unknown as PepiteInput;
    expect(evaluate(withRent)).toEqual(evaluate(input));
    expect(evaluate(withRent, PEPITE_V2_1_RULE_VERSION)).toEqual(
      evaluate(input, PEPITE_V2_1_RULE_VERSION),
    );
  });
});
