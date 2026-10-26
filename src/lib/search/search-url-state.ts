import { validSaleDate } from "./sale-date-range";
import { asFiniteNumber } from "@/lib/types";
import { parseSaleType, type SaleTypeFilter } from "@/lib/sale-types";
import { textValue } from "@/lib/guards";

export type ViewportBounds = {
  north: number;
  south: number;
  east: number;
  west: number;
};

export const SEARCH_SORT_KEYS = [
  "relevance",
  "price_desc",
  "price_asc",
  "newest",
  "sale_date_asc",
  "sqft_desc",
  "beds_desc",
  "distance",
  // Score d'investissement : tri explicite, réservé à l'offre Analyse (ancienne valeur d'URL).
  "score_desc",
] as const;

export type SearchSortKey = (typeof SEARCH_SORT_KEYS)[number];

export const TRANSACTION_TYPES = ["for_sale", "for_rent", "sold"] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export type SalesSearchParams = {
  minSaleDate?: string;
  maxSaleDate?: string;
  saleType?: SaleTypeFilter;
  city?: string;
  department?: string;
  tribunal?: string;
  query?: string;
  viewport?: ViewportBounds;
  sort?: SearchSortKey;
  minPrice?: number;
  maxPrice?: number;
  minBeds?: number;
  minBaths?: number;
  minSqft?: number;
  maxSqft?: number;
  homeTypes?: string[];
  status?: string[];
  page?: number;
  limit?: number;
  keywords?: string;
  transactionType?: TransactionType;
  occupancy?: string;
  dpeClasses?: string[];
  minScore?: number;
  maxPricePerM2?: number;
  minYield?: number;
  minMarketDiscount?: number;
  houseWithLand?: boolean;
  aroundAddress?: string;
  aroundRadius?: number;
  yearBuilt?: number;
  openHouse?: boolean;
  /**
   * Mise à prix sous la fourchette des ventes comparables : la bande `under` de la fiche publique
   * (jamais pour un bien occupé), qui ne couvre que les ventes dont l'estimation est assez fiable.
   */
  belowRange?: boolean;
  /** Sans point à vérifier (`points-to-verify.ts`) : l'annonce ne laisse rien d'ouvert. */
  noPointsToVerify?: boolean;
  /**
   * Pépites seulement : les ventes de la liste publique des pépites (`pepite-filter.ts`). Ouvert aux
   * visiteurs sans compte ; sans effet visible tant que le repère n'est pas ouvert (mode « on »).
   */
  pepite?: boolean;
  /** Une visite à date publiée dans les 7 jours (voir `saleHasVisitSoon`). */
  visitSoon?: boolean;
  map?: boolean;
  searchAsMove?: boolean;
};

export type SalesSearchUrlRecord = Record<string, string | number | boolean | undefined>;

function optionalText(value: unknown): string | undefined {
  return textValue(value) ?? undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const parsed = asFiniteNumber(value);
  // Plafonné aux entiers sûrs : `1e30` donnerait `1e+30` dans l'adresse.
  return parsed != null && parsed >= 0 ? Math.min(parsed, Number.MAX_SAFE_INTEGER) : undefined;
}

/**
 * Plafond d'un montant en euros (mise à prix, prix au m²). Aucune annonce n'approche cette somme :
 * au-delà, la saisie est ramenée au plafond. L'adresse ne porte ainsi jamais de notation
 * scientifique (`1e+30`) ni de nombre que la base ne saurait lire.
 */
export const MAX_PRICE_EUR = 100_000_000;

/** Montant en euros entier, de 0 au plafond ; une valeur négative ou illisible est ignorée. */
export function boundedPrice(value: unknown): number | undefined {
  const parsed = nonNegativeNumber(value);
  return parsed == null ? undefined : Math.min(Math.round(parsed), MAX_PRICE_EUR);
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = nonNegativeNumber(value);
  if (parsed == null) return undefined;
  const rounded = Math.floor(parsed);
  return rounded > 0 ? rounded : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (value === true || value === "true" || value === "1" || value === 1) return true;
  if (value === false || value === "false" || value === "0" || value === 0) return false;
  return undefined;
}

function listValue(value: unknown): string[] | undefined {
  const raw = optionalText(value);
  if (!raw) return undefined;
  const next = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return next.length ? Array.from(new Set(next)) : undefined;
}

export function parseViewport(value: unknown): ViewportBounds | undefined {
  const raw = optionalText(value);
  if (!raw) return undefined;

  const [north, south, east, west] = raw.split(":").map((part) => Number(part));
  if (![north, south, east, west].every(Number.isFinite)) return undefined;
  if (north <= south || east <= west) return undefined;

  return { north, south, east, west };
}

