/**
 * Jours civils écrits « AAAA-MM-JJ », sans fuseau horaire : validité, écart en jours et ajout de jours.
 * Module pur, sans import ni `Intl` : l'état de recherche le charge dans le JavaScript initial de toutes
 * les pages. Ce qui dépend de l'heure de Paris (jour d'un instant, minuit de Paris) est dans `paris-time.ts`.
 */

const DAY_MS = 86_400_000;
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Minuit UTC du jour « AAAA-MM-JJ », ou `null` si ce n'est pas un jour du calendrier. */
function dateKeyUtc(day: string): number | null {
  const match = DATE_KEY.exec(day);
  if (!match) return null;
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(timestamp).toISOString().slice(0, 10) === day ? timestamp : null;
}

/** Vrai pour un jour du calendrier écrit « AAAA-MM-JJ » (« 2026-02-30 » n'en est pas un). */
export function isCalendarDay(value: unknown): value is string {
  return typeof value === "string" && dateKeyUtc(value) != null;
}

/** Nombre de jours civils de `from` à `to` (AAAA-MM-JJ) ; `null` si une date n'existe pas. */
export function calendarDaysBetween(from: string, to: string): number | null {
  const start = dateKeyUtc(from);
  const end = dateKeyUtc(to);
  return start == null || end == null ? null : Math.round((end - start) / DAY_MS);
}

/** Le jour civil `days` jours après `day` (AAAA-MM-JJ ; `days` négatif : avant). */
export function addDays(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

/** La valeur si c'est un jour du calendrier « AAAA-MM-JJ », `undefined` sinon. */
export function validCalendarDay(value: unknown): string | undefined {
  return isCalendarDay(value) ? value : undefined;
}
