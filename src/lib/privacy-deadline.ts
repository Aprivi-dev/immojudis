/** Browser-safe deadline arithmetic for data-subject requests (GDPR art. 12(3): one month). */

export const PRIVACY_DEADLINE_WARNING_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1_000;

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
    const late = Math.abs(deadline.daysRemaining);
    return `En retard de ${late} jour${late > 1 ? "s" : ""}`;
  }
  if (deadline.daysRemaining === 0) return "Échéance aujourd'hui";
  return `${deadline.daysRemaining} jour${deadline.daysRemaining > 1 ? "s" : ""} restant${deadline.daysRemaining > 1 ? "s" : ""}`;
}
