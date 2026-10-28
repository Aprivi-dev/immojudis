import { describe, expect, it } from "vitest";
import { GOOD_COURT_SAMPLE, MIN_COURT_SAMPLE, type AuctionScenario } from "@/lib/auction-scenarios";
import {
  PEPITE_BLOCKING_CRITERIA,
  PEPITE_CHANCE_EXIT_SHARE,
  PEPITE_CHANCE_MIN_SHARE,
  PEPITE_COST_EXIT_SHARE_COURT,
  PEPITE_COST_EXIT_SHARE_NOTARY,
  PEPITE_EXTREME_START_RATIO_MAX,
  PEPITE_EXTREME_START_RATIO_MIN,
  PEPITE_COST_MAX_SHARE_COURT,
  PEPITE_COST_MAX_SHARE_NOTARY,
  PEPITE_COURT_COMPLETE_BELOW_SALES,
  PEPITE_COURT_REPLACE_BELOW_SALES,
  PEPITE_CRITERIA,
  PEPITE_DATA_CRITERIA,
  PEPITE_DATA_GRACE_HOURS,
  PEPITE_FAVOURABLE_EVALUATIONS,
  PEPITE_FREEZE_DAYS,
  PEPITE_LOW_STARTING_PRICE_SHARE,
  PEPITE_MIN_HOURS_BETWEEN_EVALUATIONS,
  PEPITE_MIN_VALUE_COMPARABLES,
  PEPITE_LATEST_RULE_VERSION,
  PEPITE_V1_RULE_VERSION,
  applyPepiteStability,
  evaluatePepite as evaluatePepiteVersioned,
  pepiteReasonCodes,
  type PepiteCriterionId,
  type PepiteEvaluation,
  type PepiteInput,
  type PepiteRuleVersion,
  type PepiteStoredState,
} from "./pepite-policy";

/** La version est obligatoire dans la règle : ces tests évaluent la règle courante sauf indication contraire. */
const evaluatePepite = (
  input: PepiteInput,
  ruleVersion: PepiteRuleVersion = PEPITE_LATEST_RULE_VERSION,
) => evaluatePepiteVersioned(input, ruleVersion);

// Les tranches de la base (`app_private.court_auction_scenarios`) : 0-1,1 / 1,1-1,5 / 1,5-2 / 2-3 / 3+.
const BUCKETS: AuctionScenario[] = [
  { key: "near_start", lowRatio: 0, highRatio: 1.1, probability: 0.2 },
  { key: "up_to_1_5", lowRatio: 1.1, highRatio: 1.5, probability: 0.3 },
  { key: "up_to_2", lowRatio: 1.5, highRatio: 2, probability: 0.25 },
  { key: "up_to_3", lowRatio: 2, highRatio: 3, probability: 0.15 },
  { key: "above_3", lowRatio: 3, highRatio: null, probability: 0.1 },
];

const START = 100_000;
const CENTRAL = 300_000;

/** Tribunal favorable : B (part 0,75 sous le plafond de 200 000) et C (ratio 0,575). */
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

/** Vente notariale favorable : prix de départ 100 000, valeur centrale 200 000, coût 1,2 fois le prix. */
function notary(
  regime: "notary_auction" | "notary_online",
  overrides: Partial<PepiteInput> = {},
): PepiteInput {
  const base = court();
  return {
    ...base,
    regime,
    scenarios: null,
    estimate: { ...base.estimate!, centralValueEur: 200_000, lowValueEur: 180_000 },
    ceiling: { available: true, referenceEur: 120_000, totalCostAt: (price) => price * 1.2 },
    ...overrides,
  };
}

function withEstimate(
  input: PepiteInput,
  changes: Partial<NonNullable<PepiteInput["estimate"]>>,
): PepiteInput {
  return { ...input, estimate: { ...input.estimate!, ...changes } };
}

function withSignals(input: PepiteInput, changes: Partial<PepiteInput["signals"]>): PepiteInput {
  return { ...input, signals: { ...input.signals, ...changes } };
}

function missedOf(evaluation: PepiteEvaluation): PepiteCriterionId[] {
  return evaluation.missed;
}

describe("constantes de la règle pepite", () => {
  it("reprennent les seuils du compte-rendu", () => {
    expect(PEPITE_LATEST_RULE_VERSION).toBe("pepite-v2");
    expect(PEPITE_V1_RULE_VERSION).toBe("pepite-v1");
    expect(PEPITE_CHANCE_MIN_SHARE).toBe(0.7);
    expect(PEPITE_CHANCE_EXIT_SHARE).toBe(0.65);
    expect(PEPITE_COST_MAX_SHARE_COURT).toBe(0.75);
    expect(PEPITE_COST_MAX_SHARE_NOTARY).toBe(0.65);
    expect(PEPITE_COST_EXIT_SHARE_COURT).toBe(0.8);
    expect(PEPITE_COST_EXIT_SHARE_NOTARY).toBe(0.7);
    expect(PEPITE_EXTREME_START_RATIO_MIN).toBe(0.1);
    expect(PEPITE_EXTREME_START_RATIO_MAX).toBe(1.5);
    expect(PEPITE_FAVOURABLE_EVALUATIONS).toBe(2);
    expect(PEPITE_FREEZE_DAYS).toBe(7);
    expect(PEPITE_MIN_VALUE_COMPARABLES).toBe(8);
    expect(PEPITE_LOW_STARTING_PRICE_SHARE).toBe(0.3);
  });

  it("on entre à un seuil et on ne sort qu'à un seuil moins exigeant", () => {
    expect(PEPITE_CHANCE_EXIT_SHARE).toBeLessThan(PEPITE_CHANCE_MIN_SHARE);
    expect(PEPITE_COST_EXIT_SHARE_COURT).toBeGreaterThan(PEPITE_COST_MAX_SHARE_COURT);
    expect(PEPITE_COST_EXIT_SHARE_NOTARY).toBeGreaterThan(PEPITE_COST_MAX_SHARE_NOTARY);
    // Même écart d'hystérésis (en points) pour le test C.
    expect(PEPITE_COST_EXIT_SHARE_COURT - PEPITE_COST_MAX_SHARE_COURT).toBeCloseTo(
      PEPITE_COST_EXIT_SHARE_NOTARY - PEPITE_COST_MAX_SHARE_NOTARY,
      10,
    );
    expect(PEPITE_COST_MAX_SHARE_NOTARY).toBeLessThan(PEPITE_COST_MAX_SHARE_COURT);
  });

  it("restent d'accord avec les seuils des scénarios d'adjudication de la base", () => {
    expect(PEPITE_COURT_COMPLETE_BELOW_SALES).toBe(GOOD_COURT_SAMPLE);
    expect(PEPITE_COURT_REPLACE_BELOW_SALES).toBe(MIN_COURT_SAMPLE);
  });

  it("rangent chaque critère de données et chaque signal bloquant dans le catalogue", () => {
    for (const id of [...PEPITE_DATA_CRITERIA, ...PEPITE_BLOCKING_CRITERIA]) {
      expect(PEPITE_CRITERIA).toContain(id);
    }
    expect(new Set(PEPITE_CRITERIA).size).toBe(PEPITE_CRITERIA.length);
  });
});

