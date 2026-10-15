import {
  listingSaleStatus,
  publishedDay,
  saleTimeConflict,
  visitHasPassed,
} from "@/lib/listing-evidence";
import { listingVisits, positiveListingNumber } from "@/lib/sale-listing";
import { getSaleProcedure } from "@/lib/sale-procedure";
import { saleSession, saleWindow } from "@/lib/sale-window";
import type { AuctionSale } from "@/lib/types";

/**
 * The four facts a reader looks for first on a sale page: the starting price, when it happens,
 * where, and the next visit. Same sources and same wording as the rest of the page
 * (`ListingOverview`, `ListingPracticalDetails`): nothing is computed here that those do not show.
 */
export type SaleKeyFacts = {
  priceLabel: "Mise à prix" | "Prix publié";
  /** `null` when the price is absent or zero (a sale at 0 € is never announced). */
  price: number | null;
  eventLabel: string;
  /** Raw date of the hearing, session or deadline, `null` when none is published. */
  eventDate: string | null;
  /** « Vente reportée », « Date de vente passée »… : replaces the date when set. */
  status: string | null;
  /** The source text and the stored time disagree: the date must be confirmed. */
  timeConflict: boolean;
  venueLabel: string;
  venueName: string | null;
  /** Earliest visit that is not over, as published (cleaned); `null` when none is known. */
  nextVisit: string | null;
};

const CONDITIONS = /\bconditions\s+de\s+la\s+vente\b/i;

/** The slot of a visit text, without the sales conditions that sometimes follow it. */
function visitSlot(text: string): string {
  const start = text.search(CONDITIONS);
  return (start < 0 ? text : text.slice(0, start)).trim();
}

/** The earliest visit not yet over. A visit whose day cannot be read is never called « next ». */
export function nextVisit(sale: AuctionSale, now: Date = new Date()): string | null {
  const upcoming = listingVisits(sale)
    .map((text) => ({ text, day: publishedDay(text) }))
    .filter(
      (visit): visit is { text: string; day: string } =>
        visit.day != null && !visitHasPassed(visit.text, now),
    )
    .sort((a, b) => a.day.localeCompare(b.day));
  const slot = upcoming[0] ? visitSlot(upcoming[0].text) : "";
  return slot || null;
}

export function saleKeyFacts(sale: AuctionSale, now: Date = new Date()): SaleKeyFacts {
  const procedure = getSaleProcedure(sale);
  const tribunal = procedure.venueType === "tribunal";
  const notary = procedure.venueType === "notary";
  const state = procedure.venueType === "state";
  const schedule = saleWindow(sale) ?? saleSession(sale);
  const status = listingSaleStatus(sale, now);
  const eventDate =
    (state ? (schedule?.closes_at ?? sale.sale_date) : (schedule?.opens_at ?? sale.sale_date)) ??
    null;
  const venueName = (state ? (procedure.organizerName ?? procedure.venueName) : procedure.venueName)
    ?.toString()
    .trim();

  return {
    priceLabel: state ? "Prix publié" : "Mise à prix",
    price: positiveListingNumber(sale.starting_price_eur),
    eventLabel: state
      ? "Échéance annoncée"
      : notary
        ? "Séance annoncée"
        : tribunal
          ? "Audience annoncée"
          : "Date annoncée",
    eventDate,
    status,
    timeConflict: saleTimeConflict(sale) != null,
    venueLabel: tribunal
      ? "Tribunal"
      : notary
        ? "Étude ou organisateur"
        : state
          ? "Service vendeur"
          : "Lieu",
    venueName: venueName || null,
    // A cancelled, postponed or past sale has no visit worth announcing.
    nextVisit: status ? null : nextVisit(sale, now),
  };
}
