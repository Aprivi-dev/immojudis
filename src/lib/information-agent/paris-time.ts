/**
 * Heure de Paris, module pur (aucun accès réseau ni base), utilisable côté serveur comme dans les règles
 * pures du pilote automatique.
 */
/**
 * Début du jour (heure de Paris) qui contient `now`. Le plafond quotidien suit le jour calendaire
 * français, pas une fenêtre glissante de 24 heures.
 */
export function startOfParisDay(now: Date): Date {
  const { year, month, day } = parisClock(now);
  const midnightAsUtc = Date.UTC(year, month - 1, day);
  // Le décalage de Paris est celui de minuit, pas celui de l'instant donné : les jours de changement
  // d'heure, ils diffèrent d'une heure. Deux passes suffisent (minuit n'est jamais dans l'heure sautée).
  let start = midnightAsUtc - parisOffsetMs(now);
  start = midnightAsUtc - parisOffsetMs(new Date(start));
  return new Date(start);
}

function parisClock(at: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    second: part("second"),
  };
}

/** Décalage de l'heure de Paris sur UTC à l'instant donné (une ou deux heures), en millisecondes. */
function parisOffsetMs(at: Date): number {
  const clock = parisClock(at);
  const localAsUtc = Date.UTC(
    clock.year,
    clock.month - 1,
    clock.day,
    clock.hour,
    clock.minute,
    clock.second,
  );
  return localAsUtc - Math.floor(at.getTime() / 1000) * 1000;
}

type ParisParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 1 = lundi … 7 = dimanche. */
  weekday: number;
};

const PARIS_WEEKDAYS: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** Date et heure civiles à Paris (heure d'été et changement d'heure compris). */
function parisParts(now: Date): ParisParts {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    hour: Number(value("hour")),
    minute: Number(value("minute")),
    weekday: PARIS_WEEKDAYS[value("weekday")] ?? 1,
  };
}

/** Dimanche de Pâques (algorithme de Meeus/Jones/Butcher), en jour civil. */
function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/** Jours fériés français (8 fixes + lundi de Pâques, Ascension, lundi de Pentecôte), en `YYYY-MM-DD`. */
export function frenchPublicHolidays(year: number): Set<string> {
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  const easter = easterSunday(year);
  const easterDate = new Date(Date.UTC(year, easter.month - 1, easter.day));
  const plusDays = (days: number) => iso(new Date(easterDate.getTime() + days * 86_400_000));
  const fixed = ["01-01", "05-01", "05-08", "07-14", "08-15", "11-01", "11-11", "12-25"].map(
    (monthDay) => `${year}-${monthDay}`,
  );
  return new Set([...fixed, plusDays(1), plusDays(39), plusDays(50)]);
}

function isFrenchPublicHoliday(parts: Pick<ParisParts, "year" | "month" | "day">): boolean {
  const key = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  return frenchPublicHolidays(parts.year).has(key);
}

/**
 * Plage d'envoi du pilote : lundi au vendredi hors jours fériés, 9 h 30 à 11 h 30 et 14 h à 16 h 30
 * (Europe/Paris). La borne de fin est exclue.
 */
export function isWithinAutopilotSendWindow(now: Date): boolean {
  const parts = parisParts(now);
  if (parts.weekday > 5 || isFrenchPublicHoliday(parts)) return false;
  const minutes = parts.hour * 60 + parts.minute;
  return (
    (minutes >= 9 * 60 + 30 && minutes < 11 * 60 + 30) ||
    (minutes >= 14 * 60 && minutes < 16 * 60 + 30)
  );
}