export function parseBbox(value: unknown): ViewportBounds | undefined {
  const raw = optionalText(value);
  if (!raw) return undefined;

  const decoded = raw.includes(",") ? raw : decodeBase64SearchValue(raw);
  const [west, south, east, north] = decoded.split(",").map((part) => Number(part));
  if (![north, south, east, west].every(Number.isFinite)) return undefined;
  if (north <= south || east <= west) return undefined;

  return { north, south, east, west };
}

export function serializeViewport(bounds: ViewportBounds | undefined): string | undefined {
  if (!bounds) return undefined;
  return [bounds.north, bounds.south, bounds.east, bounds.west]
    .map((value) => Number(value.toFixed(5)))
    .join(":");
}

export function serializeBbox(bounds: ViewportBounds | undefined): string | undefined {
  if (!bounds) return undefined;
  return [bounds.west, bounds.south, bounds.east, bounds.north]
    .map((value) => Number(value.toFixed(5)))
    .join(",");
}

function decodeBase64SearchValue(raw: string) {
  if (!/^[A-Za-z0-9+/_=-]+$/.test(raw)) return raw;
  try {
    const normalized = raw.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return atob(padded);
  } catch {
    return raw;
  }
}

function parseSort(value: unknown): SearchSortKey | undefined {
  const raw = optionalText(value);
  if (!raw) return undefined;
  if (SEARCH_SORT_KEYS.includes(raw as SearchSortKey)) return raw as SearchSortKey;

  const legacy: Record<string, SearchSortKey> = {
    date_desc: "newest",
    surface_desc: "sqft_desc",
  };
  return legacy[raw];
}

function parseTransactionType(value: unknown): TransactionType | undefined {
  const raw = optionalText(value);
  return TRANSACTION_TYPES.includes(raw as TransactionType) ? (raw as TransactionType) : undefined;
}

export function validateSalesSearch(search: Record<string, unknown>): SalesSearchParams {
  return {
    minSaleDate: validSaleDate(search.minSaleDate),
    maxSaleDate: validSaleDate(search.maxSaleDate),
    saleType: parseSaleType(search.saleType),
    city: optionalText(search.city),
    department: optionalText(search.department),
    tribunal: optionalText(search.tribunal ?? search.tribunal_code),
    query: optionalText(search.query) ?? optionalText(search.q),
    viewport: parseViewport(search.viewport) ?? parseBbox(search.bbox),
    sort: parseSort(search.sort),
    minPrice: boundedPrice(search.minPrice ?? search.min_price),
    maxPrice: boundedPrice(search.maxPrice ?? search.max_price),
    minBeds: nonNegativeNumber(search.minBeds ?? search.beds),
    minBaths: nonNegativeNumber(search.minBaths ?? search.baths),
    minSqft: nonNegativeNumber(search.minSqft ?? search.min_surface),
    maxSqft: nonNegativeNumber(search.maxSqft),
    homeTypes: listValue(search.homeTypes ?? search.type),
    status: listValue(search.status),
    page: positiveInteger(search.page),
    limit: positiveInteger(search.limit),
    keywords: optionalText(search.keywords),
    transactionType: parseTransactionType(search.transactionType),
    occupancy: optionalText(search.occupancy),
    dpeClasses: listValue(search.dpe ?? search.dpeClasses),
    minScore: nonNegativeNumber(search.minScore ?? search.min_score),
    maxPricePerM2: boundedPrice(search.maxPricePerM2 ?? search.max_price_per_m2),
    minYield: nonNegativeNumber(search.minYield ?? search.min_yield),
    minMarketDiscount: nonNegativeNumber(search.minMarketDiscount ?? search.min_market_discount),
    houseWithLand: booleanValue(search.houseWithLand ?? search.house_with_land),
    aroundAddress: optionalText(search.aroundAddress ?? search.around_address),
    aroundRadius: nonNegativeNumber(search.aroundRadius ?? search.around_radius),
    yearBuilt: positiveInteger(search.yearBuilt),
    openHouse: booleanValue(search.openHouse),
    belowRange: booleanValue(search.belowRange),
    noPointsToVerify: booleanValue(search.noPointsToVerify),
    pepite: booleanValue(search.pepite),
    visitSoon: booleanValue(search.visitSoon),
    map: booleanValue(search.map),
    searchAsMove: booleanValue(search.searchAsMove),
  };
}

