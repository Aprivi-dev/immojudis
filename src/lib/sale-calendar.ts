import { buildIcsCalendar } from "@/lib/ical";
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
 * The calendar file of one hearing, or `null` when the row must not be exported.
 *
 * - A hearing whose hour is unknown (`date_only`, or a stored midnight) becomes an all-day event
 *   on its Paris civil day: no hour is ever invented.
 * - A timed hearing is written in UTC (`…Z`): every calendar converts it to the viewer's zone,
 *   and no VTIMEZONE block can be wrong.
 * - The location is the court only (its public name). The property address is never written: it
 *   is reserved to signed-in accounts.
 */
export function buildSaleCalendarFile(
  row: SaleCalendarRow,
  { origin, now = new Date() }: { origin: string; now?: Date },
): SaleCalendarFile | null {
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

  const body = buildIcsCalendar(
    {
      uid: saleCalendarUid(saleId, origin),
      stamp: now,
      lastModified: validDate(row.updated_at),
      start: timed ? { kind: "instant", at: date } : { kind: "day", isoDay: parisDateKey(date) },
      summary,
      description: `${SALE_CALENDAR_DISCLAIMER} Fiche de la vente : ${url}`,
      location,
      url,
      // The date comes from the announcement: the calendar shows it as to be confirmed.
      status: "TENTATIVE",
    },
    PROD_ID,
  );
  return { filename: `immojudis-audience-${saleReference(saleId)}.ics`, body };
}
