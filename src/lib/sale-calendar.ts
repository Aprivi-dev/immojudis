import { buildIcsCalendar, buildIcsCalendarMany, type IcsEvent } from "@/lib/ical";
import { parisDateKey } from "@/lib/sale-countdown";
import { saleHearingTime, saleReference, seoPropertyLabel, tribunalDisplayName } from "@/lib/seo";

/**
 * Row returned by `get_public_sale_calendar_event`: the few public facts the « Ajouter à mon
 * agenda » file needs. The database function answers `exportable = false` (and no fact) when the
 * date is postponed, in conflict, unverified, has no usable day, or when the sale is not a
 * tribunal hearing: the server never writes a date it does not consider reliable.
 */
export type SaleCalendarRow = {
  id: string;
  exportable: boolean;
  sale_date: string | null;
  date_only: boolean | null;
  property_type: string | null;
  city: string | null;
  tribunal_name: string | null;
  tribunal_city: string | null;
  updated_at: string | null;
};

export type SaleCalendarFile = { filename: string; body: string };

const PROD_ID = "-//Immojudis//Audiences d’adjudication//FR";

export const SALE_CALENDAR_DISCLAIMER =
  "Date issue de l’annonce, à vérifier auprès de l’avocat poursuivant.";

/**
 * Durée par défaut d'une audience dont l'heure est connue : 2 h. Les annonces ne publient que
 * l'heure de début ; sans fin, chaque agenda invente la sienne (30 min, 1 h…) et l'audience se
 * superpose à d'autres événements. Les 2 h sont indicatives et le fichier le dit (voir la
 * description) : une audience d'adjudication peut compter plusieurs dossiers.
 */
export const SALE_HEARING_DEFAULT_DURATION_HOURS = 2;

/**
 * Rappels de l'agenda : sept jours avant (le temps de réunir garantie et financement) et la veille.
 * Un événement horaire sonne à l'heure de l'audience, ces jours-là. Un événement sur la journée
 * n'a pas d'heure : à minuit, le rappel réveillerait quelqu'un, il est donc décalé à 9 h (heure
 * locale de l'agenda, une date sans heure étant flottante).
 */
const REMINDERS_TIMED = [
  { trigger: "-P7D", when: "dans 7 jours" },
  { trigger: "-P1D", when: "demain" },
] as const;
const REMINDERS_ALL_DAY = [
  { trigger: "-P6DT15H", when: "dans 7 jours" },
  { trigger: "-PT15H", when: "demain" },
] as const;

/** Origine de la numérotation de `SEQUENCE` : le début de l'année du lancement. */
const SEQUENCE_EPOCH_MS = Date.UTC(2026, 0, 1);

/**
 * `SEQUENCE` d'un événement : les minutes écoulées depuis le 1er janvier 2026 à la dernière
 * modification de la vente. Un agenda qui connaît déjà l'UID remplace son événement quand le fichier
 * porte un numéro plus grand ; une vente modifiée (date reportée, par exemple) en reçoit donc un
 * plus grand sans qu'aucun compteur ne soit stocké. Sans date de modification : 0.
 */
export function saleCalendarSequence(updatedAt: Date | null): number {
  if (!updatedAt) return 0;
  return Math.max(0, Math.floor((updatedAt.getTime() - SEQUENCE_EPOCH_MS) / 60_000));
}

/** Stable identifier of the event: `sale-<id>@<domain>`, lower-cased like the canonical URL. */
export function saleCalendarUid(saleId: string, origin: string): string {
  return `sale-${saleId.toLowerCase()}@${new URL(origin).hostname}`;
}

function validDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * The calendar event of one hearing, or `null` when the row must not be exported.
 *
 * - A hearing whose hour is unknown (`date_only`, or a stored midnight) becomes an all-day event
 *   on its Paris civil day: no hour is ever invented.
 * - A timed hearing is written in UTC (`…Z`): every calendar converts it to the viewer's zone,
 *   and no VTIMEZONE block can be wrong.
 * - The location is the court only (its public name). The property address is never written: it
 *   is reserved to signed-in accounts.
 */
