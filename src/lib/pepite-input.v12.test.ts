// Entrée de la règle pepite-v1.2 et pepite-v2.1 : DPE, marché local, pièces lues et badges, à partir des lectures de
// `pepite-context.server.ts`. Les versions antérieures ignorent ces lectures et rendent le même résultat.
import { describe, expect, it } from "vitest";
import type { AuctionScenariosResponse } from "@/lib/auction-scenarios";
import type { MarketContext, MarketEstimate } from "@/lib/market-server/types";
import { pepiteDpeDiagnostic } from "@/lib/pepite-energy";
import {
  buildPepiteInput,
  evaluateSaleForPepite,
  type PepiteEstimateRow,
  type PepiteSourceData,
  type PepiteV12Source,
} from "@/lib/pepite-input";
import type { PepiteRuleVersion } from "@/lib/pepite-policy";
import type { AuctionSale } from "@/lib/types";

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
    ...overrides,
  } as unknown as AuctionSale;
}

function storedEstimate(): MarketEstimate {
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
  } as unknown as MarketEstimate;
}

const ROW: PepiteEstimateRow = {
  status: "ready",
  actionable: true,
  comparable_count: 14,
  value_p10_eur: 170_000,
  value_p50_eur: 200_000,
  value_p90_eur: 230_000,
  segment: "apartment",
  engine_kind: "comparable_ensemble",
  computed_at: "2026-10-30T08:00:00Z",
};

const CONTEXT: MarketContext = {
  ok: true,
  error: null,
  estimate: storedEstimate(),
  status: "ready",
};

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

const AGGREGATE = {
  referenceYear: 2025,
  sales12Months: 90,
  medianRecentEurM2: 3_000,
  medianBaselineEurM2: 3_100,
  salesRecentYear: 85,
  salesBaselineYear: 80,
};

function v12(overrides: Partial<PepiteV12Source> = {}): PepiteV12Source {
  return {
    dpeDiagnostics: [],
    listingDpeClass: null,
    marketAggregates: { Appartement: AGGREGATE },
    readingPoints: null,
    rent: null,
    ...overrides,
  };
}

function source(overrides: Partial<PepiteSourceData> = {}): PepiteSourceData {
  return {
    sale: sale(),
    scoreStatus: null,
    aiProjections: null,
    aiReviewStatus: "ready",
    regimes: ["tribunal", "notary_auction", "notary_online"],
    estimate: { row: ROW, context: CONTEXT },
    modelActive: true,
    scenarios: SCENARIOS,
    flood: {
      verdict: "none_found",
      observedAt: "2026-11-01T08:00:00.000Z",
      mapDate: null,
      ppriChecked: true,
    },
    v12: v12(),
    now: NOW,
    ...overrides,
  };
}

const point = (quote: string, theme = "copropriete") =>
  ({ theme, title: "Copropriété", explanation: null, quote }) as never;

/** L'entrée de la règle sans sa fonction de coût (deux fonctions identiques ne sont jamais égales), à coût égal. */
function comparable(input: ReturnType<typeof buildPepiteInput>["input"]) {
  return {
    ...input,
    ceiling: input.ceiling
      ? {
          ...input.ceiling,
          totalCostAt: [50_000, 100_000, 160_000].map((price) => input.ceiling?.totalCostAt(price)),
        }
      : null,
  };
}