describe("evaluatePepite : tribunal", () => {
  it("retient une vente qui remplit tous les critères et chiffre le repère", () => {
    const evaluation = evaluatePepite(court());

    expect(evaluation.status).toBe("pepite");
    expect(evaluation.favorable).toBe(true);
    expect(evaluation.holds).toBe(true);
    expect(evaluation.blocking).toBe(false);
    expect(evaluation.ruleVersion).toBe("pepite-v2");
    expect(evaluatePepite(court(), PEPITE_V1_RULE_VERSION).ruleVersion).toBe("pepite-v1");
    expect(evaluation.missed).toEqual([]);
    expect(evaluation.metrics).toMatchObject({
      startingPriceEur: START,
      centralValueEur: CENTRAL,
      lowValueEur: 250_000,
      referenceCeilingEur: 200_000,
      multiplierKey: "q50",
      multiplier: 1.5,
      probablePriceEur: 150_000,
      rangeLowEur: 120_000,
      rangeHighEur: 200_000,
      chanceAtLeast: false,
      ceilingBelowStart: false,
    });
    expect(evaluation.metrics.chanceShare).toBeCloseTo(0.75, 6);
    expect(evaluation.metrics.costRatio).toBeCloseTo((150_000 * 1.15) / CENTRAL, 6);
  });

  it("donne un code de motif à chaque critère réussi ou manqué", () => {
    const passed = evaluatePepite(court());
    expect(pepiteReasonCodes(passed)).toEqual(expect.arrayContaining(["pass:test_b_chance"]));
    expect(pepiteReasonCodes(passed).every((code) => code.startsWith("pass:"))).toBe(true);
    // Le test B n'a pas lieu d'être pour une vente notariale : pas de motif pour lui.
    expect(pepiteReasonCodes(evaluatePepite(notary("notary_online")))).not.toContain(
      "pass:test_b_chance",
    );

    const missed = evaluatePepite(withEstimate(court(), { reliability: "fragile" }));
    expect(pepiteReasonCodes(missed)).toContain("fail:estimate_reliability");
    expect(pepiteReasonCodes(missed)).toContain("pass:test_b_chance");
    expect(
      pepiteReasonCodes(missed, {
        isPepite: false,
        favorableStreak: 0,
        frozenAt: null,
        lastFavorableAt: null,
        dataMissingSince: null,
        codes: ["stab:exit"],
      }),
    ).toContain("stab:exit");
  });

  it.each<
    [string, Partial<PepiteInput> | ((input: PepiteInput) => PepiteInput), PepiteCriterionId]
  >([
    [
      "estimation non exploitable",
      (input) => withEstimate(input, { actionable: false }),
      "estimate_actionable",
    ],
    [
      "fiabilité fragile",
      (input) => withEstimate(input, { reliability: "fragile" }),
      "estimate_reliability",
    ],
    [
      "fiabilité inconnue",
      (input) => withEstimate(input, { reliability: null }),
      "estimate_reliability",
    ],
    [
      "échantillon de 7",
      (input) => withEstimate(input, { effectiveSampleSize: 7 }),
      "estimate_sample",
    ],
    [
      "échantillon effectif absent",
      (input) => withEstimate(input, { effectiveSampleSize: null }),
      "estimate_sample",
    ],
    [
      "surface estimée",
      (input) => withEstimate(input, { surfaceEstimated: true }),
      "surface_known",
    ],
    [
      "porte publique refusée",
      (input) => withEstimate(input, { publicGatePassed: false }),
      "public_gap_gate",
    ],
    [
      "mise à prix sous 10 % de la valeur",
      (input) => ({ ...input, startingPriceEur: 29_999 }),
      "gap_significant",
    ],
    [
      "mise à prix au-dessus de 150 % de la valeur",
      (input) => ({ ...input, startingPriceEur: 450_001 }),
      "gap_significant",
    ],
    [
      "valeur centrale inconnue",
      (input) => withEstimate(input, { centralValueEur: null }),
      "gap_significant",
    ],
    [
      "terrain seul ou actif mixte",
      (input) => withSignals(input, { landOrMixed: true }),
      "property_type_supported",
    ],
    [
      "occupation inconnue",
      (input) => withSignals(input, { occupancy: "inconnu" }),
      "occupancy_known",
    ],
    ["bien squatté", (input) => withSignals(input, { occupancy: "squat" }), "occupancy_known"],
    [
      "conflit de valorisation",
      (input) => withSignals(input, { valuationConflict: true }),
      "no_valuation_conflict",
    ],
    [
      "champ critique bloqué par la relecture IA",
      (input) => withSignals(input, { aiBlocked: true }),
      "no_ai_block",
    ],
    [
      "état dégradé documenté",
      (input) => withSignals(input, { degradedCondition: true }),
      "no_degraded_condition",
    ],
    [
      "vente en conflit de vérification",
      (input) => withSignals(input, { verificationConflict: true }),
      "verification_not_conflict",
    ],
    [
      "doublon probable",
      (input) => withSignals(input, { probableDuplicate: true }),
      "no_probable_duplicate",
    ],
    [
      "risques non qualifiés",
      (input) => withSignals(input, { unqualifiedRisks: true }),
      "risks_qualified",
    ],
  ])("manque un critère : %s", (_label, change, criterion) => {
    const input = typeof change === "function" ? change(court()) : court(change);
    const evaluation = evaluatePepite(input);

    expect(evaluation.status).not.toBe("pepite");
    expect(evaluation.favorable).toBe(false);
    expect(missedOf(evaluation)).toContain(criterion);
  });

  it("admet un bien libre, occupé ou loué, puisque la libération est dans le plafond", () => {
    for (const occupancy of ["libre", "occupe", "loue"] as const) {
      expect(evaluatePepite(withSignals(court(), { occupancy })).status).toBe("pepite");
    }
  });

  it("admet l'estimation de fiabilité forte comme correcte", () => {
    expect(evaluatePepite(withEstimate(court(), { reliability: "forte" })).status).toBe("pepite");
  });

  it("accepte un échantillon effectif d'exactement 8 et refuse 7,9", () => {
    expect(evaluatePepite(withEstimate(court(), { effectiveSampleSize: 8 })).status).toBe("pepite");
    expect(evaluatePepite(withEstimate(court(), { effectiveSampleSize: 7.9 })).missed).toContain(
      "estimate_sample",
    );
  });

  it("classe les signaux bloquants à part : le statut est « pas une pépite » même si une donnée manque", () => {
    const evaluation = evaluatePepite({
      ...withSignals(court(), { valuationConflict: true }),
      estimate: null,
      ceiling: null,
    });

    expect(evaluation.blocking).toBe(true);
    expect(evaluation.status).toBe("not_pepite");
    expect(evaluation.missed).toEqual(
      expect.arrayContaining(["no_valuation_conflict", "estimate_actionable", "ceiling_computed"]),
    );
  });

  it("l'occupation inconnue ou squattée est un signal bloquant", () => {
    expect(evaluatePepite(withSignals(court(), { occupancy: "squat" })).blocking).toBe(true);
    expect(evaluatePepite(withSignals(court(), { occupancy: "inconnu" })).blocking).toBe(true);
  });

  describe("données insuffisantes", () => {
    it.each<[string, Partial<PepiteInput>, PepiteCriterionId]>([
      ["sans mise à prix", { startingPriceEur: null }, "starting_price_known"],
      ["sans estimation", { estimate: null }, "estimate_actionable"],
      [
        "sans plafond calculable",
        { ceiling: { available: false, referenceEur: null, totalCostAt: () => null } },
        "ceiling_computed",
      ],
      ["sans scénarios d'adjudication", { scenarios: null }, "scenarios_reliable"],
    ])("%s", (_label, change, criterion) => {
      const evaluation = evaluatePepite(court(change));

      expect(evaluation.status).toBe("insufficient");
      expect(evaluation.favorable).toBe(false);
      expect(evaluation.holds).toBe(false);
      expect(evaluation.missed).toContain(criterion);
    });

    it("estimation sans valeur basse ou sans valeur centrale", () => {
      expect(evaluatePepite(withEstimate(court(), { lowValueEur: null })).status).toBe(
        "insufficient",
      );
      expect(evaluatePepite(withEstimate(court(), { centralValueEur: null })).status).toBe(
        "insufficient",
      );
    });

    it("scénarios de fiabilité faible : le test B n'est pas évaluable, pas de pépite", () => {
      const base = court();
      const low = evaluatePepite({
        ...base,
        scenarios: { ...base.scenarios!, reliability: "low" },
      });
      expect(low.status).toBe("insufficient");
      expect(low.missed).toContain("scenarios_reliable");
      expect(low.metrics.chanceShare).toBeNull();
      expect(low.metrics.probablePriceEur).toBeNull();
    });

    it("scénarios de fiabilité moyenne : suffisants", () => {
      const base = court();
      expect(
        evaluatePepite({ ...base, scenarios: { ...base.scenarios!, reliability: "medium" } })
          .status,
      ).toBe("pepite");
    });

    it("scénarios sans quartiles ou sans tranches", () => {
      const base = court();
      expect(evaluatePepite({ ...base, scenarios: { ...base.scenarios!, q50: null } }).status).toBe(
        "insufficient",
      );
      expect(evaluatePepite({ ...base, scenarios: { ...base.scenarios!, q75: null } }).status).toBe(
        "insufficient",
      );
      expect(
        evaluatePepite({ ...base, scenarios: { ...base.scenarios!, buckets: [] } }).status,
      ).toBe("insufficient");
    });
  });

  describe("test B : chances de l'emporter sous le plafond", () => {
    /** Deux tranches : `share` jusqu'à 2 fois la mise à prix, le reste au-delà (part exactement `share`). */
    function splitAt(share: number): PepiteInput {
      const base = court();
      return {
        ...base,
        // Plafond à 2 fois la mise à prix : la première tranche est comptée en entier, rien d'estimé.
        ceiling: { ...base.ceiling!, referenceEur: 2 * START },
        scenarios: {
          ...base.scenarios!,
          buckets: [
            { key: "up_to_2", lowRatio: 0, highRatio: 2, probability: share },
            { key: "above_3", lowRatio: 2, highRatio: null, probability: 1 - share },
          ],
        },
      };
    }

    it("réussit à 70 % exactement", () => {
      const evaluation = evaluatePepite(splitAt(PEPITE_CHANCE_MIN_SHARE));
      expect(evaluation.metrics.chanceShare).toBe(PEPITE_CHANCE_MIN_SHARE);
      expect(evaluation.passed).toContain("test_b_chance");
      expect(evaluation.status).toBe("pepite");
    });

    it("échoue à 69 %", () => {
      const evaluation = evaluatePepite(splitAt(0.69));
      expect(evaluation.missed).toContain("test_b_chance");
      expect(evaluation.status).toBe("not_pepite");
      expect(evaluation.favorable).toBe(false);
    });

    it("tient encore à 65 % exactement et sort sous 65 %", () => {
      const atExit = evaluatePepite(splitAt(PEPITE_CHANCE_EXIT_SHARE));
      expect(atExit.favorable).toBe(false);
      expect(atExit.holds).toBe(true);

      const below = evaluatePepite(splitAt(0.64));
      expect(below.holds).toBe(false);
      expect(below.holdMissed).toContain("test_b_chance");
    });

    it("un plancher (« au moins », au-delà de 3 fois la mise à prix) réussit", () => {
      const base = court();
      const evaluation = evaluatePepite({
        ...base,
        ceiling: { ...base.ceiling!, referenceEur: 4.5 * START },
      });
      expect(evaluation.metrics.chanceAtLeast).toBe(true);
      expect(evaluation.passed).toContain("test_b_chance");
    });

    it("un plafond sous la mise à prix échoue : aucune enchère n'est possible", () => {
      const base = court();
      const evaluation = evaluatePepite({
        ...base,
        ceiling: { ...base.ceiling!, referenceEur: START - 1 },
      });
      expect(evaluation.metrics.ceilingBelowStart).toBe(true);
      expect(evaluation.missed).toContain("test_b_chance");
      expect(evaluation.status).toBe("not_pepite");
    });

    it("un plafond de 0 (aucun prix ne tient) échoue sans lever d'erreur", () => {
      const base = court();
      const evaluation = evaluatePepite({
        ...base,
        ceiling: { ...base.ceiling!, referenceEur: 0 },
      });
      expect(evaluation.status).toBe("not_pepite");
      expect(evaluation.missed).toContain("test_b_chance");
      expect(evaluation.metrics.ceilingBelowStart).toBe(true);
    });
  });

  describe("test C : décote d'achat attendue", () => {
    function costRatio(ratio: number): PepiteInput {
      const base = court();
      // Le prix probable est 150 000 : le coût total vaut `ratio` fois la valeur centrale.
      return { ...base, ceiling: { ...base.ceiling!, totalCostAt: () => ratio * CENTRAL } };
    }

    it("réussit à 75 % exactement", () => {
      const evaluation = evaluatePepite(costRatio(PEPITE_COST_MAX_SHARE_COURT));
      expect(evaluation.metrics.costRatio).toBe(PEPITE_COST_MAX_SHARE_COURT);
      expect(evaluation.status).toBe("pepite");
    });

    it("échoue au-delà de 75 %, mais tient jusqu'à 80 % inclus", () => {
      const between = evaluatePepite(costRatio(0.78));
      expect(between.missed).toContain("test_c_cost");
      expect(between.favorable).toBe(false);
      expect(between.holds).toBe(true);

      const atExit = evaluatePepite(costRatio(PEPITE_COST_EXIT_SHARE_COURT));
      expect(atExit.holds).toBe(true);
      const beyond = evaluatePepite(costRatio(0.81));
      expect(beyond.holds).toBe(false);
      expect(beyond.holdMissed).toContain("test_c_cost");
    });

    it("compte le prix, les frais du régime et la libération (coût fourni par le plafond)", () => {
      const seen: number[] = [];
      const base = court();
      evaluatePepite({
        ...base,
        ceiling: {
          ...base.ceiling!,
          totalCostAt: (price) => {
            seen.push(price);
            return price * 1.3;
          },
        },
      });
      // Évalué au prix probable (mise à prix × q50), à l'entrée comme à la sortie.
      expect(new Set(seen)).toEqual(new Set([150_000]));
    });
  });

  describe("mesure illisible : le test concerné est manqué", () => {
    it.each([Number.NaN, Number.POSITIVE_INFINITY])("coût total %s : test C manqué", (cost) => {
      const base = court();
      const evaluation = evaluatePepite({
        ...base,
        ceiling: { ...base.ceiling!, totalCostAt: () => cost },
      });
      expect(evaluation.missed).toContain("test_c_cost");
      expect(evaluation.metrics.costRatio).toBeNull();
      expect(evaluation.favorable).toBe(false);
      expect(evaluation.holds).toBe(false);
    });

    it("coût total absent : test C manqué, jamais réussi par défaut", () => {
      const base = court();
      const evaluation = evaluatePepite({
        ...base,
        ceiling: { ...base.ceiling!, totalCostAt: () => null },
      });
      expect(evaluation.missed).toContain("test_c_cost");
      expect(evaluation.passed).not.toContain("test_c_cost");
    });

    it("part B non finie : test B manqué, même pour un plancher", () => {
      const base = court();
      const evaluation = evaluatePepite({
        ...base,
        scenarios: {
          ...base.scenarios!,
          buckets: [
            { key: "near_start", lowRatio: 0, highRatio: 4, probability: Number.NaN },
            { key: "above_3", lowRatio: 4, highRatio: null, probability: 0 },
          ],
        },
        ceiling: { ...base.ceiling!, referenceEur: 4.5 * START },
      });
      expect(evaluation.passed).not.toContain("test_b_chance");
    });
  });

  describe("multiplicateur local", () => {
    it("prend q50 dans le cas général", () => {
      expect(evaluatePepite(court()).metrics.multiplierKey).toBe("q50");
    });

    it("prend q75 quand la mise à prix est inférieure à 30 % de la valeur centrale", () => {
      const below = evaluatePepite(withEstimate(court(), { centralValueEur: START / 0.2999 }));
      expect(below.metrics.multiplierKey).toBe("q75");
      expect(below.metrics.multiplier).toBe(2);
      expect(below.metrics.probablePriceEur).toBe(200_000);
    });

    it("une mise à prix entre 10 % et 30 % de la valeur reste candidate, avec q75", () => {
      const input = { ...court(), startingPriceEur: 60_000 };
      const evaluation = evaluatePepite(input);
      expect(evaluation.passed).toContain("gap_significant");
      expect(evaluation.metrics.multiplierKey).toBe("q75");
      expect(evaluation.metrics.startingShareOfValue).toBeCloseTo(0.2, 10);
    });

    it("écarte une mise à prix sous 10 % ou au-dessus de 150 %, bornes admises", () => {
      const at = (startingPriceEur: number) =>
        evaluatePepite({ ...court(), startingPriceEur }).missed.includes("gap_significant");
      expect(at(30_000)).toBe(false);
      expect(at(29_999)).toBe(true);
      expect(at(450_000)).toBe(false);
      expect(at(450_001)).toBe(true);
    });

    it("garde q50 à 30 % exactement (90 000 sur 300 000)", () => {
      const input = { ...court(), startingPriceEur: 90_000 };
      expect(evaluatePepite(input).metrics.multiplierKey).toBe("q50");
      expect(evaluatePepite({ ...input, startingPriceEur: 89_999 }).metrics.multiplierKey).toBe(
        "q75",
      );
    });

    it("la fourchette va de q25 à q75 de la mise à prix", () => {
      const { metrics } = evaluatePepite(court());
      expect(metrics.rangeLowEur).toBe(START * 1.2);
      expect(metrics.rangeHighEur).toBe(START * 2);
    });
  });
});

