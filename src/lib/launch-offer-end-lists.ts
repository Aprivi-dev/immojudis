import { PLAN_LIMITS } from "@/lib/plans";
import { MONTHLY_SALE_UNLOCKS } from "@/lib/sale-unlocks";

/**
 * Ce que devient un compte gratuit quand l'offre de lancement se termine : une seule liste, lue par
 * le bloc de /compte (`AccountLaunchOfferEnd`) et par le préavis par email (`emails/launch-offer-end-notice`),
 * pour que les deux disent la même chose. Les chiffres viennent de `PLAN_LIMITS`.
 */
const free = PLAN_LIMITS.decouverte;

export const LAUNCH_OFFER_END_STAYS: readonly string[] = [
  `${free.favoriteSales} favoris`,
  `${free.watchedZones} alerte avec un email récapitulatif par semaine`,
  `${MONTHLY_SALE_UNLOCKS} déblocages de ventes par mois`,
  "« Mon dossier » : le statut et l’enchère plafond enregistrés sur vos favoris",
];

export const LAUNCH_OFFER_END_NEEDS_ANALYSIS: readonly string[] = [
  "le rapport PDF",
  "l’estimation détaillée et les ventes comparables",
  "les pièces du dossier et leur lecture sur toutes les ventes (avec le compte gratuit : les déblocages du mois)",
  "les exports (PDF et CSV) et les rapports enregistrés",
];
