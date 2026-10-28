import { propertyTypeLabel } from "@/lib/format";
import { saleTypeFilterLabel } from "@/lib/sale-types";
import { compactPrice } from "@/lib/search/search-filters";
import type { SalesSearchParams } from "@/lib/search/search-url-state";

/** Un critère actif de la recherche, avec de quoi le retirer seul. */
export type ActiveFilterChip = {
  key: string;
  label: string;
  /** À passer à `updateSearch` pour retirer ce critère (et lui seul). */
  clear: Partial<SalesSearchParams>;
};

/** Retire tout ce qui limite la recherche à un lieu : le reste des critères est conservé. */
export const WHOLE_FRANCE_PATCH: Partial<SalesSearchParams> = {
  city: undefined,
  department: undefined,
  query: undefined,
  tribunal: undefined,
  viewport: undefined,
  searchAsMove: false,
  aroundAddress: undefined,
  aroundRadius: undefined,
};

export function hasGeographicFilter(search: SalesSearchParams): boolean {
  return Boolean(
    search.city ||
    search.department ||
    search.query ||
    search.tribunal ||
    search.viewport ||
    search.aroundAddress,
  );
}

function range<T extends string | number>(
  min: T | undefined,
  max: T | undefined,
  format: (value: T) => string,
): string | null {
  if (min != null && max != null) return `${format(min)} à ${format(max)}`;
  if (min != null) return `dès ${format(min)}`;
  if (max != null) return `jusqu'à ${format(max)}`;
  return null;
}

/**
 * Les critères actifs sous forme de puces retirables, pour l'état « aucun résultat » : la
 * personne voit ce qui l'empêche de trouver une vente et le retire en un geste. Le tri, la
 * pagination, la mise en page et la carte ne sont pas des critères.
 */
export function activeFilterChips(search: SalesSearchParams): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = [];
  const add = (
    key: string,
    label: string | null | undefined,
    clear: Partial<SalesSearchParams>,
  ) => {
    if (label) chips.push({ key, label, clear });
  };
  const euros = (value: number) => compactPrice(value);
  const plain = (value: number) => value.toLocaleString("fr-FR");

  add("city", search.city, { city: undefined });
  add("department", search.department && `Département ${search.department}`, {
    department: undefined,
  });
  add("query", search.query, { query: undefined });
  add("tribunal", search.tribunal && `Tribunal ${search.tribunal}`, { tribunal: undefined });
  add("saleType", search.saleType ? saleTypeFilterLabel(search.saleType) : null, {
    saleType: undefined,
  });
  add("homeTypes", search.homeTypes?.map((type) => propertyTypeLabel(type)).join(", "), {
    homeTypes: undefined,
  });
  const price = range(search.minPrice, search.maxPrice, euros);
  add("price", price && `Mise à prix ${price}`, { minPrice: undefined, maxPrice: undefined });
  const surface = range(search.minSqft, search.maxSqft, (value) => `${plain(value)} m²`);
  add("surface", surface && `Surface ${surface}`, { minSqft: undefined, maxSqft: undefined });
  add("minBeds", search.minBeds != null ? `${plain(search.minBeds)} chambres min.` : null, {
    minBeds: undefined,
  });
  add(
    "minBaths",
    search.minBaths != null ? `${plain(search.minBaths)} salles de bain min.` : null,
    {
      minBaths: undefined,
    },
  );
  const dates = range(search.minSaleDate, search.maxSaleDate, (value) =>
    new Date(value).toLocaleDateString("fr-FR"),
  );
  add("saleDate", dates && `Vente ${dates}`, { minSaleDate: undefined, maxSaleDate: undefined });
  add("occupancy", search.occupancy && `Occupation : ${search.occupancy}`, {
    occupancy: undefined,
  });
  add("keywords", search.keywords && `« ${search.keywords} »`, { keywords: undefined });
  add("dpe", search.dpeClasses?.length ? `DPE ${search.dpeClasses.join("/")}` : null, {
    dpeClasses: undefined,
  });
  add("minScore", search.minScore != null ? `Score ≥ ${plain(search.minScore)}` : null, {
    minScore: undefined,
  });
  add(
    "maxPricePerM2",
    search.maxPricePerM2 != null ? `≤ ${plain(search.maxPricePerM2)} €/m²` : null,
    { maxPricePerM2: undefined },
  );
  add(
    "minYield",
    search.minYield != null
      ? `Rendement brut à la mise à prix ≥ ${plain(search.minYield)} %`
      : null,
    {
      minYield: undefined,
    },
  );
  add(
    "minMarketDiscount",
    search.minMarketDiscount != null ? `Décote ≥ ${plain(search.minMarketDiscount)} %` : null,
    { minMarketDiscount: undefined },
  );
  add("houseWithLand", search.houseWithLand ? "Maison avec terrain" : null, {
    houseWithLand: undefined,
  });
  add(
    "around",
    search.aroundAddress &&
      `Autour de ${search.aroundAddress}${search.aroundRadius != null ? ` (${plain(search.aroundRadius)} km)` : ""}`,
    { aroundAddress: undefined, aroundRadius: undefined },
  );
  add("yearBuilt", search.yearBuilt != null ? `Construit en ${search.yearBuilt}` : null, {
    yearBuilt: undefined,
  });
  add("openHouse", search.openHouse ? "Visites programmées" : null, { openHouse: undefined });
  add(
    "belowRange",
    search.belowRange ? "Mise à prix sous la fourchette des ventes comparables" : null,
    { belowRange: undefined },
  );
  add("noPointsToVerify", search.noPointsToVerify ? "Sans point à vérifier" : null, {
    noPointsToVerify: undefined,
  });
  add("pepite", search.pepite ? "Pépites seulement" : null, { pepite: undefined });
  add("visitSoon", search.visitSoon ? "Visite dans les 7 jours" : null, {
    visitSoon: undefined,
  });
  add("viewport", search.viewport ? "Zone de la carte" : null, {
    viewport: undefined,
    searchAsMove: false,
  });
  add(
    "transactionType",
    search.transactionType && search.transactionType !== "for_sale"
      ? search.transactionType === "sold"
        ? "Ventes passées"
        : "Locations"
      : null,
    { transactionType: undefined },
  );
  return chips;
}
