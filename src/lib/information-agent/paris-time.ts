/**
 * Calendrier d'envoi du pilote automatique à l'heure de Paris (jours fériés, plage d'envoi), module
 * pur (aucun accès réseau ni base).
 */
import { PARIS_TIME_ZONE } from "@/lib/paris-time";

// Le plafond quotidien du pilote suit le jour civil de Paris, pas une fenêtre glissante de 24 heures.
// Repris par les modules du pilote qui le lisaient ici avant `@/lib/paris-time`.
export { startOfParisDay } from "@/lib/paris-time";

type ParisParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 1 = lundi … 7 = dimanche. */
  weekday: number;
};

// Heure et minute à Paris : seul le pilote en a besoin, le module commun ne donne que le jour civil.
const PARIS_WALL_CLOCK = new Intl.DateTimeFormat("en-CA", {
  timeZone: PARIS_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** Date et heure civiles à Paris (heure d'été et changement d'heure compris). */
function parisParts(now: Date): ParisParts {
  const values: Record<string, number> = {};
  for (const part of PARIS_WALL_CLOCK.formatToParts(now)) values[part.type] = Number(part.value);
  const { year, month, day, hour, minute } = values;
  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7,
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