function saleCalendarEvent(
  row: SaleCalendarRow,
  { origin, now = new Date() }: { origin: string; now?: Date },
): IcsEvent | null {
  if (!row.exportable) return null;
  const date = validDate(row.sale_date);
  if (!date) return null;

  const saleId = row.id.toLowerCase();
  const url = `${origin}/sales/${encodeURIComponent(saleId)}`;
  const timed = row.date_only === false && saleHearingTime(row.sale_date) != null;
  const city = row.city?.replace(/\s+/g, " ").trim();
  const summary = `Audience d’adjudication – ${seoPropertyLabel(row.property_type)}${
    city ? ` à ${city}` : ""
  }`;
  const location = tribunalDisplayName({
    tribunal_name: row.tribunal_name,
    tribunal_city: row.tribunal_city,
  });

  const lastModified = validDate(row.updated_at);
  const description = [
    SALE_CALENDAR_DISCLAIMER,
    `Fiche de la vente : ${url}`,
    timed
      ? `Durée indicative : ${SALE_HEARING_DEFAULT_DURATION_HOURS} h (l’annonce ne publie pas l’heure de fin).`
      : null,
  ]
    .filter((line) => line !== null)
    .join("\n");

  return {
    uid: saleCalendarUid(saleId, origin),
    stamp: now,
    lastModified,
    sequence: saleCalendarSequence(lastModified),
    start: timed ? { kind: "instant", at: date } : { kind: "day", isoDay: parisDateKey(date) },
    end: timed ? new Date(date.getTime() + SALE_HEARING_DEFAULT_DURATION_HOURS * 3_600_000) : null,
    summary,
    description,
    location,
    url,
    // The date comes from the announcement: the calendar shows it as to be confirmed.
    status: "TENTATIVE",
    alarms: (timed ? REMINDERS_TIMED : REMINDERS_ALL_DAY).map((reminder) => ({
      trigger: reminder.trigger,
      description: `${summary} (${reminder.when})`,
    })),
  };
}

/** The calendar file of one hearing, or `null` when the row must not be exported. */
export function buildSaleCalendarFile(
  row: SaleCalendarRow,
  options: { origin: string; now?: Date },
): SaleCalendarFile | null {
  const event = saleCalendarEvent(row, options);
  if (!event) return null;
  return {
    filename: `immojudis-audience-${saleReference(row.id.toLowerCase())}.ics`,
    body: buildIcsCalendar(event, PROD_ID),
  };
}

/** Nom du fichier qui réunit toutes les audiences suivies. */
const FOLLOWED_CALENDAR_FILENAME = "immojudis-audiences-suivies.ics";

/**
 * One file for several hearings (the sales a signed-in account follows). The same rule as the
 * single file applies to each row: a row that is not exportable (postponed, in conflict, source
 * date unverified, past, not a tribunal hearing) is left out, never written « à confirmer ». Events
 * come in date order. `null` when no row can be exported. `exportedIds` lists the sales written.
 */
export function buildSalesCalendarFile(
  rows: readonly SaleCalendarRow[],
  { origin, now = new Date() }: { origin: string; now?: Date },
): (SaleCalendarFile & { exportedIds: string[] }) | null {
  const entries = rows
    .map((row) => ({ row, event: saleCalendarEvent(row, { origin, now }) }))
    .filter((entry): entry is { row: SaleCalendarRow; event: IcsEvent } => entry.event !== null);
  if (entries.length === 0) return null;
  const startOf = (event: IcsEvent) =>
    event.start.kind === "instant"
      ? event.start.at.getTime()
      : Date.parse(`${event.start.isoDay}T00:00:00Z`);
  entries.sort(
    (a, b) => startOf(a.event) - startOf(b.event) || a.event.uid.localeCompare(b.event.uid),
  );
  return {
    filename: FOLLOWED_CALENDAR_FILENAME,
    body: buildIcsCalendarMany(
      entries.map((entry) => entry.event),
      PROD_ID,
    ),
    exportedIds: entries.map((entry) => entry.row.id.toLowerCase()),
  };
}
