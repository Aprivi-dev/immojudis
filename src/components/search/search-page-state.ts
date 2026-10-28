import { validSaleDate } from "@/lib/search/sale-date-range";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { DPE_CLASSES, extractDpe, type DpeClass } from "@/lib/dpe";
import { propertyTypeLabel } from "@/lib/format";
import { geocodeAddress, pricePerM2, type GeoPoint } from "@/lib/geo";
import { getSaleSurface } from "@/lib/surface";
import type { AuctionSale } from "@/lib/types";
import type { WatchedZoneInput } from "@/lib/watched-zones";
import type { SalesStatisticsResponse } from "@/lib/sales-statistics";
import { compactPrice } from "@/lib/search/search-filters";
import { RESULTS_VIEW_PARAM, parseResultsView, type ResultsView } from "@/lib/search/results-view";
import {
  boundedPrice,
  stableUrlRecord,
  type SalesSearchParams,
} from "@/lib/search/search-url-state";
import { parseSaleType, saleTypeFilterLabel, type SaleTypeFilter } from "@/lib/sale-types";

export type SearchDraft = {
  minSaleDate: string;
  maxSaleDate: string;
  saleType: SaleTypeFilter | "";
  city: string;
  department: string;
  tribunal: string;
  query: string;
  minPrice: string;
  maxPrice: string;
  minBeds: string;
  minBaths: string;
  minSqft: string;
  maxSqft: string;
  homeTypes: string[];
  status: string[];
  keywords: string;
  occupancy: string;
  dpeClasses: string[];
  minScore: string;
  maxPricePerM2: string;
  minYield: string;
  minMarketDiscount: string;
  houseWithLand: boolean;
  aroundAddress: string;
  aroundRadius: string;
  yearBuilt: string;
  openHouse: boolean;
  belowRange: boolean;
  noPointsToVerify: boolean;
  pepite: boolean;
  visitSoon: boolean;
};

export type SearchStatistics = {
  medianPrice: number | null;
  medianPricePerM2: number | null;
  averageScore: number | null;
  upcomingSales: number;
  dpeCounts: Record<DpeClass, number>;
  dpeKnownCount: number;
};

export function searchToDraft(search: SalesSearchParams): SearchDraft {
  return {
    minSaleDate: search.minSaleDate ?? "",
    maxSaleDate: search.maxSaleDate ?? "",
    saleType: search.saleType ?? "",
    city: search.city ?? "",
    department: search.department ?? "",
    tribunal: search.tribunal ?? "",
    query: search.query ?? "",
    minPrice: stringifyNumber(search.minPrice),
    maxPrice: stringifyNumber(search.maxPrice),
    minBeds: stringifyNumber(search.minBeds),
    minBaths: stringifyNumber(search.minBaths),
    minSqft: stringifyNumber(search.minSqft),
    maxSqft: stringifyNumber(search.maxSqft),
    homeTypes: search.homeTypes ?? [],
    status: search.status ?? [],
    keywords: search.keywords ?? "",
    occupancy: search.occupancy ?? "",
    dpeClasses: search.dpeClasses ?? [],
    minScore: stringifyNumber(search.minScore),
    maxPricePerM2: stringifyNumber(search.maxPricePerM2),
    minYield: stringifyNumber(search.minYield),
    minMarketDiscount: stringifyNumber(search.minMarketDiscount),
    houseWithLand: Boolean(search.houseWithLand),
    aroundAddress: search.aroundAddress ?? "",
    aroundRadius: stringifyNumber(search.aroundRadius),
    yearBuilt: stringifyNumber(search.yearBuilt),
    openHouse: Boolean(search.openHouse),
    belowRange: Boolean(search.belowRange),
    noPointsToVerify: Boolean(search.noPointsToVerify),
    pepite: Boolean(search.pepite),
    visitSoon: Boolean(search.visitSoon),
  };
}

export function emptySearchDraft(): SearchDraft {
  return {
    minSaleDate: "",
    maxSaleDate: "",
    saleType: "",
    city: "",
    department: "",
    tribunal: "",
    query: "",
    minPrice: "",
    maxPrice: "",
    minBeds: "",
    minBaths: "",
    minSqft: "",
    maxSqft: "",
    homeTypes: [],
    status: [],
    keywords: "",
    occupancy: "",
    dpeClasses: [],
    minScore: "",
    maxPricePerM2: "",
    minYield: "",
    minMarketDiscount: "",
    houseWithLand: false,
    aroundAddress: "",
    aroundRadius: "",
    yearBuilt: "",
    openHouse: false,
    belowRange: false,
    noPointsToVerify: false,
    pepite: false,
    visitSoon: false,
  };
}

