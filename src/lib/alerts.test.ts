import { describe, expect, it } from "vitest";
import { alertMatchesSale, departmentFromSearchQuery, isHouseWithLand } from "@/lib/alerts";
import type { AuctionSale, UserWatchedZone } from "@/lib/types";

type AlertCriteria = Parameters<typeof alertMatchesSale>[0];

function makeSale(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
    id: "sale-1",
    title: "Maison avec jardin",
    description: null,
    source_description: null,
    llm_display_description: null,
    about_description: null,
    city: "Bordeaux",
    department: "33",
    postal_code: null,
    address: null,
    tribunal: null,
    tribunal_code: null,
    tribunal_name: null,
    tribunal_city: null,
    property_type: "house",
    starting_price_eur: 100_000,
    sale_date: null,
    visit_dates: null,
    lawyer_name: null,
    lawyer_contact: null,
    adjudication_price_eur: null,
    latitude: null,
    longitude: null,
    occupancy_status: "free",
    habitable_surface_m2: 100,
    carrez_surface_m2: null,
    land_surface_m2: 220,
    app_surface_m2: 100,
    app_surface_kind: null,
    surface_scope: null,
    surface_source: null,
    surface_confidence: null,
    surface_evidence: null,
    rooms_count: 4,
    bedrooms_count: 3,
    bathrooms_count: 1,
    parking_count: null,
    has_garden: true,
    has_terrace: null,
    has_garage: null,
    has_pool: null,
    has_air_conditioning: null,
    has_double_glazing: null,
    investment_score: 82,
    investment_summary: null,
    score_version: null,
    score_confidence: null,
    score_factors: null,
    risk_notes: null,
    source_name: null,
    source_url: null,
    primary_source: null,
    source_urls: null,
    source_blocks: { dpe_classe: "B" },
    source_blocks_by_source: null,
    dedupe_confidence: null,
    quality_flags: null,
    documents: null,
    documents_rich: [],
    media: null,
    risks: null,
    status: "active",
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

function makeAlert(overrides: Partial<AlertCriteria> = {}): AlertCriteria {
  return {
    city: "Bordeaux",
    department: "33",
    property_type: "house",
    max_price_eur: 150_000,
    min_surface_m2: 80,
    occupancy_status: "free",
    min_investment_score: 70,
    max_price_per_m2: 1_500,
    min_yield_pct: 10,
    min_market_discount_pct: 20,
    dpe_classes: ["B"],
    require_house_with_land: true,
    ...overrides,
  };
}

function makeWatchedZone(overrides: Partial<UserWatchedZone> = {}): UserWatchedZone {
  return {
    id: "zone-1",
    user_id: "user-1",
    name: "Bordeaux centre",
    zone_kind: "radius",
    department: "33",
    city: null,
    postal_code_prefix: null,
    center_lat: 44.8378,
    center_lng: -0.5792,
    radius_km: 8,
    alert_defaults: {},
    is_active: true,
    created_at: "2026-07-06T10:00:00.000Z",
    updated_at: "2026-07-06T10:00:00.000Z",
    ...overrides,
  };
}

describe("alert yield criterion", () => {
  const sale = makeSale({
    department: "23",
    starting_price_eur: 100_000,
    app_surface_m2: 50,
    app_surface_kind: "habitable",
  });
  const alert = makeAlert({
    city: null,
    department: null,
    property_type: null,
    max_price_eur: null,
    min_surface_m2: null,
    occupancy_status: null,
    min_investment_score: null,
    max_price_per_m2: null,
    min_market_discount_pct: null,
    dpe_classes: [],
    require_house_with_land: false,
    min_yield_pct: 6,
  });
  const reference = (rentPerM2: number) => ({
    rentPerM2,
    source: "anil_commune" as const,
    reliability: "reliable" as const,
    segment: "apt_all" as const,
    communeCode: "23096",
    lowPerM2: null,
    highPerM2: null,
    observations: 100,
    vintage: 2025,
    sourceUpdatedOn: "2025-12-11",
  });

  it("measures the yield with the commune rent of the context", () => {
    // 50 m² x 12 EUR x 12 months = 7 200 EUR a year over about 112 000 EUR of total cost: above 6 %.
    expect(alertMatchesSale(alert, sale, { rents: () => reference(12) })).toMatchObject({
      matches: true,
      reasons: expect.arrayContaining(["rendement"]),
    });
    // 6 EUR/m²: about 3 %.
    expect(alertMatchesSale(alert, sale, { rents: () => reference(6) }).matches).toBe(false);
  });

  it("gives no yield, so no match, to a property that is not a dwelling", () => {
    for (const property_type of ["land", "parking", "garage", "local commercial", "building"]) {
      const item = { ...sale, property_type, department: "33" };
      expect(
        alertMatchesSale(alert, item, { rents: () => reference(12) }).matches,
        property_type,
      ).toBe(false);
    }
  });

  it("keeps the department rent when no reference is given, and never invents one", () => {
    // Department 23 has no department rent: no yield, so no match.
    expect(alertMatchesSale(alert, sale).matches).toBe(false);
    expect(alertMatchesSale(alert, sale, { rents: () => null }).matches).toBe(false);
  });
});

describe("smart alert matching", () => {
  it("respects the saved sale family, including judicial-origin notarial sales", () => {
    const alert = makeAlert({ advanced_criteria: { sale_type: "notary" } });
    expect(
      alertMatchesSale(alert, makeSale({ sale_venue_type: "tribunal" }), { marketDiscountPct: 30 })
        .matches,
    ).toBe(false);
    expect(
      alertMatchesSale(
        alert,
        makeSale({ sale_venue_type: "notary", sale_legal_framework: "judicial_partition" }),
        { marketDiscountPct: 30 },
      ).matches,
    ).toBe(true);
  });

  it("matches a sale when all advanced criteria are satisfied", () => {
    const result = alertMatchesSale(makeAlert(), makeSale(), { marketDiscountPct: 28 });

    expect(result.matches).toBe(true);
    expect(result.reasons).toEqual(
      expect.arrayContaining(["prix au m²", "rendement", "DPE B", "terrain", "décote"]),
    );
  });

  it("rejects a sale when a house with land is required but absent", () => {
    const result = alertMatchesSale(
      makeAlert(),
      makeSale({
        title: "Maison de ville",
        property_type: "house",
        land_surface_m2: null,
        has_garden: false,
      }),
      { marketDiscountPct: 28 },
    );

    expect(isHouseWithLand(makeSale())).toBe(true);
    expect(result).toEqual({
      matches: false,
      reasons: ["maison avec terrain absente"],
    });
  });

  it("requires an explicit market discount context for discount alerts", () => {
    const result = alertMatchesSale(
      makeAlert({
        min_market_discount_pct: 25,
        require_house_with_land: false,
      }),
      makeSale(),
    );

    expect(result).toEqual({
      matches: false,
      reasons: ["décote marché insuffisante"],
    });
  });

  it("adds the watched zone to successful alert reasons", () => {
    const result = alertMatchesSale(
      makeAlert({ min_market_discount_pct: null }),
      makeSale({
        latitude: 44.84,
        longitude: -0.58,
      }),
      { watchedZone: makeWatchedZone() },
    );

    expect(result.matches).toBe(true);
    expect(result.reasons).toContain("rayon Bordeaux centre");
  });

  it("rejects a sale outside the watched zone", () => {
    const result = alertMatchesSale(
      makeAlert({ min_market_discount_pct: null }),
      makeSale({
        latitude: 45.764,
        longitude: 4.8357,
      }),
      { watchedZone: makeWatchedZone() },
    );

    expect(result).toEqual({
      matches: false,
      reasons: ["hors zone surveillée"],
    });
  });
});

it("rejects an alert match outside the saved local sale-date range", () => {
  const alert = makeAlert({
    advanced_criteria: { min_sale_date: "2026-09-11", max_sale_date: "2026-09-30" },
  });
  expect(alertMatchesSale(alert, makeSale({ sale_date: "2026-10-01T08:00:00Z" }))).toEqual({
    matches: false,
    reasons: ["vente hors période"],
  });
});

describe("recherche texte enregistrée dans l'alerte (query)", () => {
  const open = {
    department: null,
    max_price_eur: null,
    min_surface_m2: null,
    occupancy_status: null,
    min_investment_score: null,
    max_price_per_m2: null,
    min_yield_pct: null,
    min_market_discount_pct: null,
    dpe_classes: [],
    require_house_with_land: false,
    property_type: null,
  } satisfies Partial<AlertCriteria>;
  const alertWithQuery = (query: unknown) =>
    makeAlert({ ...open, advanced_criteria: { source: "sales_search", query } });
  const matches = (query: unknown, sale: Partial<AuctionSale>) =>
    alertMatchesSale(alertWithQuery(query), makeSale(sale)).matches;

  it("traite un code de département comme un filtre département", () => {
    expect(matches("26", { department: "26" })).toBe(true);
    expect(alertMatchesSale(alertWithQuery("26"), makeSale({ department: "33" }))).toEqual({
      matches: false,
      reasons: ["secteur différent"],
    });
  });

  it("couvre les codes à zéro initial, corses et d'outre-mer", () => {
    expect(matches("07", { department: "07" })).toBe(true);
    expect(matches("07", { department: "74" })).toBe(false);
    expect(matches("2A", { department: "2A" })).toBe(true);
    expect(matches("974", { department: "974" })).toBe(true);
    expect(matches("974", { department: "33" })).toBe(false);
  });

  it("accepte le nom du département et un code postal", () => {
    expect(matches("Drôme", { department: "26" })).toBe(true);
    expect(matches("33000", { postal_code: "33000" })).toBe(true);
    expect(matches("33000", { postal_code: "75001" })).toBe(false);
  });

  it("lit une liste de départements comme chacun de ces départements", () => {
    expect(matches("66, 65, 05", { department: "65" })).toBe(true);
    expect(matches("66, 65, 05", { department: "05" })).toBe(true);
    expect(matches("66, 65, 05", { department: "33" })).toBe(false);
  });

  it("n'enregistre comme département de l'alerte qu'un seul département", () => {
    expect(departmentFromSearchQuery("26")).toBe("26");
    expect(departmentFromSearchQuery("Drôme")).toBe("26");
    // La liste reste dans le texte enregistré, que l'évaluation lit comme ces trois départements.
    expect(departmentFromSearchQuery("66, 65, 05")).toBeNull();
  });

  it("n'écarte rien pour une requête vide ou un texte libre", () => {
    for (const query of [null, "", "  ", "jardin piscine", 12]) {
      expect(matches(query, {})).toBe(true);
    }
  });
});

describe("alerte « Seulement les pépites »", () => {
  const pepiteAlert = (overrides: Partial<AlertCriteria> = {}) =>
    makeAlert({
      city: null,
      department: null,
      property_type: null,
      max_price_eur: null,
      min_surface_m2: null,
      occupancy_status: null,
      min_investment_score: null,
      max_price_per_m2: null,
      min_yield_pct: null,
      min_market_discount_pct: null,
      dpe_classes: [],
      require_house_with_land: false,
      advanced_criteria: { pepite_only: true },
      ...overrides,
    });

  it("ne retient que les ventes de la liste publique des pépites", () => {
    const pepiteSaleIds = new Set(["sale-1"]);
    const hit = alertMatchesSale(pepiteAlert(), makeSale({ id: "SALE-1" }), { pepiteSaleIds });
    expect(hit.matches).toBe(true);
    // Un mot, jamais un montant.
    expect(hit.reasons).toContain("pépite");
    expect(
      alertMatchesSale(pepiteAlert(), makeSale({ id: "sale-2" }), { pepiteSaleIds }).matches,
    ).toBe(false);
  });

  it("ne retient aucune vente quand la liste n'est pas fournie, jamais toutes", () => {
    expect(alertMatchesSale(pepiteAlert(), makeSale()).matches).toBe(false);
    expect(alertMatchesSale(pepiteAlert(), makeSale(), { pepiteSaleIds: null }).matches).toBe(
      false,
    );
  });

  it("n'agit pas sur une alerte qui ne le demande pas", () => {
    const plain = pepiteAlert({ advanced_criteria: {} });
    const result = alertMatchesSale(plain, makeSale(), { pepiteSaleIds: new Set() });
    expect(result.matches).toBe(true);
    expect(result.reasons).not.toContain("pépite");
  });

  it("se cumule avec les autres critères de l'alerte", () => {
    const pepiteSaleIds = new Set(["sale-1"]);
    expect(
      alertMatchesSale(pepiteAlert({ city: "Lyon" }), makeSale(), { pepiteSaleIds }).matches,
    ).toBe(false);
  });
});
