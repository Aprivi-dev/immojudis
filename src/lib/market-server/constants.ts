import "server-only";
import { z } from "zod";
import type {
  CommuneInfo,
  DvfYearResult,
  RadiusAnalysis,
  ResolvedMarketLocation,
} from "@/lib/market-server/types";

// ─── DVF (Demandes de Valeurs Foncières) via API Cerema ─────────────────
// Données ouvertes DGFiP, toutes les transactions immobilières de France.
// https://apidf-preprod.cerema.fr/
//
// Stratégie de marché local (adresse exacte) :
//   1. On localise la commune et sa population → rayon 100 m (ville) ou 300 m
//      (campagne).
//   2. On collecte les mutations DVF des dernières années dans une bbox couvrant
//      ce rayon (filtrage fin par distance ensuite).
//   3. Historique de l'adresse : les 5 dernières ventes de la parcelle du bien.
//   4. Base parcellaire : la dernière vente bâtie de CHAQUE parcelle du rayon
//      (une seule par parcelle) → fourchette de prix au m² (p25 / médiane / p75).

// Cerema publishes its open DVF+ API under this host (its own `next` links point
// to it); no other public host exists. Overridable should that change.
export const CEREMA_BASE =
  process.env.CEREMA_DVF_BASE_URL?.trim() ||
  "https://apidf-preprod.cerema.fr/dvf_opendata/geomutations/";
export const DVF_REVALIDATE_SECONDS = 7 * 24 * 60 * 60;
export const GEO_COMMUNES = "https://geo.api.gouv.fr/communes";
export const GEO_GEOCODING = "https://data.geopf.fr/geocodage/search";
export const DVF_USER_AGENT = "immojudis/1.0 (+https://immojudis-dezt.vercel.app/contact)";
export const PAGE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const COMMUNE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Au-delà de ce nombre d'habitants on considère la commune comme urbaine
// (rayon resserré à 100 m) ; en deçà, rural / périurbain (rayon 300 m).
export const URBAN_POPULATION_THRESHOLD = 10_000;
export const HISTORY_YEARS = 6; // millésimes DVF balayés (≈ profondeur publiée)
export const MIN_BUILT_SURFACE = 9;
export const MAX_DVF_PAGES = 20;
export const DVF_PAGE_SIZE = 500;
export const STORED_DVF_LIMIT = 2_500;

export const pageCache = new Map<string, { expiresAt: number; result: DvfYearResult }>();
export const communeCache = new Map<string, { expiresAt: number; value: CommuneInfo | null }>();
export const geocodeCache = new Map<
  string,
  { expiresAt: number; value: ResolvedMarketLocation | null }
>();
export const storedDvfCache = new Map<
  string,
  { expiresAt: number; value: RadiusAnalysis | null }
>();

export const inputSchema = z.object({
  saleId: z.string().uuid().nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  address: z.string().max(300).nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  postalCode: z.string().max(12).nullable().optional(),
  // Override optionnel ; sinon le rayon est déduit du caractère urbain/rural.
  radiusM: z.number().min(50).max(10_000).nullable().optional(),
  propertyType: z.string().nullable().optional(),
  surfaceKind: z.string().nullable().optional(),
  surfaceScope: z.string().nullable().optional(),
  pricePerM2Ref: z.number().nullable().optional(),
  surfaceM2: z.number().positive().nullable().optional(),
  landSurfaceM2: z.number().positive().nullable().optional(),
  roomsCount: z.number().int().min(0).max(200).nullable().optional(),
  surfaceEstimated: z.boolean().optional(),
  surfaceAssumption: z.string().max(300).nullable().optional(),
  surfaceUncertaintyPct: z.number().min(0).max(90).nullable().optional(),
});
