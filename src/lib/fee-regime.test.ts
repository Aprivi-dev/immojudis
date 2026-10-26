import { describe, expect, it } from "vitest";
import { buildCeilingHypotheses } from "@/lib/bid-ceiling-defaults";
import {
  buildCashPlan,
  CONSIGNATION_MINIMUM,
  CONSIGNATION_RATE,
  computeCeilingPlan,
  consignationAmount,
} from "@/lib/bid-ceiling-engine";
import {
  ceilingTermText,
  ceilingTermWithArticleText,
  ceilingVenueScopeText,
  DEFINED_FEE_REGIMES,
  FEE_REGIME_KEYS,
  FEE_REGIME_TERMS,
  FEE_REGIMES,
  feeRegimeForSale,
  isFeeRegimeOpen,
  labelsOf,
  parseOpenFeeRegimes,
  TRIBUNAL_CONSIGNATION_RULE,
  TRIBUNAL_FEE_REGIME,
  type FeeRegime,
} from "@/lib/fee-regime";
import {
  computeAcquisitionCosts,
  computeEmolumentsHT,
  DEFAULT_PRELIMINARY_FEES,
  DEFAULTS,
  EMOLUMENT_SCALE_DATE,
  EMOLUMENT_SCALE_REFERENCE,
} from "@/lib/profitability";
import type { AuctionSale } from "@/lib/types";

function sale(overrides: Record<string, unknown> = {}): AuctionSale {
  return {
    id: "sale-regime",
    department: "33",
    property_type: "apartment",
    app_surface_m2: 62,
    app_surface_kind: "habitable",
    starting_price_eur: 60_000,
    occupancy_status: "vacant",
    ...overrides,
  } as unknown as AuctionSale;
}

