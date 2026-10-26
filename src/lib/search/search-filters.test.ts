import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANALYSIS_ONLY_SORT_KEYS,
  SORT_OPTIONS,
  applyClientSearchFilters,
  dataFiltersFromSearch,
  countActiveSearchFilters,
  countAlertableSearchFilters,
  dataSortFromSearch,
  hasClientOnlyFilters,
  hasUnalertableSearchFilters,
  saleIsInViewport,
  sortClientSearchResults,
  visibleSearchSort,
} from "./search-filters";
import type { ViewportBounds } from "./search-url-state";
import type { AuctionSale } from "@/lib/types";

describe("filtre « rendement minimal »", () => {
  const sale = {
    id: "sale-yield",
    department: "23",
    starting_price_eur: 100_000,
    app_surface_m2: 50,
    app_surface_kind: "habitable",
    source_blocks: null,
  } as unknown as AuctionSale;
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

  it("uses the commune rent that the server resolved", () => {
    const search = { minYield: 6 };

    expect(applyClientSearchFilters([sale], search, null, { rents: () => reference(12) })).toEqual([
      sale,
    ]);
    expect(applyClientSearchFilters([sale], search, null, { rents: () => reference(6) })).toEqual(
      [],
    );
  });

  it("drops a property that is not a dwelling, whatever the rent", () => {
    const land = { ...sale, property_type: "land" } as AuctionSale;

    expect(
      applyClientSearchFilters([land], { minYield: 1 }, null, { rents: () => reference(40) }),
    ).toEqual([]);
  });

  it("falls back to the department rent, and drops a department without any reference", () => {
    const covered = { ...sale, department: "33" } as AuctionSale;

    // 14 EUR/m² in Gironde: about 7.5 % of the total cost.
    expect(applyClientSearchFilters([covered], { minYield: 6 }, null)).toEqual([covered]);
    expect(applyClientSearchFilters([sale], { minYield: 1 }, null)).toEqual([]);
  });
});

describe("filtre « visite dans les 7 jours »", () => {
  afterEach(() => vi.useRealTimers());

  const withVisit = (id: string, ...visit_dates: string[]) =>
    ({ id, visit_dates, source_blocks: null }) as unknown as AuctionSale;

  it("est un filtre du navigateur, compté parmi les filtres actifs", () => {
    expect(hasClientOnlyFilters({ visitSoon: true })).toBe(true);
    expect(countActiveSearchFilters({ visitSoon: true })).toBe(1);
    expect(hasClientOnlyFilters({})).toBe(false);
  });

  it("ne garde que les ventes dont une visite à date publiée tombe dans les 7 jours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T08:00:00Z"));
    const items = [
      withVisit("bientot", "2026-10-22 à 14:00"),
      withVisit("lointaine", "2026-11-12 à 14:00"),
      withVisit("sans-annee", "mardi 27 octobre"),
      withVisit("libre", "Sur rendez-vous"),
      withVisit("aucune"),
    ];
    expect(
      applyClientSearchFilters(items, { visitSoon: true }, null).map((item) => item.id),
    ).toEqual(["bientot"]);
    expect(applyClientSearchFilters(items, {}, null)).toHaveLength(5);
  });
});

