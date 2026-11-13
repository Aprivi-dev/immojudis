import { describe, expect, it } from "vitest";
import { activeFilterChips } from "@/components/search/active-filter-chips";
import { alertCriteriaSummary } from "@/lib/alert-criteria-labels";
import { alertMatchesSale } from "@/lib/alerts";
import { occupancyClass } from "@/lib/occupancy-status";
import { getSales } from "@/lib/queries";
import { buildPreviewSearchArgs } from "@/lib/search/preview-search";
import {
  applyClientSearchFilters,
  catalogueSearch,
  dataFiltersFromSearch,
  HOME_TYPE_OPTIONS,
  OCCUPANCY_OPTIONS,
} from "@/lib/search/search-filters";
import { validateSalesSearch, type SalesSearchParams } from "@/lib/search/search-url-state";
import type { AuctionSale } from "@/lib/types";

/**
 * Lot 10 : chaque option des filtres « Type de bien » et « Occupation » est un code de la base
 * (`auction_sales.property_type`, `auction_sales.occupancy_status`). Avant, « Garage » envoyait
 * `garage` et « Libre » `free`, deux valeurs que la base ne connaît pas : ni la recherche ni les
 * alertes ne retenaient jamais une vente.
 */

/** Les codes des contraintes SQL (migration 20260520202829). */
const OCCUPANCY_CODES = ["vacant", "occupied", "rented", "owner_occupied", "squatted", "unknown"];

type Row = Record<string, unknown>;

/** Lecture PostgREST réduite aux filtres d'égalité et de liste, appliqués à des lignes en mémoire. */
class FakeCatalogue implements PromiseLike<{ data: Row[]; error: null }> {
  private readonly predicates: Array<(row: Row) => boolean> = [];

  constructor(private readonly rows: Row[]) {}

  select() {
    return this;
  }

  order() {
    return this;
  }

  range() {
    return this;
  }

  eq(column: string, value: unknown) {
    this.predicates.push((row) => row[column] === value);
    return this;
  }

  in(column: string, values: unknown[]) {
    this.predicates.push((row) => values.includes(row[column]));
    return this;
  }

  then<TResult1 = { data: Row[]; error: null }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: Row[]; error: null }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const data = this.rows.filter((row) => this.predicates.every((matches) => matches(row)));
    return Promise.resolve({ data, error: null }).then(onfulfilled, onrejected);
  }
}

/** Une adresse du catalogue lue comme le fait la page `/sales`. */
function urlSearch(record: Record<string, unknown>): SalesSearchParams {
  return catalogueSearch(validateSalesSearch(record));
}

function sale(overrides: Partial<AuctionSale>): AuctionSale {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    status: "upcoming",
    ...overrides,
  } as AuctionSale;
}

async function serverSearch(search: SalesSearchParams, rows: AuctionSale[]) {
  const catalogue = new FakeCatalogue(rows as unknown as Row[]);
  return getSales(dataFiltersFromSearch(search), 24, "date_asc", 0, {
    client: { from: () => catalogue } as never,
  });
}

const NO_CRITERIA = {
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
} satisfies Parameters<typeof alertMatchesSale>[0];

describe("filtre « Type de bien »", () => {
  it.each(HOME_TYPE_OPTIONS.map((option) => [option.label, option.value]))(
    "« %s » retient une vente du code %s partout",
    async (_label, code) => {
      const row = sale({ property_type: code });
      const search = urlSearch({ homeTypes: code });

      expect(await serverSearch(search, [row])).toEqual([row]);
      expect(buildPreviewSearchArgs(search).p_property_types).toEqual([code]);
      expect(applyClientSearchFilters([row], search, null)).toEqual([row]);
      expect(alertMatchesSale({ ...NO_CRITERIA, property_type: code }, row).matches).toBe(true);
    },
  );

  it("n'offre que des codes de la base", () => {
    for (const option of HOME_TYPE_OPTIONS) {
      expect(["apartment", "house", "building", "land", "commercial", "parking"]).toContain(
        option.value,
      );
    }
  });

  it("lit l'ancienne valeur « garage » d'une adresse partagée et d'une alerte enregistrée", async () => {
    const parking = sale({ property_type: "parking" });
    const search = urlSearch({ homeTypes: "garage" });

    expect(search.homeTypes).toEqual(["parking"]);
    expect(await serverSearch(search, [parking])).toEqual([parking]);
    expect(alertMatchesSale({ ...NO_CRITERIA, property_type: "garage" }, parking).matches).toBe(
      true,
    );
  });
});

