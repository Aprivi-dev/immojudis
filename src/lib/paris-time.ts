/**
 * Heure de Paris (Europe/Paris), seule source du fuseau de l'application : jour civil d'un instant,
 * minuit de Paris en UTC, début du jour et « date passée ». Le calcul sur des jours « AAAA-MM-JJ »
 * sans fuseau (écart, ajout, validité) est dans `calendar-day.ts`.
 */

export const PARIS_TIME_ZONE = "Europe/Paris";

// Un seul format : ce module est dans le JavaScript initial des pages (fiche, exemple, compte).
const PARIS_CLOCK = new Intl.DateTimeFormat("en-CA", {
  timeZone: PARIS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

function parisParts(instant: Date | number): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const { type, value } of PARIS_CLOCK.formatToParts(instant)) parts[type] = value;
  return parts;
}

/** Jour civil à Paris (« 2026-11-06 ») de cet instant. */
export function parisDateKey(instant: Date): string {
  const { year, month, day } = parisParts(instant);
  return `${year}-${month}-${day}`;
}

/** Jour civil à Paris d'une date écrite (ISO ou tout texte que `Date` lit) ; `null` sinon. */
export function parisDateKeyOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) ? parisDateKey(instant) : null;
}

/**
 * Instant UTC de 00 h 00 à Paris le jour `day` (AAAA-MM-JJ). L'heure affichée à Paris à 00 h 00 UTC
 * ce jour-là est le décalage (1 ou 2) : Paris ne change jamais d'heure entre minuit et 3 h, donc ce
 * décalage est aussi celui de son minuit, changements d'heure compris.
 */
export function parisMidnightUtc(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  const utcMidnight = Date.UTC(year, month - 1, date);
  return new Date(utcMidnight - Number(parisParts(utcMidnight).hour) * 3_600_000);
}

/** Début (00 h 00 à Paris) du jour civil qui contient `now`. */
export function startOfParisDay(now: Date): Date {
  return parisMidnightUtc(parisDateKey(now));
}

/**
 * La date est passée : son jour civil à Paris est avant celui de `now`. Un événement d'aujourd'hui,
 * même plus tôt dans la journée, n'est pas passé. Règle de « Date de vente passée » sur la fiche.
 */
export function isPastParisDay(value: string | null | undefined, now: Date = new Date()): boolean {
  const day = parisDateKeyOrNull(value);
  return day != null && day < parisDateKey(now);
}
