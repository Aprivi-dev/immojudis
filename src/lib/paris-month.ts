/**
 * Mois civil à l'heure de Paris (Europe/Paris).
 *
 * Les compteurs mensuels (déblocages d'une vente, rapports, exports) se remettent à zéro le
 * 1er du mois à 00 h 00 heure de Paris, et non à minuit UTC (01 h ou 02 h à Paris). La base de
 * données applique la même règle (`app_private.sale_unlock_period`). Module pur, sans import
 * serveur : utilisable côté serveur, dans le navigateur et dans les tests.
 */

const PARIS_TIME_ZONE = "Europe/Paris";

const PARIS_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: PARIS_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

type ParisParts = { year: number; month: number; day: number };

function parisParts(instant: Date): ParisParts & { asUtcMs: number } {
  const values: Record<string, number> = {};
  for (const part of PARIS_PARTS.formatToParts(instant)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    asUtcMs: Date.UTC(
      values.year,
      values.month - 1,
      values.day,
      values.hour,
      values.minute,
      values.second,
    ),
  };
}

/** Instant UTC correspondant au 1er du mois (0 h 00, heure de Paris) de `year`/`month` (1-12). */
function parisMonthStart(year: number, month: number): Date {
  // Normalise le dépassement de mois (13 -> janvier de l'année suivante).
  const wallClockUtc = Date.UTC(year, month - 1, 1, 0, 0, 0);
  let candidate = wallClockUtc;
  // Deux passes suffisent : le décalage de Paris ne change qu'à des dates qui ne sont jamais un 1er.
  for (let pass = 0; pass < 2; pass += 1) {
    const offset = parisParts(new Date(candidate)).asUtcMs - candidate;
    candidate = wallClockUtc - offset;
  }
  return new Date(candidate);
}

export type ParisMonthWindow = {
  /** Début du mois (1er, 0 h 00 heure de Paris), en ISO UTC. */
  periodStart: string;
  /** Début du mois suivant : instant de la remise à zéro du compteur, en ISO UTC. */
  periodEnd: string;
};

export function parisMonthWindow(now: Date = new Date()): ParisMonthWindow {
  const { year, month } = parisParts(now);
  return {
    periodStart: parisMonthStart(year, month).toISOString(),
    periodEnd: parisMonthStart(year, month + 1).toISOString(),
  };
}

const MONTH_NAME = new Intl.DateTimeFormat("fr-FR", { month: "long", timeZone: PARIS_TIME_ZONE });
const DAY_NUMBER = new Intl.DateTimeFormat("fr-FR", { day: "numeric", timeZone: PARIS_TIME_ZONE });

/** « octobre » : nom du mois civil (heure de Paris) qui contient `instant`. */
export function parisMonthName(instant: string | Date): string {
  return MONTH_NAME.format(new Date(instant));
}

/** « 1er novembre » : jour et mois (heure de Paris) d'un instant, avec « 1er » pour le premier. */
export function parisDayMonthLabel(instant: string | Date): string {
  const date = new Date(instant);
  const day = Number(DAY_NUMBER.format(date));
  return `${day === 1 ? "1er" : String(day)} ${MONTH_NAME.format(date)}`;
}
