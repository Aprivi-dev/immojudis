import { describe, expect, it } from "vitest";
import type { AiReviewProjectionReadModel } from "@/lib/ai-review-guard";
import type { AuctionScenariosResponse } from "@/lib/auction-scenarios";
import { evaluateBid } from "@/lib/bid-ceiling-engine";
import { feeRegimeForSale } from "@/lib/fee-regime";
import type { MarketContext, MarketEstimate } from "@/lib/market-server/types";
import {
  buildPepiteInput as buildPepiteInputVersioned,
  evaluateSaleForPepite as evaluateSaleForPepiteVersioned,
  type PepiteEstimateRow,
  type PepiteSourceData,
} from "@/lib/pepite-input";
import { PEPITE_LATEST_RULE_VERSION, type PepiteRuleVersion } from "@/lib/pepite-policy";
import { computeSaleCeiling } from "@/lib/sale-ceiling";
import type { AuctionSale } from "@/lib/types";

/** La version de la règle est obligatoire : ces tests évaluent la règle courante sauf indication contraire. */
const buildPepiteInput = (
  data: PepiteSourceData,
  ruleVersion: PepiteRuleVersion = PEPITE_LATEST_RULE_VERSION,
) => buildPepiteInputVersioned(data, ruleVersion);
const evaluateSaleForPepite = (
  data: PepiteSourceData,
  ruleVersion: PepiteRuleVersion = PEPITE_LATEST_RULE_VERSION,
) => evaluateSaleForPepiteVersioned(data, ruleVersion);

const NOW = new Date("2026-11-01T12:00:00Z");
const FUTURE = "2026-12-15T10:00:00Z";

function sale(overrides: Record<string, unknown> = {}): AuctionSale {
  return {
    id: "pepite-sale",
    status: "upcoming",
    sale_date: FUTURE,
    sale_venue_type: "tribunal",
    department: "33",
    property_type: "apartment",
    app_surface_m2: 62,
    app_surface_kind: "habitable",
    starting_price_eur: 80_000,
    occupancy_status: "vacant",
    description: "Appartement libre.",
    quality_flags: [],
    investment_score: 99,
    ...overrides,
  } as unknown as AuctionSale;
}

/** Procédure d'une vente au tribunal, au format écrit par le pipeline (`saleProcedureSchema`). */
function procedure(status: "verified" | "conflict") {
  return {
    schema_version: "sale_procedure_v1",
    ruleset_version: "test",
    venue_type: "tribunal",
    state_sale_method: null,
    legal_framework: "judicial_seizure",
    venue_name: null,
    venue_address: null,
    participation_mode: "in_person",
    organizer_name: null,
    organizer_type: "lawyer",
    organizer_contact: null,
    eligible_bar: null,
    rules: {
      lawyer_required: true,
      lawyer_note: "",
      bid_method: "",
      guarantee: { amount_eur: null, rate_pct: null, minimum_eur: null, status: "", note: "" },
      financing_condition: null,
      cooling_off_period: null,
      payment_deadline_days: null,
      overbid: { allowed: null, minimum_increase_pct: null, window_days: null, note: "" },
    },
    verification: {
      status,
      verified_at: null,
      case_source_count: 0,
      case_sources: [],
      regulatory_sources: [],
      facts: [],
      issues: [],
    },
  };
}

const NOTARY_CONDITIONS = {
  procedure: "notarial_auction",
  adjudication_type: "VOLONTAIRE",
  origin: "ADJUDICATION",
  price_nature: "mise_a_prix",
  deposit_eur: 12_000,
};
const ONLINE_CONDITIONS = {
  procedure: "online_tender",
  adjudication_type: "VOLONTAIRE",
  origin: "ADJUDICATION",
  price_nature: "first_offer_possible",
  first_offer_eur: 90_000,
  negotiation_fee_rate: 0.04,
  negotiation_fee_payer: "ACQUEREUR",
};

