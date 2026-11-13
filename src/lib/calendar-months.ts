/**
 * Mois du calendrier comptés sur un instant, en UTC. Module pur, sans import : il part aussi dans le
 * navigateur avec les statistiques de tribunal. Les jours civils « AAAA-MM-JJ » sont dans
 * `calendar-day.ts`.
 */

/** Même jour et même heure UTC, `months` mois plus tard (ou plus tôt) ; ramené au dernier jour du mois. */
export function addUtcCalendarMonths(value: Date, months: number): Date {
  const target = new Date(
    Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth() + months,
      1,
      value.getUTCHours(),
      value.getUTCMinutes(),
      value.getUTCSeconds(),
      value.getUTCMilliseconds(),
    ),
  );
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(value.getUTCDate(), lastDay));
  return target;
}