describe("evaluatePepite : ventes notariales", () => {
  it("à la bougie : test C seul, prix probable = mise à prix", () => {
    const evaluation = evaluatePepite(notary("notary_auction"));

    expect(evaluation.status).toBe("pepite");
    expect(evaluation.metrics).toMatchObject({
      multiplierKey: "start",
      probablePriceEur: START,
      rangeLowEur: null,
      rangeHighEur: null,
      chanceShare: null,
    });
    expect(evaluation.metrics.costRatio).toBeCloseTo(0.6, 6);
    expect(evaluation.passed).not.toContain("test_b_chance");
    expect(evaluation.passed).not.toContain("scenarios_reliable");
    expect(evaluation.passed).toContain("ceiling_above_start");
  });

  it("à la bougie : le plafond de référence doit couvrir la mise à prix", () => {
    const base = notary("notary_auction");
    const at = evaluatePepite({ ...base, ceiling: { ...base.ceiling!, referenceEur: START } });
    expect(at.passed).toContain("ceiling_above_start");
    const under = evaluatePepite({
      ...base,
      ceiling: { ...base.ceiling!, referenceEur: START - 1 },
    });
    expect(under.missed).toContain("ceiling_above_start");
    expect(under.status).toBe("not_pepite");
    expect(under.holds).toBe(false);
  });

  it("interactive : test C sur la première offre possible, plafond au moins égal à cette offre", () => {
    const base = notary("notary_online");
    const evaluation = evaluatePepite({
      ...base,
      startingPriceEur: 80_000,
      ceiling: { ...base.ceiling!, referenceEur: 80_000, totalCostAt: (price) => price * 1.3 },
    });

    expect(evaluation.metrics.probablePriceEur).toBe(80_000);
    expect(evaluation.metrics.costRatio).toBeCloseTo((80_000 * 1.3) / 200_000, 6);
    expect(evaluation.passed).toContain("ceiling_computed");
    expect(evaluation.status).toBe("pepite");
  });

  it("interactive : un plafond sous la première offre fait échouer ceiling_computed", () => {
    const base = notary("notary_online");
    const evaluation = evaluatePepite({
      ...base,
      startingPriceEur: 80_000,
      ceiling: { ...base.ceiling!, referenceEur: 79_999, totalCostAt: (price) => price * 1.3 },
    });

    expect(evaluation.missed).toContain("ceiling_computed");
    expect(evaluation.favorable).toBe(false);
    // Le plafond est calculé, simplement trop bas : ce n'est pas une donnée manquante.
    expect(evaluation.status).toBe("not_pepite");
    expect(evaluation.holds).toBe(false);
  });

  it.each(["tribunal", "notary_auction", "notary_online"] as const)(
    "%s : un plafond de référence de 0 échoue ceiling_computed",
    (regime) => {
      const base = regime === "tribunal" ? court() : notary(regime);
      const evaluation = evaluatePepite({
        ...base,
        ceiling: { ...base.ceiling!, referenceEur: 0 },
      });
      expect(evaluation.missed).toContain("ceiling_computed");
      expect(evaluation.favorable).toBe(false);
      expect(evaluation.holds).toBe(false);
    },
  );

  it.each(["notary_auction", "notary_online"] as const)(
    "%s : seuil de 65 % réussi exactement, manqué au-delà",
    (regime) => {
      const base = notary(regime);
      const at = evaluatePepite({
        ...base,
        ceiling: { ...base.ceiling!, totalCostAt: () => PEPITE_COST_MAX_SHARE_NOTARY * 200_000 },
      });
      expect(at.metrics.costRatio).toBe(PEPITE_COST_MAX_SHARE_NOTARY);
      expect(at.status).toBe("pepite");

      const over = evaluatePepite({
        ...base,
        ceiling: { ...base.ceiling!, totalCostAt: () => 0.66 * 200_000 },
      });
      expect(over.missed).toEqual(["test_c_cost"]);
      expect(over.status).toBe("not_pepite");
      // Sortie à 70 % (et non 80 % comme au tribunal) : tient jusqu'à 70 % inclus.
      expect(over.holds).toBe(true);
      const atExit = evaluatePepite({
        ...base,
        ceiling: {
          ...base.ceiling!,
          totalCostAt: () => PEPITE_COST_EXIT_SHARE_NOTARY * 200_000,
        },
      });
      expect(atExit.holds).toBe(true);
      const beyond = evaluatePepite({
        ...base,
        ceiling: { ...base.ceiling!, totalCostAt: () => 0.71 * 200_000 },
      });
      expect(beyond.holds).toBe(false);
      expect(beyond.holdMissed).toEqual(["test_c_cost"]);
    },
  );

  it("ne demande ni scénarios ni fiabilité de scénarios", () => {
    expect(evaluatePepite(notary("notary_online")).missed).toEqual([]);
  });

  it("garde les mêmes garde-fous que le tribunal", () => {
    const evaluation = evaluatePepite(
      withEstimate(notary("notary_auction"), { effectiveSampleSize: 5 }),
    );
    expect(evaluation.missed).toEqual(["estimate_sample"]);
    expect(
      evaluatePepite(withSignals(notary("notary_online"), { probableDuplicate: true })).blocking,
    ).toBe(true);
  });
});