function storedEstimate(overrides: Partial<MarketEstimate> = {}): MarketEstimate {
  return {
    source: "DVF normalisé",
    sourceUpdatedAt: null,
    subjectSurfaceEstimated: false,
    estimatedValueEur: 200_000,
    estimatedValueLowEur: 170_000,
    estimatedValueHighEur: 230_000,
    actionable: true,
    qualityLabel: "correcte",
    sampleSize: 14,
    effectiveSampleSize: 11,
    medianPricePerM2: 3_225,
    p75PricePerM2: 3_700,
    radiusM: 600,
    areaKind: "urban",
    segment: "apartment",
    predictionInterval: {
      coverageTarget: 0.8,
      method: "local_jackknife",
      p10PricePerM2: 2_740,
      p50PricePerM2: 3_225,
      p90PricePerM2: 3_700,
      conformalExpansionPct: 0,
    },
    ...overrides,
  } as unknown as MarketEstimate;
}

function row(overrides: Partial<PepiteEstimateRow> = {}): PepiteEstimateRow {
  return {
    status: "ready",
    actionable: true,
    comparable_count: 14,
    value_p10_eur: 170_000,
    value_p50_eur: 200_000,
    value_p90_eur: 230_000,
    segment: "apartment",
    engine_kind: "comparable_ensemble",
    computed_at: "2026-10-30T08:00:00Z",
    ...overrides,
  };
}

function context(estimate: MarketEstimate | null): MarketContext {
  return { ok: estimate != null, error: null, estimate, status: estimate ? "ready" : "queued" };
}

const SCENARIOS: AuctionScenariosResponse = {
  courtName: "TJ Bordeaux",
  startingPrice: 80_000,
  propertyType: "apartment",
  unavailable: null,
  dataAsOf: null,
  history: { licitor: null, dvf: null },
  scenarios: {
    status: "ok",
    band: 4,
    courtSample: 40,
    nationalSample: 900,
    basis: "court",
    reliability: "good",
    priceScope: "court",
    scenarios: [
      { key: "near_start", lowRatio: 0, highRatio: 1.1, probability: 0.2 },
      { key: "up_to_1_5", lowRatio: 1.1, highRatio: 1.5, probability: 0.3 },
      { key: "up_to_2", lowRatio: 1.5, highRatio: 2, probability: 0.25 },
      { key: "up_to_3", lowRatio: 2, highRatio: 3, probability: 0.15 },
      { key: "above_3", lowRatio: 3, highRatio: null, probability: 0.1 },
    ],
    ratioQuartiles: { q25: 1.2, q50: 1.5, q75: 2 },
  },
};

function source(overrides: Partial<PepiteSourceData> = {}): PepiteSourceData {
  return {
    sale: sale(),
    scoreStatus: null,
    aiProjections: null,
    aiReviewStatus: "ready",
    regimes: ["tribunal", "notary_auction", "notary_online"],
    estimate: { row: row(), context: context(storedEstimate()) },
    modelActive: true,
    scenarios: SCENARIOS,
    flood: {
      verdict: "none_found",
      observedAt: "2026-11-01T08:00:00.000Z",
      mapDate: null,
      ppriChecked: true,
    },
    now: NOW,
    ...overrides,
  };
}

/** L'estimation telle que la fiche la donne à `computeSaleCeiling`, pour une valeur donnée. */
function ficheEstimate(value: number) {
  return {
    source: "DVF normalisé" as const,
    sourceUpdatedAt: null,
    subjectSurfaceEstimated: false,
    estimatedValueEur: value,
    actionable: true,
    qualityLabel: "correcte" as const,
    sampleSize: 11,
    effectiveSampleSize: 11,
    medianPricePerM2: null,
    p75PricePerM2: null,
  };
}

function ficheCeiling(value: number) {
  return computeSaleCeiling({
    sale: sale(),
    aiProjections: null,
    aiReviewStatus: "ready",
    regimes: ["tribunal"],
    estimate: ficheEstimate(value),
  });
}

