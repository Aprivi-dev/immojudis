import { parisDayMonthLabel, parisMonthName } from "@/lib/paris-month";
import { PLAN_LIMITS } from "@/lib/plans";

/**
 * « 3 déblocages par mois » (offre Découverte). Types et textes partagés par la route API, la base
 * de données (RPC `unlock_sale` / `get_sale_unlock_status`) et la fiche d'une vente. Module pur,
 * sans import serveur. Le nombre de déblocages vient de `PLAN_LIMITS.decouverte.monthlyUnlocks`.
 */

export const MONTHLY_SALE_UNLOCKS = PLAN_LIMITS.decouverte.monthlyUnlocks;

export type SaleUnlockStatus = {
  saleId: string | null;
  /** La vente est débloquée pour ce compte et toujours en ligne. */
  unlocked: boolean;
  /**
   * La vente peut être débloquée : en ligne et prête pour l'offre Analyse. Faux pour une vente qui
   * s'affiche en fiche gratuite mais que la base refuserait de débloquer (« Vente introuvable »).
   * Une base sans cette information (migration pas appliquée) répond `true`, comme avant.
   */
  unlockable: boolean;
  /** Le compte a déjà accès à toutes les ventes (Analyse, administrateur) : rien à débloquer. */
  analysisAccess: boolean;
  /** Déblocages par mois ; `null` quand le compte n'a pas à débloquer. */
  limit: number | null;
  used: number;
  remaining: number | null;
  /** Début du mois civil (heure de Paris), en ISO UTC. */
  periodStart: string;
  /** Remise à zéro du compteur : le 1er du mois suivant à 00 h 00, heure de Paris (ISO UTC). */
  resetsAt: string;
};

export type SaleUnlockResult = SaleUnlockStatus & {
  /** La vente était déjà débloquée : rien n'a été consommé. */
  alreadyUnlocked: boolean;
  /** Ce clic a consommé un déblocage. */
  consumed: boolean;
};

/** Une vente débloquée par le compte, telle que la liste « Mes ventes débloquées » l'affiche. */
export type UnlockedSaleSummary = {
  id: string;
  title: string | null;
  city: string | null;
  department: string | null;
  propertyType: string | null;
  startingPriceEur: number | null;
  saleDate: string | null;
  status: string | null;
};

/** Réponse de `GET /api/sale-unlocks` : le compteur du mois et les ventes débloquées en ligne. */
export type SaleUnlocksOverview = {
  status: SaleUnlockStatus;
  sales: UnlockedSaleSummary[];
};

/** Réponse de `POST /api/sales/[id]/unlock` quand le quota du mois est atteint. */
export type SaleUnlockQuotaReachedResponse = {
  error: string;
  code: "unlock_quota_reached";
  status: SaleUnlockStatus;
};

/**
 * Ce qu'un déblocage ouvre sur cette vente, en une phrase. L'enchère plafond n'existe que pour une
 * vente au tribunal, et les statistiques du tribunal tant que leur drapeau est ouvert : on ne
 * promet jamais un élément que la fiche n'affiche pas.
 */
export function unlockedItemsText({
  ceiling,
  statistics,
}: {
  ceiling: boolean;
  statistics: boolean;
}): string {
  const items = [
    ...(ceiling ? ["l’enchère plafond"] : []),
    "la lecture des pièces",
    "l’historique de la vente",
    ...(statistics ? ["les statistiques du tribunal"] : []),
    "les pièces du dossier",
  ];
  return `${items.slice(0, -1).join(", ")} et ${items[items.length - 1]}`;
}

/**
 * Les éléments que l'on cite en un mot pour présenter le compte gratuit (accueil). Une version
 * courte de `unlockedItemsText` : `sale-unlocks.test.ts` vérifie que chacun y figure, pour que les
 * deux ne dérivent pas. Ce qu'un déblocage ouvre dépend de la vente (l'enchère plafond n'existe que
 * pour une vente au tribunal) : on le dit, on ne promet pas la même chose pour toutes.
 */
