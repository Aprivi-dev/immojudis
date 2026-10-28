import { PLAN_LIMITS } from "@/lib/plans";
import { MONTHLY_UNLOCKS_TEXT } from "@/lib/sale-unlocks";

/**
 * Ce que devient un compte gratuit quand l'essai gratuit se termine : une seule liste, lue par
 * le bloc de /compte (`AccountLaunchOfferEnd`). Les chiffres viennent de `PLAN_LIMITS`.
 */
const free = PLAN_LIMITS.decouverte;

export const LAUNCH_OFFER_END_STAYS: readonly string[] = [
  `${free.favoriteSales} favoris`,
  `${free.watchedZones} alerte avec un email récapitulatif par semaine`,
  MONTHLY_UNLOCKS_TEXT,
  "« Mon dossier » : le statut et l’enchère plafond enregistrés sur vos favoris",
];

export const LAUNCH_OFFER_END_NEEDS_ANALYSIS: readonly string[] = [
  "le rapport PDF",
  "l’estimation détaillée et les ventes comparables",
  "les pièces du dossier et leur lecture sur toutes les ventes (avec le compte gratuit : vos déblocages par mois)",
  "les exports (PDF et CSV) et les rapports enregistrés",
];