describe("filtre « Occupation »", () => {
  const rows = OCCUPANCY_CODES.map((code, index) =>
    sale({ id: `11111111-1111-4111-8111-11111111111${index}`, occupancy_status: code }),
  );

  it.each(
    OCCUPANCY_OPTIONS.flatMap((option) =>
      OCCUPANCY_CODES.filter((code) => occupancyClass(code) === option.value).map((code) => [
        option.label,
        code,
        option.value,
      ]),
    ),
  )("« %s » retient une vente %s partout", async (_label, code, value) => {
    const row = rows.find((item) => item.occupancy_status === code)!;
    const search = urlSearch({ occupancy: value });

    expect(await serverSearch(search, rows)).toContainEqual(row);
    // L'occupation est un critère de la recherche serveur : le filtre du navigateur ne la retire pas.
    expect(applyClientSearchFilters([row], search, null)).toEqual([row]);
    expect(alertMatchesSale({ ...NO_CRITERIA, occupancy_status: value }, row).matches).toBe(true);
  });

  it.each(OCCUPANCY_OPTIONS.map((option) => [option.label, option.value]))(
    "« %s » écarte les ventes d'une autre classe, sur le serveur comme dans l'alerte",
    async (_label, value) => {
      const search = urlSearch({ occupancy: value });
      const others = rows.filter((row) => occupancyClass(row.occupancy_status) !== value);

      for (const row of await serverSearch(search, rows)) {
        expect(occupancyClass(row.occupancy_status)).toBe(value);
      }
      for (const row of others) {
        expect(
          alertMatchesSale({ ...NO_CRITERIA, occupancy_status: value }, row).matches,
          String(row.occupancy_status),
        ).toBe(false);
      }
    },
  );

  it("lit l'ancienne valeur « free » d'une adresse partagée et d'une alerte enregistrée", async () => {
    const vacant = rows.find((item) => item.occupancy_status === "vacant")!;
    const search = urlSearch({ occupancy: "free" });

    expect(search.occupancy).toBe("vacant");
    expect(await serverSearch(search, rows)).toEqual([vacant]);
    expect(alertMatchesSale({ ...NO_CRITERIA, occupancy_status: "free" }, vacant).matches).toBe(
      true,
    );
    expect(
      alertCriteriaSummary({ ...NO_CRITERIA, occupancy_status: "free", advanced_criteria: {} }),
    ).toContain("Occupation : Libre");
  });

  it("affiche la puce avec le libellé de l'option, jamais le code", () => {
    for (const option of OCCUPANCY_OPTIONS) {
      expect(
        activeFilterChips(urlSearch({ occupancy: option.value })).map((chip) => chip.label),
      ).toContain(`Occupation : ${option.label}`);
    }
    expect(OCCUPANCY_OPTIONS.map((option) => option.label)).toEqual(["Libre", "Occupé", "Loué"]);
  });

  it("ignore une valeur d'adresse sans classe d'occupation", () => {
    expect(urlSearch({ occupancy: "n'importe quoi" }).occupancy).toBeUndefined();
  });

  it("ne retient aucune vente pour une alerte enregistrée sans classe d'occupation", () => {
    for (const row of rows) {
      expect(
        alertMatchesSale({ ...NO_CRITERIA, occupancy_status: "n'importe quoi" }, row).matches,
      ).toBe(false);
    }
  });
});
