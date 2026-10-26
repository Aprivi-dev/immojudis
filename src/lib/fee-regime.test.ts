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
  ceilingTermsFor,
  ceilingTermWithArticleText,
  ceilingTermWithScopeText,
  ceilingVenueScopeText,
  DEFAULT_OPEN_FEE_REGIMES,
  DEFINED_FEE_REGIMES,
  FEE_REGIME_KEYS,
  FEE_REGIME_TERMS,
  FEE_REGIMES,
  feeRegimeForSale,
  feeRegimeKeysForVenue,
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
    expect(ceilingTermText(["tribunal"])).toBe("enchère plafond");
    expect(ceilingTermWithArticleText(["tribunal"])).toBe("l’enchère plafond");
    expect(ceilingVenueScopeText(["tribunal"])).toBe("ventes au tribunal");
    // Sans régime, les textes sont ceux du tribunal.
    expect(labelsOf({})).toBe(TRIBUNAL_FEE_REGIME.labels);
  });

  it("nomme le montant selon les régimes ouverts : tous ceux qui sont définis par défaut", () => {
    expect(ceilingTermText()).toBe("enchère plafond ou offre plafond");
    expect(ceilingTermWithArticleText()).toBe("l’enchère plafond ou l’offre plafond");
    expect(ceilingVenueScopeText()).toBe(
      "ventes au tribunal, ventes notariales à la bougie et ventes notariales interactives",
    );
    expect(ceilingTermWithScopeText()).toBe(
      "enchère plafond (ventes au tribunal et ventes notariales à la bougie) ou offre plafond (ventes notariales interactives)",
    );
    // Le régime interactif fermé : seul le terme « enchère » reste, avec ses deux types de vente.
    expect(ceilingTermWithScopeText(["tribunal", "notary_auction"])).toBe(
      "enchère plafond (ventes au tribunal et ventes notariales à la bougie)",
    );
    expect(ceilingTermWithScopeText(["tribunal"])).toBe("enchère plafond (ventes au tribunal)");
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

/** Les conditions d'une vente notariale, comme la vue de la fiche les sert (`sale_conditions`). */
function notarySale(
  conditions: Record<string, unknown> | null,
  overrides: Record<string, unknown> = {},
): AuctionSale {
  return sale({ sale_venue_type: "notary", sale_conditions: conditions, ...overrides });
}

describe("feeRegimeForSale", () => {
  it("donne le régime tribunal à une vente au tribunal", () => {
    expect(feeRegimeForSale(sale({ sale_venue_type: "tribunal" }))?.key).toBe("tribunal");
  });

  it("donne le régime de la bougie ou de la vente interactive à une vente notariale, selon ses conditions", () => {
    expect(feeRegimeForSale(notarySale({ procedure: "notarial_auction" }))?.key).toBe(
      "notary_auction",
    );
    expect(feeRegimeForSale(notarySale({ procedure: "online_tender" }))?.key).toBe("notary_online");
    // À défaut de procédure, la nature du prix de départ départage.
    expect(feeRegimeForSale(notarySale({ price_nature: "first_offer_possible" }))?.key).toBe(
      "notary_online",
    );
    expect(feeRegimeForSale(notarySale({ price_nature: "mise_a_prix" }))?.key).toBe(
      "notary_auction",
    );
  });

  it("ne donne aucun plafond à une vente notariale dont le mode est inconnu", () => {
    // Compte Découverte (aucune condition lue), conditions vides, nature du prix non précisée.
    expect(feeRegimeForSale(notarySale(null))).toBeNull();
    expect(feeRegimeForSale(notarySale({}))).toBeNull();
    expect(feeRegimeForSale(notarySale({ price_nature: "displayed_price" }))).toBeNull();
    // Procédure et nature contradictoires : on ne devine pas.
    expect(
      feeRegimeForSale(
        notarySale({ procedure: "notarial_auction", price_nature: "first_offer_possible" }),
      ),
    ).toBeNull();
  });

  it("ne donne aucun plafond à une vente à la bougie qui n'est pas une adjudication volontaire", () => {
    expect(
      feeRegimeForSale(
        notarySale({ procedure: "notarial_auction", adjudication_type: "JUDICIAIRE" }),
      ),
    ).toBeNull();
    expect(
      feeRegimeForSale(
        notarySale({ procedure: "notarial_auction", adjudication_type: "VOLONTAIRE" }),
      )?.key,
    ).toBe("notary_auction");
  });

  it("ne donne aucun plafond à une vente dont l'origine est une licitation, une saisie ou un autre marqueur judiciaire", () => {
    for (const origin of ["LICITATION", "SAISIE", "licitation", "EXPROPRIATION"]) {
      expect(
        feeRegimeForSale(
          notarySale({
            procedure: "notarial_auction",
            adjudication_type: "VOLONTAIRE",
            origin,
          }),
        ),
      ).toBeNull();
      // Une vente interactive d'origine judiciaire n'a pas non plus le barème de gré à gré.
      expect(feeRegimeForSale(notarySale({ procedure: "online_tender", origin }))).toBeNull();
    }
    // L'origine « adjudication » ou absente garde la règle actuelle (type d'adjudication).
    expect(
      feeRegimeForSale(
        notarySale({
          procedure: "notarial_auction",
          adjudication_type: "VOLONTAIRE",
          origin: "ADJUDICATION",
        }),
      )?.key,
    ).toBe("notary_auction");
    expect(
      feeRegimeForSale(
        notarySale({ procedure: "notarial_auction", adjudication_type: "VOLONTAIRE" }),
      )?.key,
    ).toBe("notary_auction");
    // Un type d'adjudication judiciaire reste refusé, quelle que soit l'origine.
    expect(
      feeRegimeForSale(
        notarySale({
          procedure: "notarial_auction",
          adjudication_type: "JUDICIAIRE",
          origin: "ADJUDICATION",
        }),
      ),
    ).toBeNull();
  });

  it("ne donne aucun plafond à une vente notariale d'origine judiciaire (licitation, saisie)", () => {
    const conditions = { procedure: "notarial_auction" };
    expect(
      feeRegimeForSale(notarySale(conditions, { sale_legal_framework: "judicial_partition" })),
    ).toBeNull();
    expect(
      feeRegimeForSale(notarySale(conditions, { sale_legal_framework: "judicial_seizure" })),
    ).toBeNull();
    expect(
      feeRegimeForSale(notarySale(conditions, { sale_legal_framework: "voluntary_notarial" }))?.key,
    ).toBe("notary_auction");
  });

  it.each(["state", "online", "unknown"])(
    "ne donne aucun régime à une vente de type %s",
    (venue) => {
      expect(feeRegimeForSale(sale({ sale_venue_type: venue }))).toBeNull();
      // Même avec des conditions notariales : le type de vente décide d'abord.
      expect(
        feeRegimeForSale(
          sale({ sale_venue_type: venue, sale_conditions: { procedure: "online_tender" } }),
        ),
      ).toBeNull();
    },
  );

  it("ne donne aucun régime à une vente sans type de vente reconnu", () => {
    expect(feeRegimeForSale(sale({ sale_venue_type: undefined }))).toBeNull();
  });

  it("laisse les ventes domaniales sans régime, même ouvertes par la configuration", () => {
    const open = ["tribunal", "notary_auction", "notary_online", "state_auction"] as const;
    expect(feeRegimeForSale(sale({ sale_venue_type: "state" }), open)).toBeNull();
    expect(FEE_REGIMES.state_auction).toBeUndefined();
    expect(isFeeRegimeOpen("state_auction", open)).toBe(false);
  });

  it("ferme un régime notarial qui n'est pas listé, et garde le tribunal toujours ouvert", () => {
    const online = notarySale({ procedure: "online_tender" });
    const auction = notarySale({ procedure: "notarial_auction" });
    expect(feeRegimeForSale(online, ["tribunal", "notary_auction"])).toBeNull();
    expect(feeRegimeForSale(auction, ["tribunal", "notary_auction"])?.key).toBe("notary_auction");
    expect(feeRegimeForSale(auction, ["tribunal"])).toBeNull();
    expect(isFeeRegimeOpen("tribunal", [])).toBe(true);
    expect(feeRegimeForSale(sale({ sale_venue_type: "tribunal" }), [])?.key).toBe("tribunal");
  });
});

describe("régimes possibles d'un type de vente", () => {
  it("donne les deux régimes notariaux tant que les conditions de la vente sont inconnues", () => {
    expect(feeRegimeKeysForVenue("tribunal")).toEqual(["tribunal"]);
    expect(feeRegimeKeysForVenue("notary")).toEqual(["notary_auction", "notary_online"]);
    expect(feeRegimeKeysForVenue("state")).toEqual([]);
    expect(feeRegimeKeysForVenue("online")).toEqual([]);
    expect(feeRegimeKeysForVenue("unknown")).toEqual([]);
    expect(feeRegimeKeysForVenue("notary", ["tribunal", "notary_online"])).toEqual([
      "notary_online",
    ]);
    expect(feeRegimeKeysForVenue("notary", [])).toEqual([]);
  });

  it("nomme le terme possible : un seul terme, ou les deux tant que le mode est inconnu", () => {
    expect(ceilingTermsFor(["tribunal"])?.ceilingTermWithArticle).toBe("l’enchère plafond");
    expect(ceilingTermsFor(["notary_online"])?.ceilingTermWithArticle).toBe("l’offre plafond");
    expect(ceilingTermsFor(["notary_online"])?.ceilingSimulationLabel).toBe(
      "Offre plafond (simulation)",
    );
    expect(ceilingTermsFor(["notary_auction", "notary_online"])).toEqual({
      ceilingTerm: "enchère plafond ou offre plafond",
      ceilingTermWithArticle: "l’enchère plafond ou l’offre plafond",
      ceilingSimulationLabel: "Enchère plafond ou offre plafond (simulation)",
    });
    expect(ceilingTermsFor([])).toBeNull();
  });
});

describe("parseOpenFeeRegimes", () => {
  it("ouvre tous les régimes définis quand la variable est absente", () => {
    expect(parseOpenFeeRegimes(undefined)).toEqual(["tribunal", "notary_auction", "notary_online"]);
    expect(parseOpenFeeRegimes(null)).toEqual(["tribunal", "notary_auction", "notary_online"]);
    expect([...DEFAULT_OPEN_FEE_REGIMES]).toEqual([...DEFINED_FEE_REGIMES]);
  });

  it("n'ouvre que les régimes listés quand la variable est présente, le tribunal toujours", () => {
    expect(parseOpenFeeRegimes("")).toEqual(["tribunal"]);
    expect(parseOpenFeeRegimes("tribunal")).toEqual(["tribunal"]);
    expect(parseOpenFeeRegimes("nimporte,quoi")).toEqual(["tribunal"]);
    expect(parseOpenFeeRegimes("notary_online")).toEqual(["tribunal", "notary_online"]);
  });

  it("lit une liste séparée par des virgules, sans doublon", () => {
    expect(parseOpenFeeRegimes(" notary_auction , notary_online,notary_auction")).toEqual([
      "tribunal",
      "notary_auction",
      "notary_online",
    ]);
  });

  it("n'ouvre jamais un régime dont les règles ne sont pas définies", () => {
    expect(parseOpenFeeRegimes("state_auction")).toEqual(["tribunal", "state_auction"]);
    expect(isFeeRegimeOpen("state_auction", parseOpenFeeRegimes("state_auction"))).toBe(false);
  });
});

// Un régime de démonstration, pour vérifier les points d'accroche que le lot suivant utilisera.
const DEMO_REGIME: FeeRegime = {
  key: "notary_auction",
  // Un régime « judicial » de démonstration : seuls les régimes notariaux écartent les frais préalables.
  kind: "judicial",
  version: "test",
  emolumentScale: {
    reference: "test",
    date: "01/01/2026",
    brackets: [{ upTo: Infinity, rate: 0.05 }],
  },
  defaultPreliminaryFees: 1_000,
  defaultLawyerFees: 0,
  consignation: { rate: 0.05, minimum: 500, reference: "test" },
  organizationFeeRate: 0,
  buyerFeesFromListing: false,
  labels: {
    ...TRIBUNAL_FEE_REGIME.labels,
    ceilingTerm: "offre plafond",
    ceilingTermWithArticle: "l’offre plafond",
    ceilingStepLabel: "Offre plafond",
    cash: {
      ...TRIBUNAL_FEE_REGIME.labels.cash,
      consignation: {
        ...TRIBUNAL_FEE_REGIME.labels.cash.consignation!,
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
