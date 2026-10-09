import { propertyTypeLabel } from "@/lib/format";
import { getSaleProcedure } from "@/lib/sale-procedure";
import type { AuctionSale, SaleVenueType } from "@/lib/types";

/**
 * Search-engine text for a public sale page.
 *
 * Everything here is derived from the facts the public catalogue already
 * shows (type, surface, city, department, hearing date, tribunal, starting
 * price). Nothing is invented: a missing fact is left out, never replaced by
 * a plausible value.
 *
 * The root layout appends " - Immojudis" to every title (`title.template`),
 * so titles produced here must NOT contain the site name.
 */
export const GENERIC_SALE_SEO_TITLE = "Vente aux enchères immobilière";

/** Length of the suffix added by the layout template (" - Immojudis"). */
const TITLE_SUFFIX_LENGTH = " - Immojudis".length;
/** Search engines display about 60 characters of a title. */
const TITLE_BUDGET = 60;
export const SALE_TITLE_MAX_LENGTH = TITLE_BUDGET - TITLE_SUFFIX_LENGTH;

const PARIS_TIME_ZONE = "Europe/Paris";
const DESCRIPTION_MAX_LENGTH = 158;

type SaleFacts = Pick<
  AuctionSale,
  | "id"
  | "property_type"
  | "app_surface_m2"
  | "city"
  | "department"
  | "sale_date"
  | "starting_price_eur"
  | "tribunal"
  | "tribunal_name"
  | "tribunal_city"
> &
  Partial<AuctionSale>;

function squash(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cleanText(value: string | null | undefined): string | null {
  const text = squash(value ?? "");
  return text ? text : null;
}

function upperFirst(value: string): string {
  return value.charAt(0).toLocaleUpperCase("fr-FR") + value.slice(1);
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLocaleLowerCase("fr-FR") + value.slice(1);
}

export function seoPropertyLabel(propertyType: string | null | undefined): string {
  const label = propertyTypeLabel(propertyType);
  return label === "Bien" || label === "Bien à qualifier" ? "Bien immobilier" : label;
}

export function seoSurface(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 })
    .format(value)
    .replaceAll(" ", " ")
    .replaceAll(" ", " ")} m²`;
}

export function seoPrice(value: number): string {
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 })
    .format(value)
    .replaceAll(" ", " ")
    .replaceAll(" ", " ")} €`;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function seoLongDate(value: string | null | undefined): string | null {
  const date = parseDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: PARIS_TIME_ZONE,
  }).format(date);
}

