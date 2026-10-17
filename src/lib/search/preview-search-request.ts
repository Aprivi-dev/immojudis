import type { AuctionSale, SaleMediaMirror } from "@/lib/types";
import { buildPreviewSearchArgs } from "./preview-search";
import {
  salesSearchToUrlRecord,
  validateSalesSearch,
  type SalesSearchParams,
} from "./search-url-state";

/**
 * Contrat de la route publique `GET /api/catalogue/preview` : la recherche d'aperçu d'un visiteur
 * anonyme, servie par notre domaine (liste, total et copies de photos en une seule réponse).
 * Ce module est partagé par le navigateur (construction de l'adresse) et par la route (lecture et
 * contrôle des paramètres) : il ne dépend d'aucun module serveur.
 */
export const PREVIEW_SEARCH_API_PATH = "/api/catalogue/preview";

/**
 * Critères que la recherche d'aperçu honore, sous leur nom d'adresse canonique (celui de
 * `salesSearchToUrlRecord`). Tout autre paramètre est ignoré : il ne change ni le résultat ni,
 * côté navigateur, l'adresse demandée (donc pas de cache contourné par un paramètre en trop).
 */
export const PREVIEW_SEARCH_URL_KEYS = [
  "city",
  "department",
  "homeTypes",
  "keywords",
  "limit",
  "maxPrice",
  "maxSaleDate",
  "maxSqft",
  "minBaths",
  "minBeds",
  "minPrice",
  "minSaleDate",
  "minSqft",
  "page",
  "query",
  "saleType",
  "sort",
  "status",
  "transactionType",
  "tribunal",
] as const;

/** Réponse de la route : les ventes sans copie, le total, et les copies trouvées. */
export type PreviewSearchApiResponse = {
  items: AuctionSale[];
  count: number;
  /** URL d'origine de la photo vers sa copie hébergée ; vide si l'interrupteur est éteint. */
  mirrors: Array<[string, SaleMediaMirror]>;
};

/** Paramètres d'adresse de la recherche d'aperçu : triés, donc identiques pour la même recherche. */
export function previewSearchQueryString(search: SalesSearchParams): string {
  const record = salesSearchToUrlRecord(search);
  const params = new URLSearchParams();
  for (const key of PREVIEW_SEARCH_URL_KEYS) {
    const value = record[key];
    if (value != null && value !== "") params.set(key, String(value));
  }
  return params.toString();
}

export function previewSearchApiUrl(search: SalesSearchParams): string {
  const query = previewSearchQueryString(search);
  return query ? `${PREVIEW_SEARCH_API_PATH}?${query}` : PREVIEW_SEARCH_API_PATH;
}

/** Critères numériques, dates et listes fermées : une valeur fournie mais illisible est refusée. */
const STRICT_FIELDS: Record<string, keyof SalesSearchParams> = {
  limit: "limit",
  maxPrice: "maxPrice",
  maxSaleDate: "maxSaleDate",
  maxSqft: "maxSqft",
  minBaths: "minBaths",
  minBeds: "minBeds",
  minPrice: "minPrice",
  minSaleDate: "minSaleDate",
  minSqft: "minSqft",
  page: "page",
  saleType: "saleType",
  sort: "sort",
  transactionType: "transactionType",
};

export type PreviewSearchRequest =
  | { ok: true; search: SalesSearchParams }
  | { ok: false; message: string };

/**
 * Limites de la fonction SQL `search_auction_sales_preview_v3/v4` : au-delà, elle lève une erreur.
 * On les contrôle ici pour répondre 400 sans lui faire lire la base.
 */
const RPC_LIMITS = {
  departments: 220,
  keywords: 5,
  propertyTypes: 8,
  statuses: 4,
  listItemLength: 80,
  statusLength: 40,
  city: 120,
  postalCode: 16,
  tribunal: 160,
  sort: 32,
  maxLimit: 100,
  maxOffset: 10_000,
} as const;

function longestItem(values: readonly string[] | null): number {
  return values?.reduce((longest, value) => Math.max(longest, value.length), 0) ?? 0;
}

/** Message du premier critère hors limites de la fonction SQL, ou `null`. */
export function previewSearchLimitViolation(search: SalesSearchParams): string | null {
  const args = buildPreviewSearchArgs(search);
  if (args.p_limit < 1 || args.p_limit > RPC_LIMITS.maxLimit) return "Taille de page invalide.";
  if (args.p_offset < 0 || args.p_offset > RPC_LIMITS.maxOffset) return "Page hors limites.";
  if ((args.p_departments?.length ?? 0) > RPC_LIMITS.departments) return "Zone trop large.";
  if ((args.p_keywords?.length ?? 0) > RPC_LIMITS.keywords) return "Trop de mots-clés.";
  if ((args.p_property_types?.length ?? 0) > RPC_LIMITS.propertyTypes)
    return "Trop de types de bien.";
  if ((args.p_statuses?.length ?? 0) > RPC_LIMITS.statuses) return "Trop de statuts.";
  if (
    longestItem(args.p_departments) > RPC_LIMITS.listItemLength ||
    longestItem(args.p_keywords) > RPC_LIMITS.listItemLength ||
    longestItem(args.p_property_types) > RPC_LIMITS.listItemLength ||
    longestItem(args.p_statuses) > RPC_LIMITS.statusLength
  )
    return "Critère trop long.";
  if ((args.p_city?.length ?? 0) > RPC_LIMITS.city) return "Ville trop longue.";
  if ((args.p_postal_code?.length ?? 0) > RPC_LIMITS.postalCode) return "Code postal trop long.";
  if ((args.p_tribunal?.length ?? 0) > RPC_LIMITS.tribunal) return "Tribunal trop long.";
  if (args.p_sort.length > RPC_LIMITS.sort) return "Tri invalide.";
  if (search.minSaleDate && search.maxSaleDate && search.minSaleDate > search.maxSaleDate)
    return "Période de vente invalide.";
  return null;
}

/**
 * Lit les paramètres d'adresse de la route avec la logique de la page (`validateSalesSearch`), ne
 * garde que les critères de l'aperçu public, refuse une valeur illisible et vérifie les limites de
 * la fonction SQL. Les critères réservés (occupation, score, zone de carte…) ne passent pas : la
 * fonction publique les refuse et `buildPreviewSearchArgs` ne les transmet jamais.
 */
export function parsePreviewSearchRequest(params: URLSearchParams): PreviewSearchRequest {
  const raw: Record<string, string> = {};
  for (const key of PREVIEW_SEARCH_URL_KEYS) {
    const value = params.get(key)?.trim();
    if (value) raw[key] = value;
  }
  const search = validateSalesSearch(raw);
  for (const [key, field] of Object.entries(STRICT_FIELDS)) {
    if (key in raw && search[field] === undefined) {
      return { ok: false, message: `Paramètre « ${key} » invalide.` };
    }
  }
  const violation = previewSearchLimitViolation(search);
  return violation ? { ok: false, message: violation } : { ok: true, search };
}
