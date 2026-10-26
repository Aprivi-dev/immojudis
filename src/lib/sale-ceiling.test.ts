import { describe, expect, it } from "vitest";
import { buildCeilingHypotheses, type CeilingUserChoices } from "@/lib/bid-ceiling-defaults";
import { computeCeilingPlan } from "@/lib/bid-ceiling-engine";
import { saleForAiReviewDisplay } from "@/lib/ai-review-display";
import {
  getAiReviewFieldResult,
  AI_REVIEW_SURFACE_FIELD_KEYS,
  type AiReviewProjectionReadModel,
  type AiReviewRequestStatus,
} from "@/lib/ai-review-guard";
import { listingValuationConflict } from "@/lib/listing-evidence";
import type { CeilingMarketEstimate } from "@/lib/market-estimate-ceiling";
import { DEFAULT_OPEN_FEE_REGIMES } from "@/lib/fee-regime";
import {
  buildCeilingSnapshot,
  NO_CEILING_REGIME_REASON,
} from "@/lib/property-report/ceiling-snapshot";
import { computeAcquisitionCosts } from "@/lib/profitability";
import { assessSaleCeilingInputs, computeSaleCeiling } from "@/lib/sale-ceiling";
import { getMarketValuationSurfaces } from "@/lib/surface";
import type { AuctionSale } from "@/lib/types";

function sale(overrides: Record<string, unknown> = {}): AuctionSale {
  return {
    id: "sale-ceiling",
    sale_venue_type: "tribunal",
    department: "33",
    property_type: "apartment",
    app_surface_m2: 62,
    app_surface_kind: "habitable",
    starting_price_eur: 60_000,
    occupancy_status: "vacant",
    description: "Appartement libre. Les frais préalables s’élèvent à 4 250 € TTC.",
    ...overrides,
  } as unknown as AuctionSale;
}

function estimate(value: number, surface: number): CeilingMarketEstimate {
  return {
    source: "DVF normalisé",
    sourceUpdatedAt: null,
    subjectSurfaceEstimated: false,
    estimatedValueEur: value,
    actionable: true,
    qualityLabel: "forte",
    sampleSize: 25,
    effectiveSampleSize: 25,
    medianPricePerM2: Math.round(value / surface),
    p75PricePerM2: Math.round((value / surface) * 1.15),
  } as unknown as CeilingMarketEstimate;
}

function blockedPrice(): AiReviewProjectionReadModel[] {
  return [
    {
      auction_sale_id: "sale-ceiling",
      field_key: "sale.starting_price_eur",
      review_state: "unresolved",
      citation_status: "not_required",
      is_publishable: false,
      source_name: "test",
      source_url: null,
    },
  ];
}

/**
 * Le calcul tel que `SimplifiedSaleDetailView` l'écrivait avant `computeSaleCeiling` : recopié ici
 * pour que le test garde la parité avec l'ancienne chaîne, indépendamment du code partagé.
 */
function legacyViewCeiling({
  sale: raw,
  estimate: marketEstimate,
  choices = {},
  projections = null,
  status = "disabled",
  fullData = true,
  ceilingVenue = true,
}: {
  sale: AuctionSale;
  estimate: CeilingMarketEstimate | null;
  choices?: CeilingUserChoices;
  projections?: readonly AiReviewProjectionReadModel[] | null;
  status?: AiReviewRequestStatus;
  fullData?: boolean;
  ceilingVenue?: boolean;
}) {
  const displaySale = saleForAiReviewDisplay(raw, projections, status);
  const valuationConflict = listingValuationConflict(raw);
  const blocked = (key: Parameters<typeof getAiReviewFieldResult>[1]) =>
    getAiReviewFieldResult(projections, key, status).blocked;
  const critical =
    blocked("sale.starting_price_eur") ||
    AI_REVIEW_SURFACE_FIELD_KEYS.some((key) => blocked(key)) ||
    blocked("property.property_type") ||
    blocked("property.rooms_count");
  const surface = critical ? null : getMarketValuationSurfaces(displaySale).builtSurfaceM2;
  const enabled = fullData && ceilingVenue && !valuationConflict && !critical;
  const built = buildCeilingHypotheses(displaySale, enabled ? marketEstimate : null, choices);
  const hypotheses = { ...built, surface: enabled ? surface : null };
  return { enabled, hypotheses, plan: computeCeilingPlan(hypotheses) };
}

