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
 * `salesSearchToUrlRecord`). Côté navigateur, tout autre critère est écarté de l'adresse. Côté
 * route, tout autre paramètre est refusé (400) : la réponse est mise en cache par adresse, un
 * paramètre en trop ou répété ouvrirait une entrée de cache par valeur (et contournerait le CDN).
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

/** Chambres et salles de bain minimum : entiers de 0 à 20 (au-delà, aucune annonce n'existe). */
const MAX_ROOMS_FILTER = 20;

/**
 * Tailles de page acceptées par la route : une réponse est mise en cache par adresse, et chaque
 * taille ouvre une entrée par page et par filtre (`limit=1`, `2`, `3`… faisaient autant d'entrées,
 * donc autant de lectures de la base pour qui voulait la contourner). Les trois valeurs sont celles
 * que la page propose (24 par défaut).
 */
export const PREVIEW_PAGE_SIZES = [24, 50, 100] as const;

/**
 * Plafond des prix de la route, en euros : 100 millions. Aucune mise à prix n'en approche, et une
 * valeur plus grande (`1e30`, `99999999999999`) ne sert qu'à ouvrir une entrée de cache de plus.
 */
export const MAX_PRICE_FILTER_EUR = 100_000_000;

function isPageSize(value: number): boolean {
  return (PREVIEW_PAGE_SIZES as readonly number[]).includes(value);
}

/**
 * Prix envoyé à la route : entier d'euros dans [0, 100 000 000]. Le champ de saisie accepte « 150 000,5 »
 * ou « 1e30 » : on envoie la valeur entière équivalente (« au moins 1 234,5 € » = au moins 1 235 €,
 * « au plus 1 234,5 € » = au plus 1 234 €), jamais une valeur que la route refuserait.
 */
function canonicalPriceFilter(
  value: string | number | boolean,
  bound: "min" | "max",
): string | number | boolean {
  if (typeof value !== "number" || !Number.isFinite(value)) return value;
  const rounded = bound === "min" ? Math.ceil(value) : Math.floor(value);
  return Math.min(MAX_PRICE_FILTER_EUR, Math.max(0, rounded));
}

/**
 * Valeur envoyée à la route pour un critère de pièces. Le champ de saisie accepte « 2,5 » ou « 30 » :
 * on envoie l'entier équivalent (« au moins 2,5 chambres » = au moins 3), jamais une valeur que la
 * route refuserait.
 */
function canonicalRoomsFilter(value: string | number | boolean): string | number | boolean {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_ROOMS_FILTER, Math.ceil(value))
    : value;
}

/** Paramètres d'adresse de la recherche d'aperçu : triés, donc identiques pour la même recherche. */
export function previewSearchQueryString(search: SalesSearchParams): string {
  const record = salesSearchToUrlRecord(search);
  const params = new URLSearchParams();
  for (const key of PREVIEW_SEARCH_URL_KEYS) {
    const value = record[key];
    if (value == null || value === "") continue;
    // Une taille de page que la route refuse n'est pas envoyée : la route répond avec la taille par défaut.
    if (key === "limit" && !(typeof value === "number" && isPageSize(value))) continue;
    let sent: string | number | boolean = value;
    if (key === "minBeds" || key === "minBaths") sent = canonicalRoomsFilter(value);
    else if (key === "minPrice") sent = canonicalPriceFilter(value, "min");
    else if (key === "maxPrice") sent = canonicalPriceFilter(value, "max");
    params.set(key, String(sent));
  }
  return params.toString();
}

export function previewSearchApiUrl(search: SalesSearchParams): string {
  const query = previewSearchQueryString(search);
  return query ? `${PREVIEW_SEARCH_API_PATH}?${query}` : PREVIEW_SEARCH_API_PATH;
}

/**
 * Critères numériques, dates et listes fermées : une valeur fournie mais illisible est refusée.
 * `page` et `limit` (entiers stricts), `minPrice` / `maxPrice` (entiers d'euros plafonnés) et
 * `minBeds` / `minBaths` (entiers de 0 à 20) sont contrôlés avant : voir `INTEGER_FIELDS`.
 */
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

/**
 * Entiers en base 10, sans signe, sans zéro de tête, sans point ni exposant : `2.7`, `1e2`, `0x10`,
 * `+5` et ` 5` sont refusés (l'adresse canonique n'en contient jamais). `min` et `max` sont inclus.
 */
const INTEGER_FIELDS: Record<string, { min: number; max: number }> = {
  page: { min: 1, max: Number.MAX_SAFE_INTEGER },
  limit: { min: 1, max: Number.MAX_SAFE_INTEGER },
  minBeds: { min: 0, max: 20 },
  minBaths: { min: 0, max: 20 },
  minPrice: { min: 0, max: MAX_PRICE_FILTER_EUR },
  maxPrice: { min: 0, max: MAX_PRICE_FILTER_EUR },
};
const STRICT_INTEGER = /^(?:0|[1-9][0-9]{0,15})$/;

/** Caractères de contrôle (NUL, tabulation, retour à la ligne, DEL, C1…) : jamais dans un critère. */
const CONTROL_CHARACTER = /\p{Cc}/u;

export type PreviewSearchRequest =
  | { ok: true; search: SalesSearchParams }
  | { ok: false; message: string };

/**
 * Limites de la fonction SQL `search_auction_sales_preview_v3/v4` : au-delà, elle lève une erreur.
 * On les contrôle ici pour répondre 400 sans lui faire lire la base.
 */
export const RPC_LIMITS = {
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
 * Lit les paramètres d'adresse de la route avec la logique de la page (`validateSalesSearch`) et
 * vérifie les limites de la fonction SQL. Refuse (400) : un paramètre qui n'est pas dans
 * `PREVIEW_SEARCH_URL_KEYS` (les critères réservés, comme l'occupation, le score ou la zone de
 * carte, n'y sont pas : la fonction publique les refuse et `buildPreviewSearchArgs` ne les
 * transmet jamais), un paramètre répété, un caractère de contrôle, un entier illisible ou hors
 * plage, une valeur numérique, une date ou une liste fermée illisible.
 */
export function parsePreviewSearchRequest(params: URLSearchParams): PreviewSearchRequest {
  const known = new Set<string>(PREVIEW_SEARCH_URL_KEYS);
  const seen = new Set<string>();
  for (const [key, value] of params) {
    if (!known.has(key)) return { ok: false, message: "Paramètre inconnu." };
    if (seen.has(key)) return { ok: false, message: `Paramètre « ${key} » répété.` };
    seen.add(key);
    // Avant tout `trim()` : une tabulation ou un retour à la ligne en bout de valeur est refusé aussi.
    if (CONTROL_CHARACTER.test(value)) {
      return { ok: false, message: `Paramètre « ${key} » invalide.` };
    }
  }

  const raw: Record<string, string> = {};
  for (const key of PREVIEW_SEARCH_URL_KEYS) {
    const value = params.get(key)?.trim();
    if (value) raw[key] = value;
  }
  for (const [key, { min, max }] of Object.entries(INTEGER_FIELDS)) {
    if (!(key in raw)) continue;
    const value = params.get(key)!;
    const number = STRICT_INTEGER.test(value) ? Number(value) : Number.NaN;
    if (!(number >= min && number <= max) || (key === "limit" && !isPageSize(number))) {
      return { ok: false, message: `Paramètre « ${key} » invalide.` };
    }
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