describe("pepite-v1.2 : entrée de la règle", () => {
  it("lit la surface habitable, un DPE inconnu et l'agrégat du type de la vente", () => {
    const { input } = buildPepiteInput(source(), "pepite-v1.2");
    expect(input.habitableSurfaceM2).toBe(62);
    expect(input.energy).toEqual({ dpeClass: null, dpeSource: null });
    expect(input.market).toEqual({ propertyType: "Appartement", aggregate: AGGREGATE });
    expect(input.signals.coproDistress).toBe(false);
  });

  it("ajoute le coût de rénovation du DPE de l'annonce au coût total du test C, et signale le DPE dans les détails", () => {
    const base = evaluateSaleForPepite(source(), "pepite-v1.2").evaluation;
    const withF = evaluateSaleForPepite(
      source({ v12: v12({ listingDpeClass: "F" }) }),
      "pepite-v1.2",
    ).evaluation;
    expect(base.metrics.dpeClass).toBeNull();
    expect(base.metrics.energyRenovationEur).toBeNull();
    expect(withF.metrics).toMatchObject({
      dpeClass: "F",
      dpeSource: "listing",
      energyRenovationEur: 62 * 250,
    });
    expect(withF.metrics.totalCostEur).toBe((base.metrics.totalCostEur ?? 0) + 62 * 250);
    expect(withF.metrics.costRatio).toBeGreaterThan(base.metrics.costRatio ?? 0);
  });

  it("préfère le DPE de l'ADEME (confiance d'au moins 0,8) à celui de l'annonce", () => {
    const diagnostics = (confidence: number) => [
      pepiteDpeDiagnostic({
        diagnostic_number: "2026A",
        dpe_class: "G",
        established_at: "2025-01-01",
        confidence,
      }),
    ];
    const strong = evaluateSaleForPepite(
      source({ v12: v12({ dpeDiagnostics: diagnostics(0.9), listingDpeClass: "C" }) }),
      "pepite-v1.2",
    ).evaluation;
    expect(strong.metrics).toMatchObject({
      dpeClass: "G",
      dpeSource: "ademe",
      energyRenovationEur: 62 * 400,
    });
    const weak = evaluateSaleForPepite(
      source({ v12: v12({ dpeDiagnostics: diagnostics(0.7), listingDpeClass: "C" }) }),
      "pepite-v1.2",
    ).evaluation;
    expect(weak.metrics).toMatchObject({
      dpeClass: "C",
      dpeSource: "listing",
      energyRenovationEur: 0,
    });
  });

  it("choisit l'agrégat selon le type du bien : Maison pour une maison, aucun pour un autre type", () => {
    const aggregates = { Maison: { ...AGGREGATE, sales12Months: 7 }, Appartement: AGGREGATE };
    const house = buildPepiteInput(
      source({
        sale: sale({ property_type: "house" }),
        v12: v12({ marketAggregates: aggregates }),
      }),
      "pepite-v1.2",
    ).input;
    expect(house.market).toEqual({ propertyType: "Maison", aggregate: aggregates.Maison });
    const apartment = buildPepiteInput(
      source({ v12: v12({ marketAggregates: aggregates }) }),
      "pepite-v1.2",
    ).input;
    expect(apartment.market?.aggregate).toBe(aggregates.Appartement);
    const other = buildPepiteInput(
      source({
        sale: sale({ property_type: "commercial" }),
        v12: v12({ marketAggregates: aggregates }),
      }),
      "pepite-v1.2",
    ).input;
    expect(other.market).toEqual({ propertyType: null, aggregate: null });
  });

  it("note l'absence d'agrégat sans exclure la vente, et exclut un marché peu liquide", () => {
    const absent = evaluateSaleForPepite(
      source({ v12: v12({ marketAggregates: {} }) }),
      "pepite-v1.2",
    ).evaluation;
    expect(absent.passed).toEqual(
      expect.arrayContaining(["market_liquid", "market_not_declining"]),
    );
    expect(absent.metrics.market).toMatchObject({ aggregateAbsent: true });
    const thin = evaluateSaleForPepite(
      source({
        v12: v12({ marketAggregates: { Appartement: { ...AGGREGATE, sales12Months: 4 } } }),
      }),
      "pepite-v1.2",
    ).evaluation;
    expect(thin.missed).toContain("market_liquid");
    expect(thin.favorable).toBe(false);
  });

  it("écarte un bien de plus de 250 m2 habitables", () => {
    const evaluation = evaluateSaleForPepite(
      source({ sale: sale({ app_surface_m2: 300 }) }),
      "pepite-v1.2",
    ).evaluation;
    expect(evaluation.metrics.habitableSurfaceM2).toBe(300);
    expect(evaluation.missed).toContain("size_value_supported");
  });

  it("une pièce lue qui mentionne un plan de sauvegarde bloque la vente et garde la mention dans les faits", () => {
    const { evaluation, facts } = evaluateSaleForPepite(
      source({
        v12: v12({
          readingPoints: [point("La copropriété fait l'objet d'un plan de sauvegarde.")],
        }),
      }),
      "pepite-v1.2",
    );
    expect(evaluation.missed).toContain("no_copro_distress");
    expect(evaluation.blocking).toBe(true);
    expect(evaluation.status).toBe("not_pepite");
    expect(facts.coproDistress).toEqual(["plan_de_sauvegarde"]);
  });

  it("« carence d'enchères » et un point d'un autre thème ne bloquent pas", () => {
    const { evaluation, facts } = evaluateSaleForPepite(
      source({
        v12: v12({
          readingPoints: [
            point("Procès-verbal de carence d’enchères au premier tour."),
            point("Administrateur provisoire de la société venderesse", "juridique"),
          ],
        }),
      }),
      "pepite-v1.2",
    );
    expect(evaluation.passed).toContain("no_copro_distress");
    expect(evaluation.blocking).toBe(false);
    expect(facts.coproDistress).toEqual([]);
  });
});

