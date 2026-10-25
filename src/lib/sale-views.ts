// Browser-safe constants shared by client queries and server routes. Keep this module
// free of Supabase client imports so server code never pulls the browser client in.
import { joinColumns } from "@/lib/supabase-select";

export const DETAIL_VIEW = "v_auction_sales_app";
/** Redacted catalogue view of a Découverte account (no score, risks or documents). */
export const DISCOVERY_VIEW = "v_auction_sales_discovery";
/**
 * The sales the signed-in account unlocked (« 3 déblocages par mois »): the discovery columns plus
 * the listing facts the bid ceiling reads and the official documents. It lists nothing else.
 */
export const UNLOCKED_VIEW = "v_auction_sales_unlocked";

const SALE_LIST_COLUMN_NAMES = [
  "source_checks",
  "source_conflicts",
  "analysis_status",
  "source_presence",
  "sale_procedure",
  "sale_venue_type",
  "sale_legal_framework",
  "sale_verification_status",
  "id",
  "title",
  "description",
  "source_description",
  "llm_display_description",
  "about_description",
  "city",
  "department",
  "postal_code",
  "address",
  "tribunal",
  "tribunal_code",
  "tribunal_name",
  "tribunal_city",
  "property_type",
  "starting_price_eur",
  "sale_date",
  "visit_dates",
  "lawyer_name",
  "lawyer_contact",
  "adjudication_price_eur",
  "latitude",
  "longitude",
  "occupancy_status",
  "surface_m2",
  "habitable_surface_m2",
  "carrez_surface_m2",
  "land_surface_m2",
  "app_surface_m2",
  "app_surface_kind",
  "surface_scope",
  "surface_source",
  "rooms_count",
  "bedrooms_count",
  "bathrooms_count",
  "has_garden",
  "has_terrace",
  "has_garage",
  "has_pool",
  "has_air_conditioning",
  "has_double_glazing",
  "investment_score",
  "score_confidence",
  "surface_confidence",
  "surface_evidence",
  "risks",
  "documents",
  "documents_rich",
  "media",
  "source_name",
  "source_url",
  "primary_source",
  "source_urls",
  "source_blocks",
  "source_blocks_by_source",
  "dedupe_confidence",
  "quality_flags",
  "status",
  "created_at",
  "updated_at",
] as const;

// Littéral typé : le client Supabase infère ainsi les lignes sélectionnées.
export const SALE_LIST_COLUMNS = joinColumns(SALE_LIST_COLUMN_NAMES);

/**
 * Colonnes lues par le service des alertes et lourdes à produire par la vue (blocs des sources,
 * pièces, photos) : elles ne sont relues que pour les ventes qu'une alerte retient déjà sur les autres
 * critères (classe DPE, résumé enregistré avec la correspondance).
 */
export const ALERT_DETAIL_COLUMN_NAMES = ["source_blocks", "documents", "documents_rich"] as const;

/**
 * Colonnes inutiles à l'évaluation d'une alerte, et coûteuses : textes, provenance, photos.
 * Le texte libre d'une alerte n'est pas évalué (seul un secteur l'est, voir `src/lib/alerts.ts`).
 */
const ALERT_SKIPPED_COLUMN_NAMES: ReadonlySet<string> = new Set([
  ...ALERT_DETAIL_COLUMN_NAMES,
  "source_blocks_by_source",
  "media",
  "description",
  "source_description",
  "llm_display_description",
  "about_description",
  "surface_evidence",
  "source_checks",
  "source_conflicts",
  "source_presence",
  "analysis_status",
  "risks",
  "quality_flags",
]);

/**
 * Colonnes du catalogue lues pour toutes les ventes à évaluer par les alertes. Une page de 400 ventes
 * avec toutes les colonnes de la liste dépassait le délai de 8 s d'une requête (environ 17 s) ; sans
 * les colonnes ci-dessus, elle prend moins d'une seconde.
 */
export const ALERT_EVALUATION_COLUMNS = SALE_LIST_COLUMN_NAMES.filter(
  (column) => !ALERT_SKIPPED_COLUMN_NAMES.has(column),
).join(",");
export const ALERT_DETAIL_COLUMNS = ["id", ...ALERT_DETAIL_COLUMN_NAMES].join(",");