export function draftToSearch(draft: SearchDraft, current: SalesSearchParams): SalesSearchParams {
  return {
    minSaleDate: validSaleDate(draft.minSaleDate),
    maxSaleDate: validSaleDate(draft.maxSaleDate),
    saleType: parseSaleType(draft.saleType),
    sort: current.sort,
    viewport: current.viewport,
    limit: current.limit,
    map: current.map,
    searchAsMove: current.searchAsMove,
    city: cleanString(draft.city),
    department: cleanString(draft.department),
    tribunal: cleanString(draft.tribunal),
    query: cleanString(draft.query),
    minPrice: draftPrice(draft.minPrice),
    maxPrice: draftPrice(draft.maxPrice),
    minBeds: draftNumber(draft.minBeds),
    minBaths: draftNumber(draft.minBaths),
    minSqft: draftNumber(draft.minSqft),
    maxSqft: draftNumber(draft.maxSqft),
    homeTypes: draft.homeTypes.length ? draft.homeTypes : undefined,
    status: draft.status.length ? draft.status : undefined,
    keywords: cleanString(draft.keywords),
    occupancy: cleanString(draft.occupancy),
    dpeClasses: draft.dpeClasses.length ? draft.dpeClasses : undefined,
    minScore: draftNumber(draft.minScore),
    maxPricePerM2: draftPrice(draft.maxPricePerM2),
    minYield: draftNumber(draft.minYield),
    minMarketDiscount: draftNumber(draft.minMarketDiscount),
    houseWithLand: draft.houseWithLand || undefined,
    aroundAddress: cleanString(draft.aroundAddress),
    aroundRadius: draftNumber(draft.aroundRadius),
    yearBuilt: draftNumber(draft.yearBuilt),
    openHouse: draft.openHouse || undefined,
    belowRange: draft.belowRange || undefined,
    noPointsToVerify: draft.noPointsToVerify || undefined,
    pepite: draft.pepite || undefined,
    visitSoon: draft.visitSoon || undefined,
  };
}

/** Écriture dans l'historique du navigateur : une nouvelle entrée, ou le remplacement de l'actuelle. */
export type HistoryMode = "push" | "replace";

/**
 * Critères qui se choisissent d'un geste (bouton, case, liste, date, lieu validé) : changer l'un
 * d'eux est une étape que « Retour » doit pouvoir défaire. Tous les autres se tapent : chaque frappe
 * remplace l'adresse sans empiler d'entrée.
 */
const CHOSEN_DRAFT_KEYS: ReadonlySet<keyof SearchDraft> = new Set([
  "saleType",
  "homeTypes",
  "status",
  "dpeClasses",
  "houseWithLand",
  "openHouse",
  "belowRange",
  "noPointsToVerify",
  "pepite",
  "visitSoon",
  "occupancy",
  "minSaleDate",
  "maxSaleDate",
  "city",
  "query",
]);

/**
 * Mode d'écriture de l'adresse pour le passage de `previous` à `next` : « push » quand seuls des
 * critères choisis ont changé, « replace » dès qu'un critère saisi a changé (ou rien).
 */
export function historyModeForDraftChange(previous: SearchDraft, next: SearchDraft): HistoryMode {
  const changed = (Object.keys(next) as Array<keyof SearchDraft>).filter(
    (key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]),
  );
  return changed.length > 0 && changed.every((key) => CHOSEN_DRAFT_KEYS.has(key))
    ? "push"
    : "replace";
}

export function stringifyNumber(value: number | undefined) {
  return value == null ? "" : String(value);
}

/** Nombre saisi ; une valeur illisible ou négative est ignorée (l'adresse ne la garde pas). */
export function draftNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.min(parsed, Number.MAX_SAFE_INTEGER)
    : undefined;
}

/** Montant en euros saisi : entier, plafonné à 100 000 000 € (jamais `1e+30` dans l'adresse). */
export function draftPrice(value: string): number | undefined {
  return value.trim() ? boundedPrice(value) : undefined;
}

const MIN_PRICE_ABOVE_MAX_MESSAGE = "La mise à prix minimum dépasse le maximum";

/** Message à afficher quand la mise à prix minimum saisie dépasse le maximum, sinon `null`. */
export function priceRangeError(draft: Pick<SearchDraft, "minPrice" | "maxPrice">): string | null {
  const min = draftPrice(draft.minPrice);
  const max = draftPrice(draft.maxPrice);
  return min != null && max != null && min > max ? MIN_PRICE_ABOVE_MAX_MESSAGE : null;
}

export function cleanString(value: string) {
  return value.trim() || undefined;
}

