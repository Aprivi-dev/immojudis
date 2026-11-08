import { describe, expect, it } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { SEARCH_SCAN_COLUMNS } from "@/lib/sale-views";
import type { AuctionSale } from "@/lib/types";
import { applyClientSearchFilters } from "./search-filters";
import type { SalesSearchParams } from "./search-url-state";

/**
 * Contrat du balayage des filtres avancés de `/sales` (`search-service.ts`) : il ne lit que
 * `SEARCH_SCAN_COLUMNS` pour toutes les ventes, et relit les colonnes lourdes seulement pour les critères
 * de `withoutDetailCriteria` (DPE, visites, texte, rendement, type de vente). Chaque autre critère doit
 * donc donner le même résultat sur une ligne réduite à ces colonnes que sur la ligne complète.
 */
const scanColumns = new Set(SEARCH_SCAN_COLUMNS.split(","));

function scanRow(sale: AuctionSale): AuctionSale {
  return Object.fromEntries(
    Object.entries(sale).filter(([column]) => scanColumns.has(column)),
  ) as AuctionSale;
}

const base = {
  ...EXAMPLE_SALE,
  id: "f3d6a1c2-0000-4000-8000-000000000001",
  status: "upcoming",
  sale_date: "2099-12-10T09:00:00Z",
  source_blocks: { dpe: "D", sale_procedure: "saisie immobilière" },
} as unknown as AuctionSale;

const rows: AuctionSale[] = [
  base,
  { ...base, id: "f3d6a1c2-0000-4000-8000-000000000002", occupancy_status: "libre" },
  {
    ...base,
    id: "f3d6a1c2-0000-4000-8000-000000000003",
    property_type: "house",
    title: "Maison avec jardin",
    has_garden: true,
    land_surface_m2: 400,
    app_surface_m2: null,
    app_surface_kind: null,
    sale_verification_status: "pending",
  },
  {
    ...base,
    id: "f3d6a1c2-0000-4000-8000-000000000004",
    sale_venue_type: "notary",
    starting_price_eur: 40_000,
    postal_code: "75011",
    department: "75",
    latitude: 48.86,
    longitude: 2.38,
  },
];

const center = { lat: 44.84, lng: -0.58 };

const lightSearches: SalesSearchParams[] = [
  { maxPricePerM2: 1000 },
  { maxPricePerM2: 2000 },
  { houseWithLand: true },
  { aroundAddress: "Bordeaux", aroundRadius: 10 },
  { viewport: { north: 45, south: 44, east: 0, west: -1 } },
  { noPointsToVerify: true },
  { minPrice: 50_000, maxPrice: 100_000 },
  { minSqft: 50 },
  { maxSqft: 60 },
  { minBeds: 2 },
  { minBaths: 1 },
  { homeTypes: ["house"] },
  { status: ["upcoming"] },
  { query: "33" },
  { query: "75011" },
  { transactionType: "sold" },
];

describe("balayage des filtres avancés : colonnes légères suffisantes", () => {
  it.each(lightSearches)("même résultat sur la ligne réduite : %o", (search) => {
    const full = applyClientSearchFilters(rows, search, center, { occupancyVisible: true });
    const light = applyClientSearchFilters(rows.map(scanRow), search, center, {
      occupancyVisible: true,
    });
    expect(light.map((sale) => sale.id)).toEqual(full.map((sale) => sale.id));
  });

  it("les critères qui lisent les blocs des sources ou les descriptions ne s'en passent pas", () => {
    // Raison d'être de la seconde lecture (`SEARCH_DETAIL_COLUMNS`) : sans elle, ces critères écartent la vente.
    const searches: SalesSearchParams[] = [{ dpeClasses: ["D"] }, { keywords: "rafraîchissement" }];
    for (const search of searches) {
      expect(applyClientSearchFilters([base], search, null)).toHaveLength(1);
      expect(applyClientSearchFilters([scanRow(base)], search, null)).toHaveLength(0);
    }
  });
});