describe("evaluatePepite : ventes hors de la règle", () => {
  it("sans régime ouvert (domanial, inconnu, mode notarial inconnu, régime fermé) : non applicable", () => {
    const evaluation = evaluatePepite(court({ regime: null }));

    expect(evaluation.status).toBe("not_applicable");
    expect(evaluation.favorable).toBe(false);
    expect(evaluation.holds).toBe(false);
    expect(evaluation.missed).toEqual(["regime_open"]);
    expect(evaluation.metrics.probablePriceEur).toBeNull();
  });

  it("vente pas à venir : non applicable", () => {
    const evaluation = evaluatePepite(court({ upcoming: false }));

    expect(evaluation.status).toBe("not_applicable");
    expect(evaluation.missed).toEqual(["sale_upcoming"]);
    expect(evaluation.passed).toEqual(["regime_open"]);
  });
});

describe("applyPepiteStability", () => {
  const NOW = new Date("2026-11-01T12:00:00Z");
  const SALE_DATE = "2026-12-15T10:00:00Z";
  const favorable = evaluatePepite(court());
  const unfavorable = evaluatePepite(withEstimate(court(), { reliability: "fragile" }));
  const tolerated = evaluatePepite({
    ...court(),
    ceiling: { ...court().ceiling!, totalCostAt: () => 0.78 * CENTRAL },
  });
  const beyond = evaluatePepite({
    ...court(),
    ceiling: { ...court().ceiling!, totalCostAt: () => 0.85 * CENTRAL },
  });
  const blocking = evaluatePepite(withSignals(court(), { probableDuplicate: true }));

  function stored(overrides: Partial<PepiteStoredState> = {}): PepiteStoredState {
    return {
      isPepite: false,
      favorableStreak: 0,
      frozenAt: null,
      lastFavorableAt: null,
      dataMissingSince: null,
      inputStartingPriceEur: START,
      ...overrides,
    };
  }

  function hoursAgo(hours: number) {
    return new Date(NOW.getTime() - hours * 3_600_000).toISOString();
  }

  function apply(
    evaluation: PepiteEvaluation,
    previous: PepiteStoredState | null,
    overrides: { now?: Date; saleDate?: string | null; startingPriceEur?: number | null } = {},
  ) {
    return applyPepiteStability({
      previous,
      evaluation,
      startingPriceEur:
        overrides.startingPriceEur === undefined ? START : overrides.startingPriceEur,
      saleDate: overrides.saleDate === undefined ? SALE_DATE : overrides.saleDate,
      now: overrides.now ?? NOW,
    });
  }

  describe("entrée", () => {
    it("une première évaluation favorable ne publie pas", () => {
      expect(apply(favorable, null)).toEqual({
        isPepite: false,
        favorableStreak: 1,
        frozenAt: null,
        lastFavorableAt: NOW.toISOString(),
        dataMissingSince: null,
        codes: ["stab:streak_1"],
      });
    });

    it("la deuxième évaluation favorable consécutive publie", () => {
      expect(
        apply(favorable, stored({ favorableStreak: 1, lastFavorableAt: hoursAgo(13) })),
      ).toEqual({
        isPepite: true,
        favorableStreak: 2,
        frozenAt: null,
        lastFavorableAt: NOW.toISOString(),
        dataMissingSince: null,
        codes: ["stab:entered"],
      });
    });

    it("une évaluation défavorable remet la série à zéro", () => {
      expect(
        apply(unfavorable, stored({ favorableStreak: 1, lastFavorableAt: hoursAgo(13) })),
      ).toMatchObject({ isPepite: false, favorableStreak: 0, lastFavorableAt: null });
    });

    it("une évaluation qui tient aux seuils de sortie sans être favorable ne compte pas pour l'entrée", () => {
      expect(tolerated.holds).toBe(true);
      expect(
        apply(tolerated, stored({ favorableStreak: 1, lastFavorableAt: hoursAgo(13) })),
      ).toMatchObject({ isPepite: false, favorableStreak: 0 });
    });

    it("deux passages rapprochés sur les mêmes données ne comptent qu'une fois", () => {
      const almost = new Date(
        NOW.getTime() - (PEPITE_MIN_HOURS_BETWEEN_EVALUATIONS * 3_600_000 - 1),
      );
      const first = stored({ favorableStreak: 1, lastFavorableAt: almost.toISOString() });
      const result = apply(favorable, first);
      expect(result.isPepite).toBe(false);
      expect(result.favorableStreak).toBe(1);
      // La date de la dernière évaluation comptée ne bouge pas : l'espacement se mesure depuis elle.
      expect(result.lastFavorableAt).toBe(almost.toISOString());

      const exactly = new Date(NOW.getTime() - PEPITE_MIN_HOURS_BETWEEN_EVALUATIONS * 3_600_000);
      expect(
        apply(favorable, stored({ favorableStreak: 1, lastFavorableAt: exactly.toISOString() }))
          .isPepite,
      ).toBe(true);
    });

    it("une série qui repart après une évaluation non favorable compte aussitôt, sans attendre 12 h", () => {
      // La précédente évaluation n'était pas favorable (série à zéro), il y a une heure.
      const afterMiss = apply(favorable, stored({ favorableStreak: 0, lastFavorableAt: null }));
      expect(afterMiss).toMatchObject({ isPepite: false, favorableStreak: 1 });
      // Même si une ancienne date favorable traîne : série à zéro, la suivante compte.
      expect(
        apply(favorable, stored({ favorableStreak: 0, lastFavorableAt: hoursAgo(1) })),
      ).toMatchObject({ favorableStreak: 1, lastFavorableAt: NOW.toISOString() });
    });

    it("des passages toutes les 6 h ne publient qu'au bout de 12 h depuis la première favorable", () => {
      let state: PepiteStoredState | null = null;
      const published: boolean[] = [];
      for (let pass = 0; pass < 4; pass += 1) {
        const at = new Date(NOW.getTime() + pass * 6 * 3_600_000);
        const result = apply(favorable, state, { now: at });
        published.push(result.isPepite);
        state = stored({
          isPepite: result.isPepite,
          favorableStreak: result.favorableStreak,
          lastFavorableAt: result.lastFavorableAt,
        });
      }
      // Passage 0 : série 1 ; passage 1 (6 h) : trop tôt ; passage 2 (12 h) : publié.
      expect(published).toEqual([false, false, true, true]);
    });
  });

  describe("sortie", () => {
    const published = stored({ isPepite: true, favorableStreak: 2 });

    it("reste publiée tant qu'elle tient aux seuils de sortie, même sous les seuils d'entrée", () => {
      expect(apply(favorable, published)).toMatchObject({ isPepite: true, favorableStreak: 2 });
      expect(apply(tolerated, published)).toMatchObject({ isPepite: true });
    });

    it("sort quand le ratio C dépasse 80 %", () => {
      expect(apply(beyond, published)).toEqual({
        isPepite: false,
        favorableStreak: 0,
        frozenAt: null,
        lastFavorableAt: null,
        dataMissingSince: null,
        codes: ["stab:exit"],
      });
    });

    it("sort quand un garde-fou n'est plus tenu", () => {
      expect(apply(unfavorable, published)).toMatchObject({
        isPepite: false,
        codes: ["stab:exit"],
      });
    });

    describe("donnée manquante (estimation absente ou en cours de rafraîchissement)", () => {
      const insufficient = evaluatePepite({ ...court(), estimate: null });

      it("est tolérée sans rien changer, et date le début du manque", () => {
        expect(insufficient.status).toBe("insufficient");
        expect(apply(insufficient, published)).toMatchObject({
          isPepite: true,
          favorableStreak: 2,
          dataMissingSince: NOW.toISOString(),
          codes: ["stab:data_missing"],
        });
      });

      it("garde la date de début du manque pendant la tolérance (23 h 59)", () => {
        const since = new Date(NOW.getTime() - (PEPITE_DATA_GRACE_HOURS * 3_600_000 - 60_000));
        expect(
          apply(insufficient, stored({ ...published, dataMissingSince: since.toISOString() })),
        ).toMatchObject({
          isPepite: true,
          dataMissingSince: since.toISOString(),
          codes: ["stab:data_missing"],
        });
      });

      it("sort après 24 h", () => {
        const since = new Date(NOW.getTime() - PEPITE_DATA_GRACE_HOURS * 3_600_000);
        expect(
          apply(insufficient, stored({ ...published, dataMissingSince: since.toISOString() })),
        ).toMatchObject({
          isPepite: false,
          favorableStreak: 0,
          dataMissingSince: null,
          codes: ["stab:exit_data_missing"],
        });
      });

      it("sort tout de suite sur un seuil de sortie ou un signal bloquant, sans attendre", () => {
        expect(apply(beyond, published).codes).toEqual(["stab:exit"]);
        expect(apply(blocking, published).codes).toEqual(["stab:exit_blocking"]);
      });

      it("une évaluation complète efface la date du manque", () => {
        expect(
          apply(favorable, stored({ ...published, dataMissingSince: hoursAgo(5) })),
        ).toMatchObject({ isPepite: true, dataMissingSince: null });
      });

      it("une vente pas encore publiée ne gagne rien d'une donnée manquante", () => {
        expect(apply(insufficient, stored({ favorableStreak: 1 }))).toMatchObject({
          isPepite: false,
          favorableStreak: 0,
        });
      });
    });

    describe("changement de version", () => {
      it("l'état stocké sert quelle que soit la version : la série continue", () => {
        // La règle ne reçoit plus de version : seul l'état compte, il n'est jamais remis à zéro.
        expect(
          apply(favorable, stored({ favorableStreak: 1, lastFavorableAt: hoursAgo(13) })),
        ).toMatchObject({ isPepite: true });
      });

      it("une pépite publiée reste publiée seulement si la nouvelle évaluation passe les seuils de sortie", () => {
        expect(apply(tolerated, published).isPepite).toBe(true);
        expect(apply(beyond, published).isPepite).toBe(false);
      });
    });

    it("sort dès qu'un signal bloquant apparaît", () => {
      expect(apply(blocking, published)).toEqual({
        isPepite: false,
        favorableStreak: 0,
        frozenAt: null,
        lastFavorableAt: null,
        dataMissingSince: null,
        codes: ["stab:exit_blocking"],
      });
    });

    it("un signal bloquant remet aussi à zéro une vente pas encore publiée", () => {
      expect(apply(blocking, stored({ favorableStreak: 1 }))).toMatchObject({
        isPepite: false,
        favorableStreak: 0,
        codes: [],
      });
    });

    it("ne republie qu'après deux nouvelles évaluations favorables", () => {
      const out = apply(beyond, published);
      const again = apply(favorable, stored({ favorableStreak: out.favorableStreak }));
      expect(again.isPepite).toBe(false);
    });
  });

  describe("gel à J-7", () => {
    const inFreeze = new Date("2026-12-09T12:00:00Z");
    const published = stored({
      isPepite: true,
      favorableStreak: 2,
    });

    it("ne change plus le résultat dans les 7 derniers jours, publié ou non", () => {
      expect(apply(beyond, published, { now: inFreeze })).toEqual({
        isPepite: true,
        favorableStreak: 2,
        frozenAt: inFreeze.toISOString(),
        lastFavorableAt: null,
        dataMissingSince: null,
        codes: ["stab:frozen"],
      });
      expect(
        apply(favorable, stored({ favorableStreak: 1 }), {
          now: inFreeze,
        }),
      ).toMatchObject({ isPepite: false, favorableStreak: 1, codes: ["stab:frozen"] });
    });

    it("ne garde pas gelée une évaluation stockée sous une autre version de la règle : réévaluée aux seuils de sortie", () => {
      const old = { ...published, ruleVersion: "pepite-v1" };
      // Même version : le gel tient, quel que soit le résultat de la nouvelle évaluation.
      expect(
        apply(beyond, { ...published, ruleVersion: favorable.ruleVersion }, { now: inFreeze })
          .codes,
      ).toEqual(["stab:frozen"]);
      // Version différente : la pépite sort si elle ne tient plus aux seuils de sortie…
      expect(apply(beyond, old, { now: inFreeze })).toMatchObject({
        isPepite: false,
        frozenAt: null,
        codes: ["stab:exit"],
      });
      // … et reste publiée, sans gel, si elle y tient.
      expect(apply(tolerated, old, { now: inFreeze })).toMatchObject({
        isPepite: true,
        frozenAt: null,
        codes: [],
      });
    });

    it("garde la date du gel déjà posée", () => {
      const frozenAt = "2026-12-08T10:00:00Z";
      expect(apply(favorable, { ...published, frozenAt }, { now: inFreeze }).frozenAt).toBe(
        frozenAt,
      );
    });

    it("gèle à 7 jours exactement, pas à 7 jours et une seconde", () => {
      const saleMs = Date.parse(SALE_DATE);
      const exactly = new Date(saleMs - PEPITE_FREEZE_DAYS * 86_400_000);
      expect(apply(beyond, published, { now: exactly }).codes).toEqual(["stab:frozen"]);
      const before = new Date(exactly.getTime() - 1_000);
      expect(apply(beyond, published, { now: before }).codes).toEqual(["stab:exit"]);
    });

    it("un signal bloquant l'emporte sur le gel", () => {
      expect(apply(blocking, published, { now: inFreeze })).toMatchObject({
        isPepite: false,
        codes: ["stab:exit_blocking"],
      });
    });

    it("un changement de prix lève le gel", () => {
      const result = apply(beyond, published, { now: inFreeze, startingPriceEur: START + 5_000 });
      expect(result.isPepite).toBe(false);
      expect(result.codes).toEqual(["stab:price_changed", "stab:exit"]);
    });

    it("sans évaluation antérieure, rien n'est gelé : la série commence", () => {
      expect(apply(favorable, null, { now: inFreeze })).toMatchObject({
        isPepite: false,
        favorableStreak: 1,
      });
    });

    it("sans date de vente lisible, pas de gel", () => {
      expect(
        apply(beyond, stored({ isPepite: true, favorableStreak: 2 }), { saleDate: null }).codes,
      ).toEqual(["stab:exit"]);
    });
  });

  it("une vente non applicable repart de zéro", () => {
    const na = evaluatePepite(court({ regime: null }));
    expect(
      apply(na, stored({ isPepite: true, favorableStreak: 2, frozenAt: "2026-10-01T00:00:00Z" })),
    ).toEqual({
      isPepite: false,
      favorableStreak: 0,
      frozenAt: null,
      lastFavorableAt: null,
      dataMissingSince: null,
      codes: [],
    });
  });

  it(`exige ${PEPITE_FAVOURABLE_EVALUATIONS} évaluations favorables, pas davantage`, () => {
    const first = apply(favorable, null);
    const second = apply(favorable, stored({ favorableStreak: first.favorableStreak }));
    expect(second.isPepite).toBe(true);
    // La série est plafonnée au nombre requis.
    expect(apply(favorable, stored({ favorableStreak: 5 })).favorableStreak).toBe(2);
  });
});
