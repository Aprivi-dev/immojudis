import { loginPathWithRedirect, pathWithSearch } from "@/lib/navigation";
import {
  validateSalesSearch,
  type SalesSearchParams,
  type SalesSearchUrlRecord,
} from "@/lib/search/search-url-state";
import type { UserAlert } from "@/lib/types";

/** Critères publics seulement : ni note, rendement, écart au marché, occupation, DPE, terrain ni texte libre. */
function hasPublicAlertCriteriaOnly(alert: UserAlert): boolean {
  return (
    alert.min_investment_score == null &&
    alert.min_yield_pct == null &&
    alert.min_market_discount_pct == null &&
    alert.occupancy_status == null &&
    !alert.dpe_classes?.length &&
    !alert.require_house_with_land &&
    !alert.advanced_criteria?.query
  );
}

/** Also enforced by the database; checked again for old alerts after downgrade. */
export function isDiscoveryAlertCompatible(alert: UserAlert): boolean {
  return hasPublicAlertCriteriaOnly(alert) && alert.alert_frequency === "weekly";
}

/**
 * Alerte qu'un compte Découverte garde à l'évaluation : critères publics, hebdomadaire ou quotidienne.
 * Une alerte quotidienne vient de l'essai de l'offre Analyse : après l'essai, elle est évaluée et
 * notifiée en hebdomadaire (`alert-matches.ts`), au lieu de ne plus être évaluée du tout.
 */
export function isDiscoveryAlertEvaluable(alert: UserAlert): boolean {
  return (
    hasPublicAlertCriteriaOnly(alert) &&
    (alert.alert_frequency === "weekly" || alert.alert_frequency === "daily")
  );
}

/** Page où l'on confirme une alerte demandée depuis un secteur (département, tribunaux). */
export const ALERT_CREATION_PATH = "/alertes/creer";

/** Longueur maximale du tribunal gardé par une alerte (le nom d'un tribunal reste bien en deçà). */
const MAX_ALERT_TRIBUNAL_LENGTH = 80;

/**
 * Les critères publics qu'une alerte gratuite accepte : zone, tribunal, type de vente, type de bien
 * (un seul), mise à prix maximale, surface minimale et « Seulement les pépites ». Tout le reste d'une
 * adresse saisie à la main (texte libre, DPE, rendement…) est ignoré : la page de confirmation ne
 * crée que ce qu'elle affiche, quelle que soit l'adresse reçue.
 */
export function publicAlertCriteria(record: Record<string, unknown>): SalesSearchParams {
  const search = validateSalesSearch(record);
  return {
    department: search.department,
    city: search.city,
    // Le tribunal d'une page `/tribunaux/<code>` (même texte que le filtre du catalogue), borné.
    tribunal:
      search.tribunal && search.tribunal.length <= MAX_ALERT_TRIBUNAL_LENGTH
        ? search.tribunal
        : undefined,
    saleType: search.saleType,
    homeTypes: search.homeTypes?.length === 1 ? search.homeTypes : undefined,
    maxPrice: search.maxPrice,
    minSqft: search.minSqft,
    // « Seulement les pépites » : un critère public (le repère est visible de tous), gardé par l'alerte gratuite.
    pepite: search.pepite,
  };
}

/** Adresse de confirmation d'une alerte pour ces critères publics (ni vide ni autre qu'eux). */
export function alertCreationPath(criteria: SalesSearchUrlRecord): string {
  return pathWithSearch(ALERT_CREATION_PATH, criteria);
}

/**
 * Chemin d'un visiteur non connecté : connexion avec le motif « alerte », puis retour à la page de
 * confirmation où il retrouve les critères qu'il avait choisis.
 */
export function alertCreationLoginPath(criteria: SalesSearchUrlRecord): string {
  return loginPathWithRedirect(alertCreationPath(criteria), { reason: "alerte" });
}