function parisParts(date: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: PARIS_TIME_ZONE,
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/**
 * The public catalogue stores a date-only hearing as midnight (UTC or Paris).
 * A real time of day is only shown when it is neither of those.
 */
export function saleHearingTime(value: string | null | undefined): string | null {
  const date = parseDate(value);
  if (!date) return null;
  const paris = parisParts(date);
  const utcMidnight =
    date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0;
  if (utcMidnight || (paris.hour === 0 && paris.minute === 0)) return null;
  return `${paris.hour} h ${String(paris.minute).padStart(2, "0")}`;
}

/** Schema.org date: a plain day when the hour is unknown, an instant otherwise. */
export function saleHearingStartDate(value: string | null | undefined): string | null {
  const date = parseDate(value);
  if (!date) return null;
  return saleHearingTime(value) ? date.toISOString() : parisParts(date).date;
}

/**
 * "TJ Perpignan", "Tribunal judiciaire de Bordeaux", "TJ d'Aix-en-Provence"
 * all reduce to the city the court sits in.
 */
export function tribunalCityName(raw: string | null | undefined): string | null {
  const text = cleanText(raw);
  if (!text) return null;
  const city = text
    .replace(/^(?:tribunal judiciaire|tribunal de grande instance|tj|tgi)\b\s*/i, "")
    .replace(/^(?:de la|de l['’]|de|du|des|d['’])\s*/i, "")
    .trim();
  return city ? city : null;
}

function withArticle(city: string): string {
  if (/^Le\s/i.test(city)) return `du ${city.slice(3)}`;
  if (/^Les\s/i.test(city)) return `des ${city.slice(4)}`;
  if (/^[aeiouyàâäéèêëîïôöùûüh]/i.test(city)) return `d’${city}`;
  return `de ${city}`;
}

/** "tribunal judiciaire de Perpignan", never "Tribunal judiciaire Tribunal judiciaire …". */
export function tribunalDisplayName(sale: {
  tribunal?: string | null;
  tribunal_name?: string | null;
  tribunal_city?: string | null;
}): string | null {
  const raw = cleanText(sale.tribunal_name) ?? cleanText(sale.tribunal);
  if (!raw) return null;
  if (/^(?:tj|tgi|tribunal judiciaire|tribunal de grande instance)\b/i.test(raw)) {
    const city = tribunalCityName(raw) ?? cleanText(sale.tribunal_city);
    return city ? `Tribunal judiciaire ${withArticle(city)}` : "Tribunal judiciaire";
  }
  return raw;
}

/** "au tribunal judiciaire de Bordeaux": a court named in a sentence, article included. Anything that is not a tribunal keeps "auprès de". */
export function atTribunal(name: string): string {
  const display = tribunalDisplayName({ tribunal_name: name }) ?? name;
  return /^tribunal/i.test(display) ? `au ${lowerFirst(display)}` : `auprès de ${display}`;
}

function venueType(sale: SaleFacts): SaleVenueType {
  return getSaleProcedure(sale as AuctionSale).venueType;
}

/** Phrase used in the page heading: "vente au tribunal", "vente chez le notaire"… */
function venuePhrase(type: SaleVenueType): string {
  return {
    tribunal: "vente au tribunal",
    notary: "vente chez le notaire",
    state: "vente par l’État",
    online: "vente aux enchères en ligne",
    unknown: "vente aux enchères",
  }[type];
}

/** Very short form for titles, where every character counts. */
function venueTitleToken(type: SaleVenueType): string {
  return {
    tribunal: "tribunal",
    notary: "notaire",
    state: "État",
    online: "en ligne",
    unknown: "enchères",
  }[type];
}

function department(sale: SaleFacts): string | null {
  const value = cleanText(sale.department);
  return value ? `(${value})` : null;
}

/** "Appartement 50 m² à Romainville (93)": the property, without the sale type. */
function propertyLine(sale: SaleFacts, options: { surface?: boolean; department?: boolean } = {}) {
  const { surface = true, department: withDepartment = true } = options;
  const city = cleanText(sale.city);
  return [
    seoPropertyLabel(sale.property_type),
    surface ? seoSurface(sale.app_surface_m2) : null,
    city ? `à ${city}` : null,
    city && withDepartment ? department(sale) : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Visible page heading: "Appartement 50 m² à Romainville (93) – vente au tribunal
 * le 20 octobre 2026". The short reference printed next to it is added by the page.
 */
export function saleHeadline(sale: SaleFacts | null | undefined): string {
  if (!sale) return GENERIC_SALE_SEO_TITLE;
  const date = seoLongDate(sale.sale_date);
  return `${propertyLine(sale)} – ${venuePhrase(venueType(sale))}${date ? ` le ${date}` : ""}`;
}

/** Eight-character reference shown with the heading so that two lots never share one. */
export function saleReference(id: string): string {
  return id
    .replace(/[^0-9a-z]/gi, "")
    .slice(0, 8)
    .toLowerCase();
}

/**
 * Document title WITHOUT the site name (added by the layout template).
 * The longest variant that fits the 60-character budget is used.
 */
export function saleSeoTitle(sale: SaleFacts | null | undefined): string {
  if (!sale) return GENERIC_SALE_SEO_TITLE;
  const token = venueTitleToken(venueType(sale));
  const candidates = [
    `${propertyLine(sale)} – ${token}`,
    `${propertyLine(sale, { surface: false })} – ${token}`,
    `${propertyLine(sale, { surface: false, department: false })} – ${token}`,
    propertyLine(sale, { surface: false, department: false }),
    `${seoPropertyLabel(sale.property_type)} aux enchères`,
  ];
  const fitting = candidates.find((candidate) => candidate.length <= SALE_TITLE_MAX_LENGTH);
  if (fitting) return fitting;
  const last = candidates[candidates.length - 1];
  return last.length <= SALE_TITLE_MAX_LENGTH
    ? last
    : `${last.slice(0, SALE_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

function truncateDescription(value: string): string {
  if (value.length <= DESCRIPTION_MAX_LENGTH) return value;
  const cut = value.slice(0, DESCRIPTION_MAX_LENGTH - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 80 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Meta description: starts with a capital, written from the same public facts. */
export function saleSeoDescription(sale: SaleFacts | null | undefined): string {
  if (!sale) {
    return "Vente aux enchères immobilière : organisation de la vente et règles de participation vérifiées par Immojudis.";
  }
  const type = venueType(sale);
  const tribunal = type === "tribunal" ? tribunalDisplayName(sale) : null;
  const date = seoLongDate(sale.sale_date);
  const place = [
    {
      tribunal: tribunal ? `au ${lowerFirst(tribunal)}` : "au tribunal",
      notary: "chez le notaire",
      state: "par l’État",
      online: "aux enchères en ligne",
      unknown: "aux enchères",
    }[type],
    date ? `le ${date}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const price =
    sale.starting_price_eur != null && sale.starting_price_eur > 0
      ? ` Mise à prix : ${seoPrice(sale.starting_price_eur)}.`
      : "";
  const base = `${upperFirst(propertyLine(sale))}, vente ${place}.${price}`;
  // Closing sentence: the longest one that still fits, so nothing is cut mid-sentence.
  const closing = [
    " Règles de participation et dossier détaillé sur Immojudis.",
    " Règles de participation sur Immojudis.",
    " Détails sur Immojudis.",
  ].find((sentence) => (base + sentence).length <= DESCRIPTION_MAX_LENGTH);
  return truncateDescription(base + (closing ?? ""));
}

type StructuredDataContext = {
  origin: string;
  now?: Date;
};

function thumbnail(sale: SaleFacts): string | null {
  const media = sale.media as Array<{ type?: string; url?: string }> | null | undefined;
  const url = media?.find((item) => item?.url && (item.type ?? "image") === "image")?.url;
  return url && /^https:\/\//i.test(url) ? url : null;
}

/**
 * JSON-LD for a public sale page. Absolute URLs; only facts the page shows.
 * - The starting price is described as a price specification named "Mise à prix":
 *   it is the auction's opening bid, not an asking price.
 * - Availability becomes SoldOut once the hearing is over.
 * - The hearing is a separate Event, emitted only when its date and venue are known.
 */
export function saleStructuredData(
  sale: SaleFacts,
  { origin, now = new Date() }: StructuredDataContext,
): Record<string, unknown> {
  const url = `${origin}/sales/${encodeURIComponent(sale.id)}`;
  const image = thumbnail(sale);
  const type = venueType(sale);
  const hearing = parseDate(sale.sale_date);
  const hearingOver = hearing != null && hearing.getTime() < now.getTime();
  const city = cleanText(sale.city);
  const headline = saleHeadline(sale);
  const description = saleSeoDescription(sale);
  const hasPrice = sale.starting_price_eur != null && sale.starting_price_eur > 0;
  const updated = parseDate(sale.updated_at);

  const listing: Record<string, unknown> = {
    "@type": "RealEstateListing",
    "@id": `${url}#annonce`,
    name: headline,
    url,
    description,
    inLanguage: "fr-FR",
    ...(image ? { image: [image] } : {}),
    ...(updated ? { dateModified: updated.toISOString() } : {}),
    ...(city
      ? {
          about: {
            "@type": "Place",
            name: `${seoPropertyLabel(sale.property_type)} à ${city}`,
            address: {
              "@type": "PostalAddress",
              addressLocality: city,
              ...(cleanText(sale.department) ? { addressRegion: cleanText(sale.department) } : {}),
              addressCountry: "FR",
            },
          },
        }
      : {}),
    ...(hasPrice
      ? {
          offers: {
            "@type": "Offer",
            url,
            priceSpecification: {
              "@type": "PriceSpecification",
              name: "Mise à prix",
              price: sale.starting_price_eur,
              priceCurrency: "EUR",
            },
            availability: hearingOver
              ? "https://schema.org/SoldOut"
              : "https://schema.org/LimitedAvailability",
          },
        }
      : {}),
  };

  const startDate = saleHearingStartDate(sale.sale_date);
  const tribunal = type === "tribunal" ? tribunalDisplayName(sale) : null;
  const tribunalCity =
    tribunalCityName(sale.tribunal_name ?? sale.tribunal) ?? cleanText(sale.tribunal_city);
  const graph: Record<string, unknown>[] = [listing];
  if (startDate && tribunal && tribunalCity) {
    graph.push({
      "@type": "Event",
      "@id": `${url}#audience`,
      name: `Audience de vente : ${propertyLine(sale)}`,
      url,
      startDate,
      eventStatus: "https://schema.org/EventScheduled",
      eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
      ...(image ? { image: [image] } : {}),
      description,
      location: {
        "@type": "Place",
        name: tribunal,
        address: {
          "@type": "PostalAddress",
          addressLocality: tribunalCity,
          addressCountry: "FR",
        },
      },
    });
  }

  return { "@context": "https://schema.org", "@graph": graph };
}

/**
 * Site-level JSON-LD: the organization that publishes the site (with its logo)
 * and the website with its search action. All URLs are absolute.
 */
export function organizationStructuredData(origin: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${origin}/#organisation`,
        name: "Immojudis",
        url: origin,
        logo: {
          "@type": "ImageObject",
          url: `${origin}/brand/immojudis-mark-transparent.png`,
        },
      },
      {
        "@type": "WebSite",
        "@id": `${origin}/#site`,
        name: "Immojudis",
        url: origin,
        inLanguage: "fr-FR",
        publisher: { "@id": `${origin}/#organisation` },
        potentialAction: {
          "@type": "SearchAction",
          target: {
            "@type": "EntryPoint",
            urlTemplate: `${origin}/sales?q={search_term_string}`,
          },
          "query-input": "required name=search_term_string",
        },
      },
    ],
  };
}
