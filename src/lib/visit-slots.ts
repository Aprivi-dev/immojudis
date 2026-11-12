import { cleanVisitText } from "@/lib/listing-data-cleanup";

/**
 * Créneaux de visite publiés par les annonces (`auction_sales.visit_dates`), lus pour l'agenda.
 *
 * Les annonces donnent du texte (« 2026-10-02 à 14:00 », « mardi 6 octobre 2026 à 10h30 »), pas une
 * date structurée. Un créneau n'entre dans un agenda que si son jour est complet (jour, mois ET
 * année) : « mardi 20 octobre », « sur rendez-vous » ou un texte libre n'ont pas de jour sourcé, ils
 * ne produisent rien et ne sont jamais devinés. Un texte qui contient plusieurs dates est ambigu :
 * il est écarté lui aussi. L'heure est celle de l'annonce, lue comme heure de Paris.
 */
export type VisitSlot =
  | { kind: "instant"; at: Date }
  | {
      kind: "day";
      /** Jour civil, `AAAA-MM-JJ`. */
      isoDay: string;
    };

const FRENCH_MONTHS = [
  "janvier",
  "fevrier",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "aout",
  "septembre",
  "octobre",
  "novembre",
  "decembre",
];

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function validParts(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

const PARIS_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Paris",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** Décalage de Paris par rapport à UTC (en minutes) à cet instant. */
function parisOffsetMinutes(at: Date): number {
  const parts = Object.fromEntries(
    PARIS_PARTS.formatToParts(at).map((part) => [part.type, Number(part.value)]),
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return Math.round((asUtc - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
}

/** L'instant d'une heure murale de Paris (`2026-10-02 14:00` donne 12:00 UTC en heure d'été). */
export function parisWallTimeToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // Deux passes : le décalage se lit à l'instant cherché, qu'on ne connaît qu'à ce décalage près.
  let instant = wall - parisOffsetMinutes(new Date(wall)) * 60_000;
  instant = wall - parisOffsetMinutes(new Date(instant)) * 60_000;
  return new Date(instant);
}

function validTime(hour: number, minute: number): boolean {
  return Number.isInteger(hour) && hour >= 0 && hour < 24 && minute >= 0 && minute < 60;
}

const ISO_DAY = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const ISO_ZONED = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;
const FRENCH_DAY = new RegExp(
  `\\b(\\d{1,2})(?:er)?\\s+(${FRENCH_MONTHS.join("|")})\\s+(\\d{4})\\b`,
  "g",
);

/** `14:00`, `14h`, `14h30` placé juste après la date (« à » facultatif). */
function timeAfter(text: string, from: number): { hour: number; minute: number } | null {
  const match = /^\s*(?:[,;-]\s*)?(?:a\s+|de\s+|vers\s+)?(\d{1,2})\s*(?:h|:)\s*(\d{2})?(?!\d)/.exec(
    text.slice(from),
  );
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  return validTime(hour, minute) ? { hour, minute } : null;
}

/**
 * Le créneau de visite d'un texte d'annonce, ou `null` s'il n'a pas de jour complet et sans
 * ambiguïté. Formes lues : instant ISO avec fuseau, `AAAA-MM-JJ[ à HH:MM]`, `[jour] J mois AAAA[ à HHhMM]`.
 */
export function parseVisitSlot(value: unknown): VisitSlot | null {
  const cleaned = cleanVisitText(value);
  if (!cleaned) return null;

  const zoned = ISO_ZONED.exec(cleaned);
  if (zoned) {
    const at = new Date(cleaned);
    return Number.isFinite(at.getTime()) ? { kind: "instant", at } : null;
  }

  const text = normalize(cleaned).replace(/t(?=\d{2}:\d{2})/, " ");
  const found: Array<{ year: number; month: number; day: number; end: number }> = [];
  for (const match of text.matchAll(ISO_DAY)) {
    found.push({
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      end: (match.index ?? 0) + match[0].length,
    });
  }
  for (const match of text.matchAll(FRENCH_DAY)) {
    found.push({
      year: Number(match[3]),
      month: FRENCH_MONTHS.indexOf(match[2]) + 1,
      day: Number(match[1]),
      end: (match.index ?? 0) + match[0].length,
    });
  }
  if (found.length !== 1) return null;

  const [{ year, month, day, end }] = found;
  if (year < 2000 || year > 2100 || !validParts(year, month, day)) return null;
  const time = timeAfter(text, end);
  if (!time) {
    return {
      kind: "day",
      isoDay: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    };
  }
  return { kind: "instant", at: parisWallTimeToInstant(year, month, day, time.hour, time.minute) };
}

/** Les textes de `visit_dates` : une liste de textes, ou un seul texte. */
function visitDateTexts(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map(cleanVisitText).filter((text): text is string => text !== null);
}

/** Les créneaux datés d'une vente, dédoublonnés et dans l'ordre. */
export function visitSlots(value: unknown): VisitSlot[] {
  const slots = new Map<string, VisitSlot>();
  for (const text of visitDateTexts(value)) {
    const slot = parseVisitSlot(text);
    if (!slot) continue;
    slots.set(slot.kind === "instant" ? slot.at.toISOString() : slot.isoDay, slot);
  }
  const startOf = (slot: VisitSlot) =>
    slot.kind === "instant" ? slot.at.getTime() : Date.parse(`${slot.isoDay}T00:00:00Z`);
  return [...slots.values()].sort((a, b) => startOf(a) - startOf(b));
}