describe("buildPepiteInput : verdict d'inondation", () => {
  const flood = (verdict: "high" | "exposed" | "none_found" | "no_signal" | "unknown") => ({
    verdict,
    observedAt: "2026-11-01T08:00:00.000Z",
    mapDate: "2013-12-18",
    ppriChecked: true,
  });

  it("passe le verdict stocké à la règle et le garde avec les faits de l'évaluation (règle v2)", () => {
    const { input, facts } = buildPepiteInput(source({ flood: flood("exposed") }));
    expect(input.flood).toEqual({ verdict: "exposed", ppriChecked: true });
    expect(facts.flood).toEqual(flood("exposed"));
  });

  it("un risque élevé exclut la vente (v2) ; un verdict inconnu empêche l'entrée sans la bloquer", () => {
    const v1 = evaluateSaleForPepite(source(), "pepite-v1").evaluation;
    const high = evaluateSaleForPepite(source({ flood: flood("high") })).evaluation;
    expect(high.blocking).toBe(true);
    expect(high.favorable).toBe(false);
    expect(high.holds).toBe(false);
    expect(high.missed).toContain("no_high_flood_risk");

    const unknown = evaluateSaleForPepite(source({ flood: flood("unknown") })).evaluation;
    expect(unknown.favorable).toBe(false);
    expect(unknown.holds).toBe(v1.holds);
    expect(unknown.blocking).toBe(v1.blocking);
    expect(unknown.missed).toContain("flood_risk_known");

    // Un verdict contrôlé (ou sans objet) laisse la décision de la règle v1 intacte.
    for (const verdict of ["none_found", "exposed", "no_signal"] as const) {
      const known = evaluateSaleForPepite(source({ flood: flood(verdict) })).evaluation;
      expect([known.status, known.favorable, known.holds]).toEqual([
        v1.status,
        v1.favorable,
        v1.holds,
      ]);
    }
  });

  it("« aucun risque élevé » sans lecture des périmètres de PPRi n'ouvre pas l'entrée, mais ne bloque pas", () => {
    const v1 = evaluateSaleForPepite(source(), "pepite-v1").evaluation;
    const unread = evaluateSaleForPepite(
      source({ flood: { ...flood("none_found"), ppriChecked: false } }),
    );
    expect(unread.input.flood).toEqual({ verdict: "none_found", ppriChecked: false });
    expect(unread.evaluation.favorable).toBe(false);
    expect(unread.evaluation.blocking).toBe(false);
    expect(unread.evaluation.missed).toContain("flood_risk_known");
    // Au maintien, comme un verdict inconnu : une pépite déjà publiée n'est pas retirée.
    expect(unread.evaluation.holds).toBe(v1.holds);
    // Lu en entier, le même verdict laisse la décision de la règle v1 intacte.
    const read = evaluateSaleForPepite(source({ flood: flood("none_found") })).evaluation;
    expect([read.status, read.favorable, read.holds]).toEqual([v1.status, v1.favorable, v1.holds]);
  });

  it("sous la règle v1, le verdict est ignoré et n'est pas gardé dans les faits", () => {
    const reference = evaluateSaleForPepite(source(), "pepite-v1");
    const result = evaluateSaleForPepite(source({ flood: flood("high") }), "pepite-v1");
    expect(result.evaluation.ruleVersion).toBe("pepite-v1");
    expect(result.evaluation.status).toBe(reference.evaluation.status);
    expect(result.evaluation.blocking).toBe(reference.evaluation.blocking);
    expect(result.facts.flood).toBeNull();
  });
});