const CHOICES: CeilingUserChoices[] = [
  {},
  { project: "louer" },
  { project: "revendre", profile: "offensif", works: { key: "confort", amount: 33_000 } },
  { works: { key: "devis", amount: 160_000 }, occupation: "occupe" },
];

const SALES = [
  { name: "33, appartement libre", sale: sale(), value: 220_000 },
  {
    name: "36, maison occupée",
    sale: sale({
      department: "36",
      property_type: "house",
      app_surface_m2: 110,
      starting_price_eur: 25_000,
      occupancy_status: "occupied",
      description: "Maison occupée.",
    }),
    value: 120_000,
  },
  {
    name: "75, studio loué",
    sale: sale({
      department: "75",
      app_surface_m2: 45,
      starting_price_eur: 150_000,
      occupancy_status: "rented",
    }),
    value: 420_000,
  },
];

describe("computeSaleCeiling : parité avec l'ancien calcul de la fiche", () => {
  for (const { name, sale: item, value } of SALES) {
    const market = estimate(value, item.app_surface_m2 ?? 50);
    it.each(CHOICES)(`${name}, choix %j`, (choices) => {
      const expected = legacyViewCeiling({ sale: item, estimate: market, choices });
      const actual = computeSaleCeiling({
        sale: item,
        estimate: market,
        aiProjections: null,
        aiReviewStatus: "disabled",
        choices,
      });

      expect(actual.enabled).toBe(true);
      expect(actual.regime?.key).toBe("tribunal");
      expect(actual.plan).toEqual(expected.plan);
      // Les hypothèses ne diffèrent que par le régime attaché et son barème.
      const { regime, ...hypotheses } = actual.hypotheses;
      expect(regime?.key).toBe("tribunal");
      expect({
        ...hypotheses,
        fees: { ...hypotheses.fees, emolumentBrackets: undefined },
      }).toEqual({
        ...expected.hypotheses,
        fees: { ...expected.hypotheses.fees, emolumentBrackets: undefined },
      });
    });
  }

  it("ne chiffre aucun plafond pour une vente domaniale ou de type inconnu, même avec tous les régimes listés", () => {
    for (const venue of ["state", "online", "unknown"]) {
      const item = sale({ sale_venue_type: venue });
      const market = estimate(220_000, 62);
      const expected = legacyViewCeiling({
        sale: item,
        estimate: market,
        ceilingVenue: false,
      });
      const actual = computeSaleCeiling({
        sale: item,
        estimate: market,
        aiProjections: null,
        aiReviewStatus: "disabled",
        // Les ventes domaniales n'ont pas de régime : les ouvrir n'y change rien.
        regimes: ["tribunal", "notary_auction", "notary_online", "state_auction"],
      });
      expect(actual.regime).toBeNull();
      expect(actual.enabled).toBe(false);
      expect(actual.plan).toEqual(expected.plan);
      expect(actual.plan.available).toBe(false);
    }
  });

  it.each([
    ["notarial_auction", "notary_auction", "Enchère plafond (simulation)"],
    ["online_tender", "notary_online", "Offre plafond (simulation)"],
  ])(
    "chiffre le plafond d'une vente notariale dont la procédure est %s (régime %s)",
    (procedure, key, label) => {
      const item = sale({
        sale_venue_type: "notary",
        sale_conditions: { procedure },
        description: "Appartement libre.",
      });
      const actual = computeSaleCeiling({
        sale: item,
        estimate: estimate(220_000, 62),
        aiProjections: null,
        aiReviewStatus: "disabled",
      });
      expect(actual.regime?.key).toBe(key);
      expect(actual.regime?.labels.ceilingSimulationLabel).toBe(label);
      expect(actual.enabled).toBe(true);
      expect(actual.plan.available).toBe(true);
      expect(actual.plan.reachable).toBe(true);
    },
  );

  it("ne chiffre aucun plafond d'une vente notariale dont le mode est inconnu (compte Découverte)", () => {
    for (const conditions of [null, {}, { price_nature: "displayed_price" }]) {
      const actual = computeSaleCeiling({
        sale: sale({ sale_venue_type: "notary", sale_conditions: conditions }),
        estimate: estimate(220_000, 62),
        aiProjections: null,
        aiReviewStatus: "disabled",
      });
      expect(actual.regime).toBeNull();
      expect(actual.enabled).toBe(false);
      expect(actual.plan.available).toBe(false);
    }
  });

  it("ferme la vente notariale quand son régime n'est pas ouvert", () => {
    const item = sale({
      sale_venue_type: "notary",
      sale_conditions: { procedure: "online_tender" },
    });
    const base = {
      sale: item,
      estimate: estimate(220_000, 62),
      aiProjections: null,
      aiReviewStatus: "disabled" as const,
    };
    expect(computeSaleCeiling({ ...base, regimes: ["tribunal", "notary_auction"] }).enabled).toBe(
      false,
    );
    expect(computeSaleCeiling({ ...base, regimes: ["tribunal", "notary_online"] }).enabled).toBe(
      true,
    );
    expect(computeSaleCeiling(base).enabled).toBe(true);
  });

  it("ne chiffre rien quand la vente n'est pas lue en entier", () => {
    const market = estimate(220_000, 62);
    const expected = legacyViewCeiling({ sale: sale(), estimate: market, fullData: false });
    const actual = computeSaleCeiling({
      sale: sale(),
      estimate: market,
      aiProjections: null,
      aiReviewStatus: "disabled",
      fullData: false,
    });
    expect(actual.enabled).toBe(false);
    expect(actual.plan).toEqual(expected.plan);
  });

  it("suspend le plafond en cas de conflit de valorisation", () => {
    const item = sale({
      property_type: "land",
      source_blocks: { titre_detail: "Un appartement de 62 m²" },
    });
    const market = estimate(220_000, 62);
    const actual = computeSaleCeiling({
      sale: item,
      estimate: market,
      aiProjections: null,
      aiReviewStatus: "disabled",
    });
    expect(actual.valuationConflict).toMatch(/Type de bien contradictoire/);
    expect(actual.enabled).toBe(false);
    expect(actual.plan).toEqual(legacyViewCeiling({ sale: item, estimate: market }).plan);
  });

  it("bloque le plafond quand la relecture IA bloque un champ critique", () => {
    const market = estimate(220_000, 62);
    const projections = blockedPrice();
    const expected = legacyViewCeiling({
      sale: sale(),
      estimate: market,
      projections,
      status: "ready",
    });
    const actual = computeSaleCeiling({
      sale: sale(),
      estimate: market,
      aiProjections: projections,
      aiReviewStatus: "ready",
    });
    expect(actual.blocked).toMatchObject({ price: true, critical: true, surface: false });
    expect(actual.surface).toBeNull();
    expect(actual.enabled).toBe(false);
    expect(actual.plan).toEqual(expected.plan);
    // La vente d'affichage n'a plus le prix bloqué.
    expect(actual.displaySale.starting_price_eur).toBeNull();
  });

  it.each(["loading", "error", "disabled", "ready"] as const)(
    "reste à parité avec l'ancien calcul quand la lecture de la relecture IA est %s",
    (status) => {
      const market = estimate(220_000, 62);
      const projections = blockedPrice();
      const expected = legacyViewCeiling({ sale: sale(), estimate: market, projections, status });
      const actual = computeSaleCeiling({
        sale: sale(),
        estimate: market,
        aiProjections: projections,
        aiReviewStatus: status,
      });
      expect(actual.enabled).toBe(expected.enabled);
      expect(actual.plan).toEqual(expected.plan);
      expect(actual.hypotheses.surface).toBe(expected.hypotheses.surface);
    },
  );

  it.each([
    ["sale.starting_price_eur", "price"],
    ["property.habitable_surface_m2", "surface"],
    ["property.carrez_surface_m2", "surface"],
    ["property.land_surface_m2", "surface"],
    ["property.property_type", "propertyType"],
    ["property.rooms_count", "rooms"],
  ] as const)("bloque le plafond quand la relecture IA bloque %s", (fieldKey, flag) => {
    const market = estimate(220_000, 62);
    const projections = [{ ...blockedPrice()[0], field_key: fieldKey }];
    const expected = legacyViewCeiling({
      sale: sale(),
      estimate: market,
      projections,
      status: "ready",
    });
    const actual = computeSaleCeiling({
      sale: sale(),
      estimate: market,
      aiProjections: projections,
      aiReviewStatus: "ready",
    });
    expect(actual.blocked[flag]).toBe(true);
    expect(actual.blocked.critical).toBe(true);
    expect(actual.enabled).toBe(false);
    expect(actual.surface).toBeNull();
    expect(actual.plan).toEqual(expected.plan);
    expect(actual.plan.available).toBe(false);
  });

  it("ne garde rien d'un champ non critique bloqué (occupation)", () => {
    const market = estimate(220_000, 62);
    const projections = [{ ...blockedPrice()[0], field_key: "property.occupancy_status" }];
    const actual = computeSaleCeiling({
      sale: sale(),
      estimate: market,
      aiProjections: projections,
      aiReviewStatus: "ready",
    });
    expect(actual.blocked.critical).toBe(false);
    expect(actual.enabled).toBe(true);
  });

  it("accepte le résultat de assessSaleCeilingInputs déjà calculé", () => {
    const item = sale();
    const source = { sale: item, aiProjections: null, aiReviewStatus: "disabled" as const };
    const assessed = assessSaleCeilingInputs(source);
    const market = estimate(220_000, 62);
    expect(computeSaleCeiling({ ...source, estimate: market, assessed })).toEqual(
      computeSaleCeiling({ ...source, estimate: market }),
    );
  });
});