describe("sales search filters", () => {
  it("filters the family on the server and consistently in derived local results", () => {
    expect(dataFiltersFromSearch({ saleType: "notary" })).toMatchObject({
      sale_venue_type: "notary",
    });
    expect(hasClientOnlyFilters({ saleType: "notary" })).toBe(false);
    expect(countActiveSearchFilters({ saleType: "notary" })).toBe(1);
    const items = ["tribunal", "notary", "state", "online", "unknown"].map(
      (type) => ({ id: type, sale_venue_type: type }) as AuctionSale,
    );
    expect(applyClientSearchFilters(items, { saleType: "notary" }, null).map((s) => s.id)).toEqual([
      "notary",
    ]);
    expect(applyClientSearchFilters(items, { saleType: "unknown" }, null).map((s) => s.id)).toEqual(
      ["online", "unknown"],
    );
  });

  it.each([
    [
      "Nouvelle-Aquitaine",
      { departments: ["16", "17", "19", "23", "24", "33", "40", "47", "64", "79", "86", "87"] },
    ],
    ["Gironde", { departments: ["33"] }],
    ["33", { departments: ["33"] }],
    ["33000", { postal_code: "33000" }],
    ["Bordeaux", { keywords: "Bordeaux" }],
  ])("turns the main query %s into the expected data filter", (query, expected) => {
    expect(dataFiltersFromSearch({ query })).toMatchObject(expected);
  });

  it("accepts a department name in the dedicated department filter", () => {
    expect(dataFiltersFromSearch({ department: "département de la Gironde" })).toMatchObject({
      departments: ["33"],
    });
  });

  it("keeps all free-text terms when advanced keywords are also present", () => {
    expect(dataFiltersFromSearch({ query: "Bordeaux", keywords: "maison jardin" })).toMatchObject({
      keywords: "Bordeaux maison jardin",
    });
  });

  it("passes viewport bounds to server-side filters", () => {
    const viewport: ViewportBounds = {
      east: 1.28,
      north: 45.43,
      south: 43.96,
      west: -1.75,
    };

    expect(dataFiltersFromSearch({ viewport })).toMatchObject({ viewport });
    expect(hasClientOnlyFilters({ viewport })).toBe(false);
  });

  it("ne balaye le catalogue pour le tri par distance que si une adresse est saisie", () => {
    expect(hasClientOnlyFilters({ sort: "distance" })).toBe(false);
    expect(hasClientOnlyFilters({ sort: "distance", aroundAddress: "10 rue de Rivoli" })).toBe(
      true,
    );
    // Sans centre, le tri client ne change pas l'ordre venu du serveur.
    const rows = [sale("b", 44.8, -0.5), sale("a", 43.8, 4.3)];
    expect(
      sortClientSearchResults(rows, { sort: "distance" }, null).map((item) => item.id),
    ).toEqual(["b", "a"]);
  });

  it("trie par chambres côté serveur, sans balayage du catalogue", () => {
    expect(dataSortFromSearch("beds_desc")).toBe("beds_desc");
    expect(hasClientOnlyFilters({ sort: "beds_desc" })).toBe(false);
    expect(hasClientOnlyFilters({ sort: "beds_desc", dpeClasses: ["A"] })).toBe(true);
  });

  it("« Mieux renseignées d’abord » classe par complétude, pour tous les publics", () => {
    for (const sort of [undefined, "relevance", "distance"] as const) {
      expect(dataSortFromSearch(sort)).toBe("completeness_desc");
      expect(dataSortFromSearch(sort, { allowInvestmentScore: true })).toBe("completeness_desc");
    }
  });

  it("réserve le score d'investissement à l'offre Analyse", () => {
    expect(dataSortFromSearch("score_desc", { allowInvestmentScore: true })).toBe("score_desc");
    // Visiteur ou Découverte arrivé avec cette valeur dans l'URL : tri par défaut.
    expect(dataSortFromSearch("score_desc")).toBe("completeness_desc");
    expect(dataSortFromSearch("score_desc", { allowInvestmentScore: false })).toBe(
      "completeness_desc",
    );
    expect(visibleSearchSort("score_desc")).toBe("relevance");
    expect(visibleSearchSort("score_desc", { allowInvestmentScore: true })).toBe("score_desc");
    expect(visibleSearchSort(undefined)).toBe("relevance");
    expect(visibleSearchSort("price_asc")).toBe("price_asc");
  });

  it("traduit chaque option de tri explicite", () => {
    expect(dataSortFromSearch("sale_date_asc")).toBe("date_asc");
    expect(dataSortFromSearch("newest")).toBe("date_desc");
    expect(dataSortFromSearch("price_asc")).toBe("price_asc");
    expect(dataSortFromSearch("price_desc")).toBe("price_desc");
    expect(dataSortFromSearch("sqft_desc")).toBe("surface_desc");
  });

  it("propose « Mieux renseignées d’abord » et un tri « Score d’investissement » réservé à Analyse", () => {
    expect(SORT_OPTIONS[0]).toEqual({ label: "Mieux renseignées d’abord", value: "relevance" });
    expect(SORT_OPTIONS).toContainEqual({ label: "Score d’investissement", value: "score_desc" });
    expect(ANALYSIS_ONLY_SORT_KEYS).toEqual(["score_desc"]);
  });

  it("filters visible sales when the map viewport changes", () => {
    const bordeauxViewport: ViewportBounds = {
      east: -0.1,
      north: 45.1,
      south: 44.5,
      west: -0.9,
    };
    const bordeauxSale = sale("bordeaux", 44.8378, -0.5792);
    const parisSale = sale("paris", 48.8566, 2.3522);
    const hiddenSale = sale("hidden", null, null);

    expect(saleIsInViewport(bordeauxSale, bordeauxViewport)).toBe(true);
    expect(saleIsInViewport(parisSale, bordeauxViewport)).toBe(false);
    expect(
      applyClientSearchFilters(
        [bordeauxSale, parisSale, hiddenSale],
        { viewport: bordeauxViewport },
        null,
      ).map((item) => item.id),
    ).toEqual(["bordeaux"]);
  });

  it("applies region, postal-code and accent-insensitive city searches on loaded results", () => {
    const bordeauxSale = {
      ...sale("bordeaux", 44.8378, -0.5792),
      city: "Bordeaux",
      department: "33",
      postal_code: "33000",
    };
    const nimesSale = {
      ...sale("nimes", 43.8367, 4.3601),
      city: "Nîmes",
      department: "30",
      postal_code: "30000",
    };

    expect(
      applyClientSearchFilters(
        [bordeauxSale, nimesSale],
        { query: "Nouvelle-Aquitaine" },
        null,
      ).map((item) => item.id),
    ).toEqual(["bordeaux"]);
    expect(
      applyClientSearchFilters([bordeauxSale, nimesSale], { query: "33000" }, null).map(
        (item) => item.id,
      ),
    ).toEqual(["bordeaux"]);
    expect(
      applyClientSearchFilters([bordeauxSale, nimesSale], { query: "Nimes" }, null).map(
        (item) => item.id,
      ),
    ).toEqual(["nimes"]);
  });
});

