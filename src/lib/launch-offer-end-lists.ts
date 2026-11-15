import { PLAN_LIMITS } from "@/lib/plans";
import { FREE_UNLOCK_TEXT } from "@/lib/sale-unlocks";

/**
 * Ce que devient un compte gratuit quand l'essai gratuit se termine : une seule liste, lue par
 * le bloc de /compte (`AccountLaunchOfferEnd`) et l'email de fin d'essai (`trial-end-email.ts`).
 * Les chiffres viennent de `PLAN_LIMITS`.
 */
const free = PLAN_LIMITS.decouverte;
const analysis = PLAN_LIMITS.analyse;

export const LAUNCH_OFFER_END_STAYS: readonly string[] = [
  `${free.favoriteSales} favoris`,
  `${free.watchedZones} alerte avec un email récapitulatif par semaine`,
  FREE_UNLOCK_TEXT,
  "« Mon dossier » : le statut et l’enchère plafond enregistrés sur vos favoris",
];

/**
 * Le bénéfice d'abord (le plafond de chaque vente, l'alerte chaque jour), le PDF une seule fois. Ce
 * qu'un déblocage ouvre sur sa vente (plafond, estimation, comparables, rapport, pièces) est dit entre
 * parenthèses : ce n'est réservé à Analyse que sur les autres ventes (décision du 15/11/2026). Les
 * rapports enregistrés sont dits par `LAUNCH_OFFER_DATA_TEXT`, affiché à côté de cette liste.
 */
export const LAUNCH_OFFER_END_NEEDS_ANALYSIS: readonly string[] = [
  "le plafond chiffré sur toutes les ventes (compte gratuit : une vente débloquée)",
  `jusqu’à ${analysis.watchedZones} alertes, chaque jour (compte gratuit : ${free.watchedZones}, chaque semaine)`,
  "l’estimation détaillée et les ventes comparables sur toutes les ventes (compte gratuit : une vente débloquée)",
  "le rapport PDF et l’export CSV (compte gratuit : le rapport de la vente débloquée)",
  "les pièces du dossier et leur lecture sur toutes les ventes (compte gratuit : vos ventes débloquées)",
];