export function toggleValue(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export { stableUrlRecord };

export function downloadBlob(blob: Blob, filename: string) {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function buildSearchStatistics(sales: AuctionSale[]): SearchStatistics {
  const prices = sales
    .map((sale) => sale.starting_price_eur)
    .filter((value): value is number => value != null && Number.isFinite(value) && value > 0);
  const pricePerM2Values = sales
    .map((sale) => pricePerM2(sale.starting_price_eur, getSaleSurface(sale).value))
    .filter((value): value is number => value != null && Number.isFinite(value) && value > 0);
  const scores = sales
    .map((sale) => sale.investment_score)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const dpeCounts = DPE_CLASSES.reduce(
    (acc, dpeClass) => {
      acc[dpeClass] = 0;
      return acc;
    },
    {} as Record<DpeClass, number>,
  );
  let dpeKnownCount = 0;
  sales.forEach((sale) => {
    const dpe = extractDpe(sale).class;
    if (!dpe) return;
    dpeCounts[dpe] += 1;
    dpeKnownCount += 1;
  });
  const now = Date.now();

  return {
    medianPrice: median(prices),
    medianPricePerM2: median(pricePerM2Values),
    averageScore: scores.length
      ? scores.reduce((total, value) => total + value, 0) / scores.length
      : null,
    upcomingSales: sales.filter(
      (sale) => sale.sale_date && new Date(sale.sale_date).getTime() >= now,
    ).length,
    dpeCounts,
    dpeKnownCount,
  };
}

export function searchStatisticsFromServer(
  summary: SalesStatisticsResponse["summary"],
): SearchStatistics {
  return {
    medianPrice: summary.medianPriceEur,
    medianPricePerM2: summary.medianPricePerM2,
    averageScore: summary.averageInvestmentScore,
    upcomingSales: summary.upcomingSales,
    dpeCounts: summary.dpeCounts,
    dpeKnownCount: summary.dpeKnownCount,
  };
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return Math.round(sorted[middle]);
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(query);
    setMatches(media.matches);

    const onChange = () => setMatches(media.matches);
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    }
    if (typeof media.addListener === "function") {
      media.addListener(onChange);
      return () => media.removeListener(onChange);
    }
    return undefined;
  }, [query]);

  return matches;
}

/** Affichage des résultats (cartes ou tableau) lu dans l'adresse courante, à côté des filtres. */
export function useResultsView(): ResultsView {
  return parseResultsView(useSearchParams().get(RESULTS_VIEW_PARAM));
}

export function buildAlertName(search: SalesSearchParams) {
  const segments = [
    search.saleType ? saleTypeFilterLabel(search.saleType) : null,
    search.city,
    search.tribunal,
    search.department ? `Dép. ${search.department}` : null,
    search.homeTypes?.length === 1 ? propertyTypeLabel(search.homeTypes[0]) : null,
    search.maxPrice ? `≤ ${compactPrice(search.maxPrice)}` : null,
    search.minYield ? `rendement brut à la mise à prix ≥ ${search.minYield}%` : null,
    search.dpeClasses?.length ? `DPE ${search.dpeClasses.join("/")}` : null,
  ].filter(Boolean);

  return segments.length > 0 ? `Recherche ${segments.join(" · ")}` : "Recherche Immojudis";
}

export async function watchedZoneInputFromSearch(
  search: SalesSearchParams,
  center: GeoPoint | null,
): Promise<WatchedZoneInput | null> {
  const alertDefaults = alertDefaultsFromSearch(search);

  if (search.aroundAddress) {
    const point = center ?? (await geocodeAddress(search.aroundAddress));
    if (point) {
      return {
        name: clampZoneName(`Rayon ${point.label ?? search.aroundAddress}`),
        zoneKind: "radius",
        department: search.department ?? null,
        city: search.city ?? null,
        centerLat: point.lat,
        centerLng: point.lng,
        radiusKm: search.aroundRadius ?? 10,
        alertDefaults,
        isActive: true,
      };
    }
  }

  if (search.city) {
    return {
      name: clampZoneName(
        search.department ? `${search.city} (${search.department})` : search.city,
      ),
      zoneKind: "city",
      department: search.department ?? null,
      city: search.city,
      alertDefaults,
      isActive: true,
    };
  }

  if (search.department) {
    return {
      name: `Département ${search.department}`,
      zoneKind: "department",
      department: search.department,
      alertDefaults,
      isActive: true,
    };
  }

  return null;
}

export function alertDefaultsFromSearch(
  search: SalesSearchParams,
): WatchedZoneInput["alertDefaults"] {
  return {
    maxPriceEur: search.maxPrice ?? null,
    minSurfaceM2: search.minSqft ?? null,
    minInvestmentScore: search.minScore ?? null,
    maxPricePerM2: search.maxPricePerM2 ?? null,
    minYieldPct: search.minYield ?? null,
    minMarketDiscountPct: search.minMarketDiscount ?? null,
    dpeClasses: (search.dpeClasses ?? []).filter((value): value is DpeClass =>
      DPE_CLASSES.includes(value as DpeClass),
    ),
    requireHouseWithLand: Boolean(search.houseWithLand),
  };
}

export function clampZoneName(value: string): string {
  return value.trim().slice(0, 120) || "Zone surveillée";
}