export function salesSearchToUrlRecord(search: SalesSearchParams): SalesSearchUrlRecord {
  return {
    minSaleDate: search.minSaleDate,
    maxSaleDate: search.maxSaleDate,
    saleType: search.saleType,
    city: search.city,
    department: search.department,
    tribunal: search.tribunal,
    query: search.query,
    bbox: serializeBbox(search.viewport),
    sort: search.sort && search.sort !== "relevance" ? search.sort : undefined,
    minPrice: search.minPrice,
    maxPrice: search.maxPrice,
    minBeds: search.minBeds,
    minBaths: search.minBaths,
    minSqft: search.minSqft,
    maxSqft: search.maxSqft,
    homeTypes: search.homeTypes?.length ? search.homeTypes.join(",") : undefined,
    status: search.status?.length ? search.status.join(",") : undefined,
    page: search.page && search.page > 1 ? search.page : undefined,
    limit: search.limit,
    keywords: search.keywords,
    transactionType:
      search.transactionType && search.transactionType !== "for_sale"
        ? search.transactionType
        : undefined,
    occupancy: search.occupancy,
    dpe: search.dpeClasses?.length ? search.dpeClasses.join(",") : undefined,
    minScore: search.minScore,
    maxPricePerM2: search.maxPricePerM2,
    minYield: search.minYield,
    minMarketDiscount: search.minMarketDiscount,
    houseWithLand: search.houseWithLand ? true : undefined,
    aroundAddress: search.aroundAddress,
    aroundRadius: search.aroundRadius,
    yearBuilt: search.yearBuilt,
    openHouse: search.openHouse ? true : undefined,
    belowRange: search.belowRange ? true : undefined,
    noPointsToVerify: search.noPointsToVerify ? true : undefined,
    pepite: search.pepite ? true : undefined,
    visitSoon: search.visitSoon ? true : undefined,
    map: search.map ? true : undefined,
    searchAsMove: search.searchAsMove ? true : undefined,
  };
}

/**
 * Stable identity of a search, shared by the server (first paint) and the
 * client (React Query keys) so hydrated rows are found under the same key.
 */
export function stableUrlRecord(record: SalesSearchUrlRecord) {
  return JSON.stringify(
    Object.entries(record)
      .filter(([, value]) => value != null && value !== "")
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function salesSearchSignature(search: SalesSearchParams): string {
  return stableUrlRecord(salesSearchToUrlRecord(search));
}

export function mergeSalesSearch(
  current: SalesSearchParams,
  patch: Partial<SalesSearchParams>,
): SalesSearchParams {
  const next: SalesSearchParams = { ...current, ...patch };
  if (!("page" in patch)) next.page = undefined;
  return next;
}

/**
 * Critères numériques de l'adresse, avec leurs anciens noms : c'est là qu'une saisie peut être
 * ignorée (`minPrice=-5`), arrondie ou ramenée à une borne (`maxPrice=1e30`).
 */
const NUMERIC_URL_KEYS: ReadonlyArray<readonly [canonical: string, ...aliases: string[]]> = [
  ["minPrice", "min_price"],
  ["maxPrice", "max_price"],
  ["minBeds", "beds"],
  ["minBaths", "baths"],
  ["minSqft", "min_surface"],
  ["maxSqft"],
  ["minScore", "min_score"],
  ["maxPricePerM2", "max_price_per_m2"],
  ["minYield", "min_yield"],
  ["minMarketDiscount", "min_market_discount"],
  ["aroundRadius", "around_radius"],
  ["yearBuilt"],
  ["page"],
  ["limit"],
];

/**
 * Adresse canonique d'une adresse dont un critère numérique n'est pas pris tel quel : valeur
 * négative ou illisible (retirée), notation scientifique ou montant au-dessus du plafond (ramené à
 * la valeur retenue), `page=1` (retiré). Renvoie `null` quand rien ne change. Les autres paramètres
 * (`view`, `utm_*`, critères textuels) sont conservés tels quels : l'adresse ne garde jamais une
 * valeur que la recherche ignore.
 */
export function canonicalSalesQuery(params: URLSearchParams): URLSearchParams | null {
  const record: Record<string, string> = {};
  params.forEach((value, key) => {
    record[key] = value;
  });
  const canonicalRecord = salesSearchToUrlRecord(validateSalesSearch(record));

  let changed = false;
  const next = new URLSearchParams(params);
  for (const [canonical, ...aliases] of NUMERIC_URL_KEYS) {
    const names = [canonical, ...aliases];
    const raw = names.map((name) => record[name]).find((value) => value !== undefined);
    if (raw === undefined) continue;
    const wanted = canonicalRecord[canonical];
    const wantedText = wanted === undefined ? undefined : String(wanted);
    const onlyCanonicalName = names.every((name) => name === canonical || !(name in record));
    if (wantedText === raw && onlyCanonicalName) continue;
    changed = true;
    for (const name of names) next.delete(name);
    if (wantedText !== undefined) next.set(canonical, wantedText);
  }
  return changed ? next : null;
}
