/**
 * Browser-safe deadline arithmetic for data-subject requests (GDPR art. 12(3): one month; a contract
 * withdrawal: 14 days). The due date itself is set by the database (`due_at`, migration
 * 20261202100000); the constants below only describe it, and a test compares them with the migration.
 */

/** J-7 : seuil de l'alerte « échéance proche », le même que `compliance.privacy_requests.due_soon`. */
export const PRIVACY_DEADLINE_WARNING_DAYS = 7;
/** Rétractation : remboursement au plus tard 14 jours après la notification (art. L. 221-24). */
export const CONTRACT_WITHDRAWAL_RESPONSE_DAYS = 14;
/**
 * Délai de rétractation : 14 jours à compter de la conclusion du contrat, c'est-à-dire du paiement pour
 * un achat à l'unité (art. L. 221-18). Distinct du délai de réponse ci-dessus, qui court de la demande.
 */
export const WITHDRAWAL_PERIOD_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** Délai de réponse affiché pour un type de demande. */
export function privacyResponseDelayLabel(requestType: string): string {
  return requestType === "contract_withdrawal"
    ? `délai de ${CONTRACT_WITHDRAWAL_RESPONSE_DAYS} jours`
    : "délai d’un mois";
}

/** Le paiement a-t-il eu lieu dans le délai de rétractation ? */
export function withinWithdrawalPeriod(paidAt: string | null, now: Date = new Date()): boolean {
  if (!paidAt) return false;
  const paid = new Date(paidAt).getTime();
  return Number.isFinite(paid) && now.getTime() - paid < WITHDRAWAL_PERIOD_DAYS * DAY_MS;
}

export type PrivacyDeadlineStatus = {
  /** Whole days left (rounded up); negative once overdue; null when the request is closed. */
  daysRemaining: number | null;
  overdue: boolean;
  /** Open request due within PRIVACY_DEADLINE_WARNING_DAYS (J-7 alert), not yet overdue. */
  dueSoon: boolean;
};

export function privacyDeadlineStatus(
  dueAt: string,
  status: string,
  now: Date = new Date(),
): PrivacyDeadlineStatus {
  if (status === "completed" || status === "rejected") {
    return { daysRemaining: null, overdue: false, dueSoon: false };
  }
  const due = new Date(dueAt).getTime();
  if (!Number.isFinite(due)) return { daysRemaining: null, overdue: false, dueSoon: false };
  const daysRemaining = Math.ceil((due - now.getTime()) / DAY_MS);
  const overdue = due < now.getTime();
  return {
    daysRemaining,
    overdue,
    dueSoon: !overdue && daysRemaining <= PRIVACY_DEADLINE_WARNING_DAYS,
  };
}

export function privacyDeadlineLabel(deadline: PrivacyDeadlineStatus): string {
  if (deadline.daysRemaining === null) return "Clôturée";
  if (deadline.overdue) {
    // Dépassée depuis moins d'un jour : `Math.ceil` donne -0, jamais « En retard de 0 jour ».
    const late = Math.abs(deadline.daysRemaining);
    if (late === 0) return "Échéance dépassée aujourd'hui";
    return `En retard de ${late} jour${late > 1 ? "s" : ""}`;
  }
  if (deadline.daysRemaining === 0) return "Échéance aujourd'hui";
  return `${deadline.daysRemaining} jour${deadline.daysRemaining > 1 ? "s" : ""} restant${deadline.daysRemaining > 1 ? "s" : ""}`;
}