const ALL_OPEN = [...DEFAULT_OPEN_FEE_REGIMES];

describe("buildCeilingSnapshot : même chaîne que la fiche", () => {
  it.each(SALES.flatMap((item) => CHOICES.map((choices) => [item.name, item, choices] as const)))(
    "%s : le rapport et la fiche affichent le même plafond (%j)",
    (_name, item, choices) => {
      const market = estimate(item.value, item.sale.app_surface_m2 ?? 50);
      const snapshot = buildCeilingSnapshot(item.sale, market as never, choices, ALL_OPEN);
      const view = computeSaleCeiling({
        sale: item.sale,
        estimate: market,
        aiProjections: null,
        aiReviewStatus: "disabled",
        choices,
      });
      const legacy = legacyViewCeiling({ sale: item.sale, estimate: market, choices });

      const available = view.plan.available && view.plan.reachable;
      expect(snapshot.available).toBe(available);
      expect(snapshot.maxBid).toBe(available ? view.plan.maxBid : null);
      expect(snapshot.maxBid).toBe(
        legacy.plan.available && legacy.plan.reachable ? legacy.plan.maxBid : null,
      );
      expect(snapshot.steps).toEqual(
        view.plan.steps.map(({ key, label, amount, kind }) => ({ key, label, amount, kind })),
      );
      expect(snapshot.acquisition).toEqual(
        computeAcquisitionCosts({
          price: Math.max(0, item.sale.starting_price_eur ?? 0),
          works: legacy.hypotheses.works.amount,
          ...legacy.hypotheses.fees,
        }),
      );
    },
  );

  it("guarded: false calcule le plafond d'une vente non tribunal comme avant, sans régime", () => {
    for (const venue of ["notary", "state", "unknown"]) {
      const item = sale({ sale_venue_type: venue });
      const market = estimate(220_000, 62);
      const actual = computeSaleCeiling({
        sale: item,
        estimate: market,
        aiProjections: null,
        aiReviewStatus: "disabled",
        guarded: false,
      });
      const legacy = computeCeilingPlan(buildCeilingHypotheses(item, market));
      expect(actual.regime).toBeNull();
      expect(actual.enabled).toBe(true);
      expect(actual.hypotheses.regime).toBeUndefined();
      expect(actual.plan).toEqual(legacy);
    }
  });

  it("ne sauve aucun plafond pour une vente sans régime (domaniale, mode notarial inconnu)", () => {
    const market = estimate(220_000, 62);
    for (const item of [
      sale({ sale_venue_type: "state" }),
      sale({ sale_venue_type: "unknown" }),
      sale({ sale_venue_type: "notary" }),
      sale({ sale_venue_type: "notary", sale_conditions: { price_nature: "displayed_price" } }),
    ]) {
      const snapshot = buildCeilingSnapshot(item, market as never, {}, ALL_OPEN);
      expect(snapshot.available).toBe(false);
      expect(snapshot.reason).toBe(NO_CEILING_REGIME_REASON);
      expect(snapshot.maxBid).toBeNull();
      expect(snapshot.maxBidWithoutWorks).toBeNull();
      expect(snapshot.targetTotalCost).toBeNull();
      expect(snapshot.steps).toEqual([]);
      expect(snapshot.regime).toBeNull();
      expect(snapshot.estimatedFees).toEqual([]);
    }
  });

  it("ne sauve aucun plafond quand le régime de la vente est fermé sur le serveur", () => {
    const market = estimate(220_000, 62);
    const item = sale({
      sale_venue_type: "notary",
      sale_conditions: { procedure: "online_tender" },
    });
    const open = buildCeilingSnapshot(item, market as never, {}, ALL_OPEN);
    expect(open.available).toBe(true);
    expect(open.regime).toBe("notary_online");
    expect(open.label).toBe("Offre plafond (simulation)");
    expect(open.reserveNotice).toBe(
      "Le vendeur n’est pas tenu de retenir la meilleure offre ; prix de réserve inconnu.",
    );
    expect(open.scopeNote).toBe("Hors débours et formalités du notaire.");
    const closed = buildCeilingSnapshot(item, market as never, {}, ["tribunal"]);
    expect(closed.available).toBe(false);
    expect(closed.reason).toBe(NO_CEILING_REGIME_REASON);
    expect(closed.maxBid).toBeNull();
    // Le tribunal reste ouvert quoi qu'il arrive.
    expect(buildCeilingSnapshot(sale(), market as never, {}, ["notary_online"]).available).toBe(
      true,
    );
  });

  it("garde « Enchère plafond (simulation) » pour le tribunal et la bougie", () => {
    const market = estimate(220_000, 62);
    expect(buildCeilingSnapshot(sale(), market as never, {}, ALL_OPEN).label).toBe(
      "Enchère plafond (simulation)",
    );
    const auction = sale({
      sale_venue_type: "notary",
      sale_conditions: { procedure: "notarial_auction" },
    });
    const snapshot = buildCeilingSnapshot(auction, market as never, {}, ALL_OPEN);
    expect(snapshot.label).toBe("Enchère plafond (simulation)");
    expect(snapshot.regime).toBe("notary_auction");
    expect(snapshot.reserveNotice).toBeNull();
  });
});