describe("buildPepiteInput", () => {
  it("calcule le plafond de référence sur la valeur P10, comme la fiche le calculerait", () => {
    const { input, facts } = buildPepiteInput(source());
    const regime = feeRegimeForSale(sale(), ["tribunal"]);

    // La même chaîne que la fiche, avec une estimation dont la valeur est le P10 : mêmes hypothèses
    // par défaut (habiter, équilibré, sans travaux), mêmes frais du régime.
    const fiche = ficheCeiling(170_000);
    expect(fiche.plan.reachable).toBe(true);
    expect(input.ceiling?.referenceEur).toBe(fiche.plan.maxBid);
    expect(input.regime).toBe("tribunal");
    expect(facts.regimeKey).toBe("tribunal");
    expect(facts.regimeVersion).toBe(regime?.version);

    // Avec la valeur centrale (200 000), le plafond serait plus haut : la règle est plus stricte.
    expect(input.ceiling?.referenceEur).toBeLessThan(ficheCeiling(200_000).plan.maxBid);
  });

  it("le coût d'achat compte le prix, les frais du régime et la libération d'un bien occupé", () => {
    const vacant = buildPepiteInput(source()).input;
    const occupied = buildPepiteInput(
      source({ sale: sale({ occupancy_status: "occupied" }) }),
    ).input;

    const fees = (price: number) => {
      const ceiling = computeSaleCeiling({
        sale: sale(),
        aiProjections: null,
        aiReviewStatus: "ready",
        regimes: ["tribunal"],
        estimate: null,
      });
      return evaluateBid(ceiling.hypotheses, ceiling.plan, price).fees.acquisitionFeesTotal;
    };
    const vacantCost = vacant.ceiling!.totalCostAt(120_000)!;
    expect(vacantCost).toBeCloseTo(120_000 + fees(120_000), 0);
    // Libération : 3 000 € par défaut, en plus (ni travaux, ni portage).
    expect(occupied.ceiling!.totalCostAt(120_000)! - vacantCost).toBe(3_000);
    expect(occupied.signals.occupancy).toBe("occupe");
  });

  it("passe l'estimation, la porte publique et l'écart à la règle", () => {
    const { input, facts } = buildPepiteInput(source());

    expect(input.upcoming).toBe(true);
    expect(input.startingPriceEur).toBe(80_000);
    expect(input.estimate).toEqual({
      actionable: true,
      reliability: "correcte",
      effectiveSampleSize: 11,
      surfaceEstimated: false,
      publicGatePassed: true,
      centralValueEur: 200_000,
      lowValueEur: 170_000,
    });
    expect(facts.estimateComputedAt).toBe("2026-10-30T08:00:00Z");
    expect(facts.gapDiscountPct).toBe(60);
    expect(facts.startingPriceColumnEur).toBe(80_000);
    expect(facts.scenarios).toMatchObject({ reliability: "good", courtSample: 40 });
  });

  it("écart extrême : sous 10 % ou au-dessus de 150 % de la valeur centrale, pas entre 10 % et 30 %", () => {
    const missed = (p50: number) =>
      evaluateSaleForPepite(
        source({
          estimate: { row: row({ value_p50_eur: p50 }), context: context(storedEstimate()) },
        }),
      ).evaluation.missed;
    // Mise à prix de 80 000 : 26,7 % de 300 000 reste candidate (q75), 8 % de 1 000 000 est écartée.
    expect(missed(300_000)).not.toContain("gap_significant");
    expect(missed(1_000_000)).toContain("gap_significant");
    expect(missed(50_000)).toContain("gap_significant");
  });

  it("ferme la porte publique d'une estimation à intervalle trop large", () => {
    const { input } = buildPepiteInput(
      source({
        estimate: { row: row({ value_p90_eur: 400_000 }), context: context(storedEstimate()) },
      }),
    );
    expect(input.estimate?.publicGatePassed).toBe(false);
  });

  it("un moteur LightGBM compte seulement tant que son modèle est actif", () => {
    const lightgbm = {
      row: row({ engine_kind: "hybrid_lightgbm" }),
      context: context(storedEstimate()),
    };
    expect(
      buildPepiteInput(source({ estimate: lightgbm, modelActive: true })).input.estimate
        ?.publicGatePassed,
    ).toBe(true);
    expect(
      buildPepiteInput(source({ estimate: lightgbm, modelActive: false })).input.estimate
        ?.publicGatePassed,
    ).toBe(false);
  });

  it("sans estimation exploitable, ni plafond ni estimation : données insuffisantes", () => {
    for (const estimate of [
      null,
      { row: row(), context: context(null) },
      { row: row({ status: "failed" }), context: context(storedEstimate()) },
      { row: row({ status: "unavailable" }), context: context(storedEstimate()) },
    ]) {
      const result = evaluateSaleForPepite(source({ estimate }));
      expect(result.input.estimate).toBeNull();
      expect(result.evaluation.status).toBe("insufficient");
      expect(result.facts.estimateComputedAt).toBe(estimate?.row.computed_at ?? null);
    }
  });

  it.each(["pending", "processing"])(
    "une estimation en cours de rafraîchissement (%s) sert comme à la fiche",
    (status) => {
      const refreshing: MarketContext = {
        ok: true,
        error: null,
        estimate: storedEstimate(),
        status: "refreshing",
      };
      const result = evaluateSaleForPepite(
        source({ estimate: { row: row({ status }), context: refreshing } }),
      );
      expect(result.input.estimate).not.toBeNull();
      expect(result.input.ceiling?.available).toBe(true);
      expect(result.evaluation.status).not.toBe("insufficient");
      expect(result.facts.estimateComputedAt).toBe("2026-10-30T08:00:00Z");
    },
  );

  it.each([0, -1])("une mise à prix de %s n'est pas stockée pour la garde de lecture", (price) => {
    const { facts } = buildPepiteInput(source({ sale: sale({ starting_price_eur: price }) }));
    expect(facts.startingPriceColumnEur).toBeNull();
  });

  it("une surface estimée, pour le bien ou pour l'estimation, manque le critère de surface", () => {
    const studio = sale({ property_type: "studio", app_surface_m2: null, title: "Studio" });
    expect(buildPepiteInput(source({ sale: studio })).input.estimate?.surfaceEstimated).toBe(true);
    const estimated = {
      row: row(),
      context: context(storedEstimate({ subjectSurfaceEstimated: true })),
    };
    expect(buildPepiteInput(source({ estimate: estimated })).input.estimate?.surfaceEstimated).toBe(
      true,
    );
  });

  it("ne lit pas l'investment_score de la vente", () => {
    const high = evaluateSaleForPepite(source({ sale: sale({ investment_score: 99 }) }));
    const low = evaluateSaleForPepite(source({ sale: sale({ investment_score: 1 }) }));
    const none = evaluateSaleForPepite(source({ sale: sale({ investment_score: null }) }));
    expect(low.evaluation).toEqual(high.evaluation);
    expect(low.facts).toEqual(high.facts);
    expect(none.evaluation).toEqual(high.evaluation);
  });

  it("ne lit aucune donnée d'avocat", () => {
    const named = evaluateSaleForPepite(
      source({ sale: sale({ lawyer_name: "Me Dupont", lawyer_contact: "dupont@example.test" }) }),
    );
    const anonymous = evaluateSaleForPepite(
      source({ sale: sale({ lawyer_name: null, lawyer_contact: null }) }),
    );
    expect(named.evaluation).toEqual(anonymous.evaluation);
    expect(named.facts).toEqual(anonymous.facts);
  });

  describe("signaux", () => {
    it.each<[string, Partial<PepiteSourceData>]>([
      ["risques non qualifiés", { scoreStatus: "withheld_unqualified_risks" }],
      [
        "conflit de valorisation (terrain annoncé comme appartement)",
        {
          sale: sale({
            property_type: "land",
            source_blocks: { titre_detail: "Un appartement de trois pièces" },
          }),
        },
      ],
      [
        "doublon probable",
        { sale: sale({ quality_flags: ["missing_address", "probable_duplicate"] }) },
      ],
      ["conflit de vérification", { sale: sale({ sale_verification_status: "conflict" }) }],
      [
        "conflit de vérification de la procédure",
        { sale: sale({ sale_procedure: procedure("conflict") }) },
      ],
      ["occupation inconnue", { sale: sale({ occupancy_status: "unknown" }) }],
      ["bien squatté", { sale: sale({ occupancy_status: "squatted" }) }],
      [
        "état dégradé documenté",
        {
          sale: sale({
            description: "Appartement libre, gros travaux à prévoir, toiture à refaire.",
          }),
        },
      ],
      [
        "travaux à budgéter documentés",
        {
          sale: sale({
            description: "Appartement libre, travaux à prévoir, plomberie à reprendre.",
          }),
        },
      ],
    ])("%s : pas de pépite, signal bloquant", (_label, overrides) => {
      const { evaluation } = evaluateSaleForPepite(source(overrides));
      expect(evaluation.blocking).toBe(true);
      expect(evaluation.status).toBe("not_pepite");
    });

    it.each(["land", "mixed"])("%s : pas de pépite (critère de type de bien)", (propertyType) => {
      const { evaluation } = evaluateSaleForPepite(
        source({ sale: sale({ property_type: propertyType }) }),
      );
      expect(evaluation.missed).toContain("property_type_supported");
      expect(evaluation.status).not.toBe("pepite");
    });

    it("un rafraîchissement léger n'écarte pas la vente", () => {
      const { evaluation } = evaluateSaleForPepite(
        source({ sale: sale({ description: "Appartement libre, peinture à rafraîchir." }) }),
      );
      expect(evaluation.missed).not.toContain("no_degraded_condition");
    });

    it("un champ critique bloqué par la relecture IA est bloquant, et prive la règle du plafond", () => {
      const projections: AiReviewProjectionReadModel[] = [
        {
          auction_sale_id: "pepite-sale",
          field_key: "sale.starting_price_eur",
          review_state: "unresolved",
          citation_status: "not_required",
          is_publishable: false,
          source_name: null,
          source_url: null,
        },
      ];
      const { input, evaluation } = evaluateSaleForPepite(source({ aiProjections: projections }));

      expect(input.signals.aiBlocked).toBe(true);
      expect(input.ceiling).toBeNull();
      expect(evaluation.blocking).toBe(true);
      expect(evaluation.status).toBe("not_pepite");
    });

    it("une vente favorable n'a aucun signal bloquant", () => {
      expect(buildPepiteInput(source()).input.signals).toEqual({
        landOrMixed: false,
        occupancy: "libre",
        degradedCondition: false,
        valuationConflict: false,
        aiBlocked: false,
        verificationConflict: false,
        probableDuplicate: false,
        unqualifiedRisks: false,
      });
    });
  });

  describe("vente à venir", () => {
    it.each<[string, Record<string, unknown>]>([
      ["statut passé", { status: "past" }],
      ["statut reporté", { status: "postponed" }],
      ["statut inconnu", { status: "unknown" }],
      ["date passée", { sale_date: "2026-10-01T10:00:00Z" }],
      ["sans date", { sale_date: null }],
    ])("%s : non applicable", (_label, overrides) => {
      const { input, evaluation } = evaluateSaleForPepite(source({ sale: sale(overrides) }));
      expect(input.upcoming).toBe(false);
      expect(evaluation.status).toBe("not_applicable");
    });
  });

  describe("régimes", () => {
    it("vente domaniale ou de type inconnu : non applicable", () => {
      for (const venue of ["state", "unknown"]) {
        const { input, evaluation, facts } = evaluateSaleForPepite(
          source({ sale: sale({ sale_venue_type: venue }) }),
        );
        expect(input.regime).toBeNull();
        expect(evaluation.status).toBe("not_applicable");
        expect(facts.regimeKey).toBeNull();
        expect(facts.regimeVersion).toBeNull();
      }
    });

    it("régime notarial fermé par CEILING_FEE_REGIMES_OPEN : non applicable", () => {
      const closed = evaluateSaleForPepite(
        source({
          sale: sale({ sale_venue_type: "notary", sale_conditions: NOTARY_CONDITIONS }),
          regimes: ["tribunal"],
        }),
      );
      expect(closed.evaluation.status).toBe("not_applicable");
    });

    it("vente notariale de mode inconnu, ou d'origine judiciaire : non applicable", () => {
      expect(
        evaluateSaleForPepite(
          source({ sale: sale({ sale_venue_type: "notary", sale_conditions: null }) }),
        ).evaluation.status,
      ).toBe("not_applicable");
      expect(
        evaluateSaleForPepite(
          source({
            sale: sale({
              sale_venue_type: "notary",
              sale_legal_framework: "judicial_seizure",
              sale_conditions: { ...NOTARY_CONDITIONS, origin: "SAISIE" },
            }),
          }),
        ).evaluation.status,
      ).toBe("not_applicable");
    });

    it("tribunal : les scénarios sont lus ; leur absence donne « données insuffisantes »", () => {
      expect(buildPepiteInput(source()).input.scenarios).toMatchObject({
        reliability: "good",
        q50: 1.5,
        courtSample: 40,
      });
      const none = evaluateSaleForPepite(source({ scenarios: null }));
      expect(none.input.scenarios).toBeNull();
      expect(none.evaluation.status).toBe("insufficient");
      const insufficient = evaluateSaleForPepite(
        source({
          scenarios: {
            ...SCENARIOS,
            scenarios: { ...SCENARIOS.scenarios!, status: "insufficient" },
          },
        }),
      );
      expect(insufficient.evaluation.status).toBe("insufficient");
    });

    it("vente notariale à la bougie : régime notary_auction, aucun scénario lu", () => {
      const { input, facts, evaluation } = evaluateSaleForPepite(
        source({
          sale: sale({
            sale_venue_type: "notary",
            sale_legal_framework: "voluntary_notarial",
            sale_conditions: NOTARY_CONDITIONS,
            starting_price_eur: 80_000,
          }),
          scenarios: null,
        }),
      );

      expect(input.regime).toBe("notary_auction");
      expect(input.scenarios).toBeNull();
      expect(facts.regimeKey).toBe("notary_auction");
      expect(facts.scenarios).toBeNull();
      expect(evaluation.passed).not.toContain("scenarios_reliable");
      expect(evaluation.metrics.probablePriceEur).toBe(80_000);
      expect(evaluation.metrics.referenceCeilingEur).not.toBeNull();
    });

    it("vente notariale interactive : le prix de départ est la première offre possible", () => {
      const { input, facts, evaluation } = evaluateSaleForPepite(
        source({
          sale: sale({
            sale_venue_type: "notary",
            sale_legal_framework: "voluntary_notarial",
            sale_conditions: ONLINE_CONDITIONS,
            starting_price_eur: 90_000,
          }),
          scenarios: null,
        }),
      );

      expect(input.regime).toBe("notary_online");
      expect(input.startingPriceEur).toBe(90_000);
      expect(evaluation.metrics.probablePriceEur).toBe(90_000);
      expect(facts.startingPriceColumnEur).toBe(90_000);
      // Les honoraires de négociation de l'acquéreur sont dans le coût : plus de 90 000 × 1,04.
      expect(input.ceiling!.totalCostAt(90_000)!).toBeGreaterThan(90_000 * 1.04);
    });
  });

  describe("pepite-v1.1 : frais connus et décote d'occupation", () => {
    const online = (conditions: Record<string, unknown>) =>
      source({
        sale: sale({
          sale_venue_type: "notary",
          sale_legal_framework: "voluntary_notarial",
          sale_conditions: conditions,
          starting_price_eur: 90_000,
        }),
        scenarios: null,
      });

    it("vente interactive : frais de publicité non indiqués = valeur par défaut, pépite refusée", () => {
      const { input, evaluation, facts } = evaluateSaleForPepite(online(ONLINE_CONDITIONS));
      expect(input.fees).toEqual({
        preliminary: null,
        negotiation: "document",
        advertising: "defaut",
      });
      expect(facts.fees).toEqual(input.fees);
      expect(evaluation.missed).toContain("fees_known");
      expect(evaluation.favorable).toBe(false);
      expect(evaluation.metrics.feesDefault).toBe(true);
    });

    it("vente interactive : frais de publicité indiqués et honoraires lus = frais connus", () => {
      const { input, evaluation } = evaluateSaleForPepite(
        online({ ...ONLINE_CONDITIONS, advertising_fees_eur: 1_200 }),
      );
      expect(input.fees).toEqual({
        preliminary: null,
        negotiation: "document",
        advertising: "document",
      });
      expect(evaluation.passed).toContain("fees_known");
      expect(evaluation.metrics.feesDefault).toBe(false);
    });

    it("vente interactive : payeur inconnu = honoraires par défaut, refusée ; la règle v1 ne regarde pas", () => {
      const conditions = {
        ...ONLINE_CONDITIONS,
        advertising_fees_eur: 1_200,
        negotiation_fee_payer: null,
      };
      const v11 = evaluateSaleForPepite(online(conditions), "pepite-v1.1");
      expect(v11.input.fees?.negotiation).toBe("defaut");
      expect(v11.evaluation.missed).toContain("fees_known");
      const v1 = evaluateSaleForPepite(online(conditions), "pepite-v1");
      expect(v1.evaluation.missed).not.toContain("fees_known");
    });

    it("tribunal : les frais préalables du cahier non lus restent admis, mais sont signalés", () => {
      const { input, evaluation } = evaluateSaleForPepite(source());
      expect(input.fees).toEqual({ preliminary: "defaut", negotiation: null, advertising: null });
      expect(evaluation.passed).not.toContain("fees_known");
      expect(evaluation.missed).not.toContain("fees_known");
      expect(evaluation.metrics.feesDefault).toBe(true);
    });

    it("bien loué : la décote de loyer du moteur s'applique à la valeur du test C ; bien occupé : aucune", () => {
      const libre = buildPepiteInput(source()).input;
      const loue = buildPepiteInput(source({ sale: sale({ occupancy_status: "rented" }) })).input;
      const occupe = buildPepiteInput(
        source({ sale: sale({ occupancy_status: "occupied" }) }),
      ).input;
      expect(libre.occupancyDiscountPct).toBe(0);
      expect(loue.signals.occupancy).toBe("loue");
      expect(loue.occupancyDiscountPct).toBe(10);
      expect(occupe.occupancyDiscountPct).toBe(0);
      const ratio = (data: PepiteSourceData) =>
        evaluateSaleForPepite(data).evaluation.metrics.costRatio;
      const free = ratio(source());
      const rented = ratio(source({ sale: sale({ occupancy_status: "rented" }) }));
      expect(free).not.toBeNull();
      expect(rented! / free!).toBeCloseTo(1 / 0.9, 3);
    });
  });

  it("retient la mise à prix de la colonne pour la garde de lecture, pas le prix de la règle", () => {
    const { facts } = buildPepiteInput(
      source({
        sale: sale({
          sale_venue_type: "notary",
          sale_conditions: { ...ONLINE_CONDITIONS, first_offer_eur: 95_000 },
          starting_price_eur: 90_000,
        }),
        scenarios: null,
      }),
    );
    expect(facts.startingPriceColumnEur).toBe(90_000);
  });

  it("une vente favorable de bout en bout", () => {
    const { evaluation } = evaluateSaleForPepite(source());
    // La mise à prix de 80 000 est à 40 % de la valeur centrale ; prix probable 120 000 (q50 = 1,5).
    expect(evaluation.metrics.probablePriceEur).toBe(120_000);
    expect(evaluation.metrics.multiplierKey).toBe("q50");
    expect(evaluation.missed).not.toContain("estimate_actionable");
    expect(evaluation.missed).not.toContain("public_gap_gate");
    expect(evaluation.missed).not.toContain("scenarios_reliable");
  });
});