export const UNLOCK_HIGHLIGHTS_TEXT =
  "enchère plafond (ventes au tribunal), lecture des pièces, historique, selon la vente";

/**
 * La même liste sans précision entre parenthèses, pour une phrase qui la met déjà entre
 * parenthèses (onboarding).
 */
export const UNLOCK_HIGHLIGHTS_INLINE_TEXT =
  "enchère plafond, lecture des pièces, historique, selon la vente";

function unlockCountLabel(count: number): string {
  return `${count} déblocage${count > 1 ? "s" : ""}`;
}

/** « Il vous reste 2 déblocages sur 3 ce mois-ci. » */
export function remainingUnlocksLine(status: Pick<SaleUnlockStatus, "remaining" | "limit">) {
  if (status.remaining == null || status.limit == null) return null;
  return `Il vous reste ${unlockCountLabel(status.remaining)} sur ${status.limit} ce mois-ci.`;
}

/** « Cette vente ne peut pas être débloquée pour le moment. » */
export const SALE_NOT_UNLOCKABLE_TEXT = "Cette vente ne peut pas être débloquée pour le moment.";

/** « Débloquer cette vente (il vous reste 2 sur 3) » : le lien principal des aperçus payants. */
export function unlockCallToActionLabel(status: Pick<SaleUnlockStatus, "remaining" | "limit">) {
  const limit = status.limit ?? MONTHLY_SALE_UNLOCKS;
  return `Débloquer cette vente (il vous reste ${status.remaining ?? 0} sur ${limit})`;
}

/** « Vos 3 déblocages d’octobre reviennent le 1er novembre. » */
export function unlockQuotaResetLine(
  status: Pick<SaleUnlockStatus, "limit" | "periodStart" | "resetsAt">,
) {
  const month = parisMonthName(status.periodStart);
  const ofMonth = /^[aeiouyàâéèêîôû]/i.test(month) ? `d’${month}` : `de ${month}`;
  return `Vos ${status.limit ?? MONTHLY_SALE_UNLOCKS} déblocages ${ofMonth} reviennent le ${parisDayMonthLabel(status.resetsAt)}.`;
}

/** « Déblocages ce mois-ci : 2 sur 3 utilisés. Remis à 3 le 1er novembre. » (page Mon compte) */
export function unlockUsageLine(
  status: Pick<SaleUnlockStatus, "limit" | "used" | "resetsAt">,
): string {
  const limit = status.limit ?? MONTHLY_SALE_UNLOCKS;
  const used = limit == null ? status.used : Math.min(status.used, limit);
  return `Déblocages ce mois-ci : ${used} sur ${limit} utilisés. Remis à ${limit} le ${parisDayMonthLabel(status.resetsAt)}.`;
}

/** « Ce déblocage est définitif : il n’est restitué que si Immojudis retire elle-même la vente (conditions générales, article 2). Le compteur est remis à 3 le 1er novembre. » */
export function unlockConfirmationText(status: Pick<SaleUnlockStatus, "limit" | "resetsAt">) {
  return `Ce déblocage est définitif : il n’est restitué que si Immojudis retire elle-même la vente (conditions générales, article 2). Le compteur est remis à ${status.limit ?? MONTHLY_SALE_UNLOCKS} le ${parisDayMonthLabel(status.resetsAt)}.`;
}

/** « Vous avez utilisé vos 3 déblocages d’octobre. Ils reviennent le 1er novembre. » */
export function unlockQuotaReachedText(
  status: Pick<SaleUnlockStatus, "limit" | "periodStart" | "resetsAt">,
) {
  const month = parisMonthName(status.periodStart);
  const ofMonth = /^[aeiouyàâéèêîôû]/i.test(month) ? `d’${month}` : `de ${month}`;
  return `Vous avez utilisé vos ${status.limit ?? MONTHLY_SALE_UNLOCKS} déblocages ${ofMonth}. Ils reviennent le ${parisDayMonthLabel(status.resetsAt)}.`;
}