describe("pepite-v1.2 : badges", () => {
  const rich = { source: "anil_commune", reliability: "reliable", rentPerM2: 30 } as never;

  it("donne « double sortie » à partir de 8 % de rendement brut, sans toucher à l'évaluation ni à is_pepite", () => {
    const plain = evaluateSaleForPepite(source(), "pepite-v1.2");
    const withRent = evaluateSaleForPepite(source({ v12: v12({ rent: rich }) }), "pepite-v1.2");
    // 62 m2 x 30 EUR = 1 860 EUR par mois, 22 320 par an, pour un coût total proche de 100 000 EUR.
    expect(plain.facts.badges).toEqual([]);
    expect(withRent.facts.badges).toHaveLength(1);
    expect(withRent.facts.badges?.[0]).toMatchObject({
      key: "double_exit",
      label: "Double sortie",
      monthlyRentEur: 1_860,
      rentSource: "anil_commune",
    });
    expect(withRent.facts.badges?.[0].grossYieldPct).toBeGreaterThanOrEqual(8);
    // Les badges sont calculés après la règle : l'évaluation est identique, bit pour bit.
    expect(withRent.evaluation).toEqual(plain.evaluation);
    expect(comparable(withRent.input)).toEqual(comparable(plain.input));
  });

  it("ne donne pas le badge sous 8 %, ni sans loyer ANIL, ni pour un bien qui n'est pas un logement", () => {
    const poor = { source: "anil_commune", reliability: "reliable", rentPerM2: 8 } as never;
    const department = {
      source: "department_estimate",
      reliability: "indicative",
      rentPerM2: 40,
    } as never;
    expect(
      evaluateSaleForPepite(source({ v12: v12({ rent: poor }) }), "pepite-v1.2").facts.badges,
    ).toEqual([]);
    expect(
      evaluateSaleForPepite(source({ v12: v12({ rent: department }) }), "pepite-v1.2").facts.badges,
    ).toEqual([]);
    expect(
      evaluateSaleForPepite(
        source({ sale: sale({ property_type: "land" }), v12: v12({ rent: rich }) }),
        "pepite-v1.2",
      ).facts.badges,
    ).toEqual([]);
  });
});

describe("pepite-v2.1 : v1.2 plus l'inondation", () => {
  it("applique les entrées de la v1.2 et garde le verdict d'inondation dans les faits", () => {
    const { input, facts, evaluation } = evaluateSaleForPepite(
      source({ v12: v12({ listingDpeClass: "G" }) }),
      "pepite-v2.1",
    );
    expect(input.energy).toEqual({ dpeClass: "G", dpeSource: "listing" });
    expect(facts.flood).toMatchObject({ verdict: "none_found" });
    expect(facts.badges).toEqual([]);
    expect(evaluation.ruleVersion).toBe("pepite-v2.1");
    expect(evaluation.passed).toContain("flood_risk_known");
    const high = evaluateSaleForPepite(
      source({
        flood: { verdict: "high", observedAt: null, mapDate: null, ppriChecked: true },
      }),
      "pepite-v2.1",
    ).evaluation;
    expect(high.blocking).toBe(true);
  });
});

describe("pepite-v1, v1.1 et v2 : rien de la v1.2 n'entre dans l'entrée ni dans le résultat", () => {
  const hostile = v12({
    listingDpeClass: "G",
    readingPoints: [point("administrateur provisoire")],
    marketAggregates: { Appartement: { ...AGGREGATE, sales12Months: 0 } },
    rent: { source: "anil_commune", reliability: "reliable", rentPerM2: 50 } as never,
  });
  const versions: PepiteRuleVersion[] = ["pepite-v1", "pepite-v1.1", "pepite-v2"];

  for (const version of versions) {
    it(`${version} : mêmes entrées, mêmes faits (hors lectures v1.2) et même évaluation`, () => {
      const without = evaluateSaleForPepite(source({ v12: undefined }), version);
      const withHostile = evaluateSaleForPepite(source({ v12: hostile }), version);
      expect(withHostile.evaluation).toEqual(without.evaluation);
      expect(comparable(withHostile.input)).toEqual(comparable(without.input));
      expect(withHostile.facts).toEqual(without.facts);
      for (const key of ["energy", "market", "habitableSurfaceM2"]) {
        expect(Object.keys(withHostile.input)).not.toContain(key);
      }
      expect(Object.keys(withHostile.input.signals)).not.toContain("coproDistress");
      expect(withHostile.facts.badges).toBeUndefined();
      expect(withHostile.facts.coproDistress).toBeUndefined();
    });
  }
});