describe("filtres « sous la fourchette » et « sans point à vérifier »", () => {
  const NOW = new Date("2026-11-10T12:00:00Z");
  /** Vente à venir dont rien ne reste ouvert : surface, date, occupation connues. */
  const complete = (id: string, extra: Record<string, unknown> = {}) =>
    ({
      id,
      status: "upcoming",
      sale_date: "2026-12-10T09:00:00Z",
      app_surface_m2: 60,
      app_surface_kind: "habitable",
      occupancy_status: "vacant",
      sale_verification_status: "cross_checked",
      ...extra,
    }) as unknown as AuctionSale;
  const ids = (sales: AuctionSale[]) => sales.map((item) => item.id);

  it("se lisent sur les lignes déjà chargées : balayage complet, jamais côté catalogue", () => {
    expect(hasClientOnlyFilters({ belowRange: true })).toBe(true);
    expect(hasClientOnlyFilters({ noPointsToVerify: true })).toBe(true);
    expect(dataFiltersFromSearch({ belowRange: true, noPointsToVerify: true })).toEqual(
      dataFiltersFromSearch({}),
    );
  });

  it("comptent parmi les filtres actifs, mais pas parmi ceux d'une alerte", () => {
    expect(countActiveSearchFilters({ belowRange: true })).toBe(1);
    expect(countActiveSearchFilters({ belowRange: true, noPointsToVerify: true })).toBe(2);
    expect(countAlertableSearchFilters({ belowRange: true, noPointsToVerify: true })).toBe(0);
    expect(countAlertableSearchFilters({ city: "Pau", belowRange: true })).toBe(1);
    expect(hasUnalertableSearchFilters({ noPointsToVerify: true })).toBe(true);
    expect(hasUnalertableSearchFilters({ city: "Pau" })).toBe(false);
  });

  describe("pépites seulement", () => {
    const sales = [complete("pepite-1"), complete("autre"), complete("PEPITE-2")];

    it("ne garde que les ventes de la liste publique, sans tenir compte de la casse", () => {
      const pepiteSaleIds = new Set(["pepite-1", "pepite-2"]);
      expect(
        ids(applyClientSearchFilters(sales, { pepite: true }, null, { pepiteSaleIds })),
      ).toEqual(["pepite-1", "PEPITE-2"]);
    });

    it("ne passe aucune vente quand la liste n'a pas été lue, jamais toutes", () => {
      expect(ids(applyClientSearchFilters(sales, { pepite: true }, null))).toEqual([]);
      expect(
        ids(applyClientSearchFilters(sales, { pepite: true }, null, { pepiteSaleIds: null })),
      ).toEqual([]);
    });

    it("sans le filtre, la liste est ignorée", () => {
      expect(
        ids(applyClientSearchFilters(sales, {}, null, { pepiteSaleIds: new Set(["pepite-1"]) })),
      ).toEqual(["pepite-1", "autre", "PEPITE-2"]);
    });

    it("est un filtre lu sur les lignes, compté, et que les alertes savent enregistrer", () => {
      expect(hasClientOnlyFilters({ pepite: true })).toBe(true);
      expect(countActiveSearchFilters({ pepite: true })).toBe(1);
      expect(countAlertableSearchFilters({ pepite: true })).toBe(1);
      expect(hasUnalertableSearchFilters({ pepite: true })).toBe(false);
      // Ce n'est pas un tri : il ne change pas les filtres de données ni l'ordre par défaut.
      expect(dataFiltersFromSearch({ pepite: true })).toEqual(dataFiltersFromSearch({}));
      expect(dataSortFromSearch(undefined)).toBe("completeness_desc");
    });
  });

  describe("sous la fourchette", () => {
    const sales = [complete("under"), complete("near"), complete("occupied-under")];

    it("ne garde que les ventes que la base range sous la fourchette", () => {
      const underRangeSaleIds = new Set(["under"]);
      expect(
        ids(applyClientSearchFilters(sales, { belowRange: true }, null, { underRangeSaleIds })),
      ).toEqual(["under"]);
    });

    it("ne passe aucune vente quand la liste n'a pas été lue, jamais toutes", () => {
      expect(ids(applyClientSearchFilters(sales, { belowRange: true }, null))).toEqual([]);
      expect(
        ids(
          applyClientSearchFilters(sales, { belowRange: true }, null, { underRangeSaleIds: null }),
        ),
      ).toEqual([]);
    });

    it("écarte un bien occupé, loué ou occupé par son propriétaire, même listé", () => {
      const occupied = ["occupied", "rented", "owner_occupied", "Occupé par le propriétaire"].map(
        (status, index) => complete(`occ-${index}`, { occupancy_status: status }),
      );
      const underRangeSaleIds = new Set([...occupied.map((item) => item.id), "free"]);
      expect(
        ids(
          applyClientSearchFilters([...occupied, complete("free")], { belowRange: true }, null, {
            underRangeSaleIds,
          }),
        ),
      ).toEqual(["free"]);
    });

    it("garde un bien libre ou d'occupation inconnue ou non lue", () => {
      const underRangeSaleIds = new Set(["a", "b", "c"]);
      const candidates = [
        complete("a", { occupancy_status: "vacant" }),
        complete("b", { occupancy_status: "unknown" }),
        complete("c", { occupancy_status: undefined }),
      ];
      expect(
        ids(
          applyClientSearchFilters(candidates, { belowRange: true }, null, { underRangeSaleIds }),
        ),
      ).toEqual(["a", "b", "c"]);
    });

    it("se combine avec les autres filtres", () => {
      const underRangeSaleIds = new Set(["under", "near"]);
      const priced = [
        complete("under", { starting_price_eur: 50_000 }),
        complete("near", { starting_price_eur: 150_000 }),
      ];
      expect(
        ids(
          applyClientSearchFilters(priced, { belowRange: true, maxPrice: 100_000 }, null, {
            underRangeSaleIds,
          }),
        ),
      ).toEqual(["under"]);
    });
  });

  describe("sans point à vérifier", () => {
    const search = { noPointsToVerify: true };

    it("écarte une vente qui laisse un point ouvert, garde celle qui n'en laisse aucun", () => {
      const candidates = [
        complete("complete"),
        complete("no-surface", { app_surface_m2: null }),
        complete("no-date", { sale_date: null }),
        complete("conflict", { sale_verification_status: "conflict" }),
      ];
      expect(
        ids(
          applyClientSearchFilters(candidates, search, null, { occupancyVisible: true, now: NOW }),
        ),
      ).toEqual(["complete"]);
    });

    it("compte l'occupation inconnue seulement si le compte la lit, comme la carte", () => {
      const unknownOccupancy = complete("unknown-occupancy", { occupancy_status: null });
      expect(
        ids(
          applyClientSearchFilters([unknownOccupancy], search, null, {
            occupancyVisible: true,
            now: NOW,
          }),
        ),
      ).toEqual([]);
      expect(
        ids(
          applyClientSearchFilters([unknownOccupancy], search, null, {
            occupancyVisible: false,
            now: NOW,
          }),
        ),
      ).toEqual(["unknown-occupancy"]);
    });

    it("garde une vente passée ou retirée : rien n'y est à vérifier avant l'audience", () => {
      const closed = [
        complete("past", { status: "past", app_surface_m2: null }),
        complete("withdrawn", { status: "withdrawn", sale_date: null }),
      ];
      expect(ids(applyClientSearchFilters(closed, search, null, { now: NOW }))).toEqual([
        "past",
        "withdrawn",
      ]);
    });

    it("ne compte jamais comme manquant un champ absent de la ligne", () => {
      const bare = { id: "bare" } as AuctionSale;
      expect(
        ids(applyClientSearchFilters([bare], search, null, { occupancyVisible: true, now: NOW })),
      ).toEqual(["bare"]);
    });
  });

  it("les deux filtres se cumulent", () => {
    const candidates = [
      complete("both"),
      complete("under-only", { app_surface_m2: null }),
      complete("clean-only"),
    ];
    expect(
      ids(
        applyClientSearchFilters(candidates, { belowRange: true, noPointsToVerify: true }, null, {
          underRangeSaleIds: new Set(["both", "under-only"]),
          occupancyVisible: true,
          now: NOW,
        }),
      ),
    ).toEqual(["both"]);
  });
});

function sale(id: string, latitude: number | null, longitude: number | null): AuctionSale {
  return {
    id,
    title: id,
    latitude,
    longitude,
    source_blocks: null,
    documents_rich: null,
  } as AuctionSale;
}
