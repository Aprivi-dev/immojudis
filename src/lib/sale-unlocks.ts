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

function unlockCountLabel(count: number): string {
  return `${count} déblocage${count > 1 ? "s" : ""}`;
}

/** « Il vous reste 2 déblocages sur 3 ce mois-ci. » */
export function remainingUnlocksLine(status: Pick<SaleUnlockStatus, "remaining" | "limit">) {
  if (status.remaining == null || status.limit == null) return null;
  return `Il vous reste ${unlockCountLabel(status.remaining)} sur ${status.limit} ce mois-ci.`;
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
