/**
 * Règles de dates communes aux deux constructeurs de statistiques d'un tribunal : l'activité
 * judiciaire (`tribunal-judicial-activity.ts`) et les statistiques d'annonces
 * (`tribunal-listing-statistics.ts`). Module léger : il part aussi dans le navigateur avec eux.
 */
import { publishedDay } from "@/lib/listing-evidence";
import { parisDateKey } from "@/lib/paris-time";

/**
 * Vrai si la liste publie au moins une date de visite lisible : un instant, un jour ISO, une date
 * française (« 22 août 2026 ») ou numérique (« 22/08/2026 »), lue aussi au milieu d'un texte
 * (« le 22/08/2026 de 10 h à 12 h »), comme `publishedDay`.
 */
export function hasVisitDate(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((item) => typeof item === "string" && publishedVisitDay(item) !== null)
  );
}

function publishedVisitDay(value: string): string | null {
  const parsed = publishedDay(value);
  if (parsed) return parsed;
  const match = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(value.trim());
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day, 12));
  return candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
    ? candidate.toISOString().slice(0, 10)
    : null;
}

/** Nombre d'audiences par jour de Paris, pour les dates antérieures à `end`, par jour croissant. */
export function hearingCalendar(
  saleDates: readonly Date[],
  end: Date,
): Array<{ date: string; sales: number }> {
  const counts = new Map<string, number>();
  for (const saleDate of saleDates) {
    if (saleDate >= end) continue;
    const date = parisDateKey(saleDate);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, sales]) => ({ date, sales }));
}

export function assertValidDate(value: Date, label: string): void {
  if (!Number.isFinite(value.getTime())) throw new Error(`${label} must be a valid date.`);
}

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