describe("régime de frais du tribunal", () => {
  it("reprend les constantes actuelles du barème, des frais par défaut et de la consignation", () => {
    expect(TRIBUNAL_FEE_REGIME.key).toBe("tribunal");
    expect(TRIBUNAL_FEE_REGIME.version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(TRIBUNAL_FEE_REGIME.emolumentScale.reference).toBe(EMOLUMENT_SCALE_REFERENCE);
    expect(TRIBUNAL_FEE_REGIME.emolumentScale.date).toBe(EMOLUMENT_SCALE_DATE);
    expect(TRIBUNAL_FEE_REGIME.defaultPreliminaryFees).toBe(DEFAULT_PRELIMINARY_FEES);
    expect(TRIBUNAL_FEE_REGIME.defaultLawyerFees).toBe(DEFAULTS.lawyerFees);
    expect(TRIBUNAL_FEE_REGIME.consignation).toEqual({
      rate: 0.1,
      minimum: 3_000,
      reference: "art. R322-41 CPCE",
    });
    expect(CONSIGNATION_RATE).toBe(TRIBUNAL_CONSIGNATION_RULE.rate);
    expect(CONSIGNATION_MINIMUM).toBe(TRIBUNAL_CONSIGNATION_RULE.minimum);
  });

  it("applique le barème A444-191 tranche par tranche, avec ou sans le barème passé en option", () => {
    const brackets = TRIBUNAL_FEE_REGIME.emolumentScale.brackets;
    for (const price of [0, 6_500, 12_000, 60_000, 250_000]) {
      expect(computeEmolumentsHT(price, brackets)).toBe(computeEmolumentsHT(price));
      expect(computeAcquisitionCosts({ price, emolumentBrackets: brackets })).toEqual(
        computeAcquisitionCosts({ price }),
      );
    }
  });

  it("donne au tribunal le vocabulaire actuel de l'enchère plafond", () => {
    const labels = TRIBUNAL_FEE_REGIME.labels;
    expect(labels.ceilingTerm).toBe("enchère plafond");
    expect(labels.ceilingTermWithArticle).toBe("l’enchère plafond");
    expect(labels.ceilingSimulationLabel).toBe("Enchère plafond (simulation)");
    expect(labels.venueScope).toBe("ventes au tribunal");
    expect(ceilingTermText()).toBe("enchère plafond");
    expect(ceilingTermWithArticleText()).toBe("l’enchère plafond");
    expect(ceilingVenueScopeText()).toBe("ventes au tribunal");
    // Sans régime, les textes sont ceux du tribunal.
    expect(labelsOf({})).toBe(TRIBUNAL_FEE_REGIME.labels);
  });
});

describe("tables de régimes", () => {
  it("portent les mêmes clés, toutes parmi les clés prévues", () => {
    const keys = (table: object) => Object.keys(table).sort();
    expect(keys(FEE_REGIME_TERMS)).toEqual(keys(FEE_REGIMES));
    expect(keys(FEE_REGIMES)).toEqual([...DEFINED_FEE_REGIMES].sort());
    for (const key of keys(FEE_REGIMES)) expect(FEE_REGIME_KEYS).toContain(key);
    for (const [key, regime] of Object.entries(FEE_REGIMES)) {
      expect(regime.key).toBe(key);
      // Les termes du régime sont ceux de la table légère, mot pour mot.
      expect(regime.labels).toMatchObject(FEE_REGIME_TERMS[key as keyof typeof FEE_REGIME_TERMS]!);
    }
  });
});

describe("feeRegimeForSale", () => {
  it("donne le régime tribunal à une vente au tribunal", () => {
    expect(feeRegimeForSale(sale({ sale_venue_type: "tribunal" }))?.key).toBe("tribunal");
  });

  it.each(["notary", "state", "online", "unknown"])(
    "ne donne aucun régime à une vente de type %s (pas encore de règles)",
    (venue) => {
      expect(feeRegimeForSale(sale({ sale_venue_type: venue }))).toBeNull();
    },
  );

  it("ne donne aucun régime à une vente sans type de vente reconnu", () => {
    expect(feeRegimeForSale(sale({ sale_venue_type: undefined }))).toBeNull();
  });

  it("n'ouvre pas un régime notarial ou domanial dont les règles ne sont pas définies", () => {
    const open = ["tribunal", "notary_auction", "notary_online", "state_auction"] as const;
    expect(feeRegimeForSale(sale({ sale_venue_type: "notary" }), open)).toBeNull();
    expect(feeRegimeForSale(sale({ sale_venue_type: "state" }), open)).toBeNull();
    for (const key of ["notary_auction", "notary_online", "state_auction"] as const) {
      expect(FEE_REGIMES[key]).toBeUndefined();
      expect(isFeeRegimeOpen(key, open)).toBe(false);
    }
  });

  it("garde le tribunal toujours ouvert, même avec une liste vide", () => {
    expect(isFeeRegimeOpen("tribunal", [])).toBe(true);
    expect(feeRegimeForSale(sale({ sale_venue_type: "tribunal" }), [])?.key).toBe("tribunal");
  });
});

describe("parseOpenFeeRegimes", () => {
  it("ouvre toujours le tribunal et ignore les clés inconnues", () => {
    expect(parseOpenFeeRegimes(undefined)).toEqual(["tribunal"]);
    expect(parseOpenFeeRegimes("")).toEqual(["tribunal"]);
    expect(parseOpenFeeRegimes("nimporte,quoi")).toEqual(["tribunal"]);
  });

  it("lit une liste séparée par des virgules, sans doublon", () => {
    expect(parseOpenFeeRegimes(" notary_auction , notary_online,notary_auction")).toEqual([
      "tribunal",
      "notary_auction",
      "notary_online",
    ]);
  });
});

// Un régime de démonstration, pour vérifier les points d'accroche que le lot suivant utilisera.
const DEMO_REGIME: FeeRegime = {
  key: "notary_auction",
  version: "test",
  emolumentScale: {
    reference: "test",
    date: "01/01/2026",
    brackets: [{ upTo: Infinity, rate: 0.05 }],
  },
  defaultPreliminaryFees: 1_000,
  defaultLawyerFees: 0,
  consignation: { rate: 0.05, minimum: 500, reference: "test" },
  labels: {
    ...TRIBUNAL_FEE_REGIME.labels,
    ceilingTerm: "offre plafond",
    ceilingTermWithArticle: "l’offre plafond",
    ceilingStepLabel: "Offre plafond",
    cash: {
      ...TRIBUNAL_FEE_REGIME.labels.cash,
      consignation: {
        ...TRIBUNAL_FEE_REGIME.labels.cash.consignation,
        label: "Dépôt de garantie",
      },
    },
  },
};

describe("points d'accroche d'un régime", () => {
  const estimate = {
    source: "DVF normalisé",
    sourceUpdatedAt: null,
    subjectSurfaceEstimated: false,
    estimatedValueEur: 220_000,
    actionable: true,
    qualityLabel: "forte",
    sampleSize: 25,
    effectiveSampleSize: 25,
    medianPricePerM2: 3_548,
    p75PricePerM2: 4_080,
  } as never;

  it("ne met aucun régime ni barème dans des hypothèses construites sans régime", () => {
    const hypotheses = buildCeilingHypotheses(sale(), estimate);
    expect(hypotheses.regime).toBeUndefined();
    expect(hypotheses.fees.emolumentBrackets).toBeUndefined();
    expect(hypotheses.fees.fpt).toBe(DEFAULT_PRELIMINARY_FEES);
    expect(hypotheses.fees.lawyerFees).toBe(DEFAULTS.lawyerFees);
  });

  it("calcule la même chose avec le régime tribunal qu'avec aucun régime", () => {
    const without = computeCeilingPlan(buildCeilingHypotheses(sale(), estimate));
    const withRegime = computeCeilingPlan(
      buildCeilingHypotheses(sale(), estimate, {}, TRIBUNAL_FEE_REGIME),
    );
    expect(withRegime).toEqual(without);
  });

  it("lit les frais par défaut, le barème, la consignation et les textes du régime donné", () => {
    const hypotheses = buildCeilingHypotheses(sale(), estimate, {}, DEMO_REGIME);
    expect(hypotheses.regime).toBe(DEMO_REGIME);
    expect(hypotheses.fees.fpt).toBe(1_000);
    expect(hypotheses.fees.lawyerFees).toBe(0);

    const plan = computeCeilingPlan(hypotheses);
    // 5 % d'émoluments proportionnels : plus que le barème dégressif du tribunal.
    expect(plan.feesAtMaxBid.emolumentsHT).toBeCloseTo(plan.maxBid * 0.05, 5);
    expect(plan.steps.at(-1)).toMatchObject({ key: "ceiling", label: "Offre plafond" });

    const cash = buildCashPlan(hypotheses, plan, plan.maxBid);
    expect(cash[0].label).toBe("Dépôt de garantie");
    expect(cash[0].amount).toBe(Math.max(500, Math.round(60_000 * 0.05)));
  });

  it("garde l'appel à deux champs de consignationAmount (simulateur de frais)", () => {
    expect(consignationAmount({ consignation: null, startingPrice: 100_000 })).toBe(10_000);
    expect(consignationAmount({ consignation: null, startingPrice: 12_000 })).toBe(3_000);
    expect(consignationAmount({ consignation: 4_200, startingPrice: 12_000 })).toBe(4_200);
  });

  it("accepte une règle de consignation, ou aucune", () => {
    const rule = { rate: 0.05, minimum: 500, reference: "test" };
    expect(consignationAmount({ consignation: null, startingPrice: 100_000 }, rule)).toBe(5_000);
    expect(consignationAmount({ consignation: null, startingPrice: 4_000 }, rule)).toBe(500);
    expect(consignationAmount({ consignation: null, startingPrice: 100_000 }, null)).toBe(0);
    expect(consignationAmount({ consignation: 7_000, startingPrice: 100_000 }, null)).toBe(7_000);
  });
});
