import type { AuctionSale } from "./types";

const STREET_TYPES =
  "rue|avenue|av\\.?|boulevard|bd\\.?|chemin|route|impasse|allée|allee|place|quai|cours|faubourg|passage|square|voie|lotissement|hameau";

const ADDRESS_CONTAMINATION =
  /\b(?:on\s+ne\s+peut\s+enchérir|on\s+ne\s+peut\s+encherir|afficher\s+le\s+plan|exactitude\s+non\s+garantie|ne\s+peut\s+enchérir|ne\s+peut\s+encherir|adresse\s+du\s+bien|localisation\s+du\s+bien)\b/i;

const LAWYER_CONTAMINATION =
  /\b(?:chèque(?:s)?|cheque(?:s)?|carpa|consignation|outre\s+une\s+somme|somme\s+de|garantie|caution|ordre\s+de|enchérir|encherir)\b/i;

export function cleanListingAddress(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!ADDRESS_CONTAMINATION.test(text)) return text;
  const match = new RegExp(
    `\\b\\d{1,5}\\s*(?:bis|ter|quater)?\\s*(?:${STREET_TYPES})\\s*[^|;]*?(?=\\s*(?:\\||;|Afficher\\s+le\\s+plan|Exactitude\\s+non\\s+garantie|$))`,
    "i",
  ).exec(text);
  if (!match?.[0]) return null;
  return (
    match[0]
      .replace(
        /(\d)(?=(?:bis|ter|quater)?\s*(?:rue|avenue|av\.?|boulevard|bd\.?|chemin|route|impasse|allée|allee|place|quai|cours|faubourg|passage|square|voie|lotissement|hameau)\b)/i,
        "$1 ",
      )
      .replace(new RegExp(`(${STREET_TYPES})(?=[A-Za-zÀ-ÿ])`, "i"), "$1 ")
      .trim()
      .replace(/^[,\s|-]+|[,\s|-]+$/g, "") || null
  );
}

export function cleanOrganizerName(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!LAWYER_CONTAMINATION.test(text) && text.length <= 180) return text;
  const labelled = /^(?:Ma[iî]tre|Me|SCP|SELARL|SELAS|Cabinet|Office|[ÉE]tude)\b[^|;]{2,120}/i.exec(
    text,
  );
  const candidate = labelled?.[0]?.trim().replace(/[,.-]+$/, "") || null;
  return candidate && !LAWYER_CONTAMINATION.test(candidate) ? candidate : null;
}

export function cleanOrganizerContact(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!LAWYER_CONTAMINATION.test(text)) return text;
  const actionable = [
    ...(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []),
    ...(text.match(/(?:\+33\s?(?:\(0\)\s?)?|0)[1-9](?:[\s.()-]?\d{2}){4}/g) ?? []),
    ...(text.match(/https?:\/\/[^\s<>"]+/gi) ?? []),
  ];
  return [...new Set(actionable)].join(" · ") || null;
}

export function cleanVisitText(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let text = value.replace(/\s+/g, " ").trim();
  text = text.replace(/(?:\s*[,;|]\s*)?\b(?:et|ou)\b\s*$/i, "").trim();
  const weekdays = "lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche";
  const months =
    "janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre";
  const date = new RegExp(
    `\\b(${weekdays})\\s*(\\d{1,2})\\s*(${months})\\s*(\\d{4})(?:\\s*(?:à|a)\\s*(\\d{1,2})\\s*h(?:\\s*(\\d{2}))?)?`,
    "i",
  );
  text = text.replace(date, (_match, weekday, day, month, year, hour, minute) => {
    if (!hour) return `${weekday} ${day} ${month} ${year}`;
    return `${weekday} ${day} ${month} ${year} à ${hour}h${minute ?? ""}`;
  });
  return text || null;
}

export function cleanDateForListing(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const text = value.trim();
  // The pipeline stores an unknown-time civil date at UTC midnight because
  // auction_sales is timestamptz. Treat that sentinel as a calendar date so
  // Europe/Paris does not expose a fabricated 01:00/02:00 clock time.
  if (/^\d{4}-\d{2}-\d{2}T00:00(?::00(?:\.\d+)?)?(?:Z|\+00:00)$/i.test(text)) {
    return text.slice(0, 10);
  }
  return text;
}

function departmentFromPostalCode(value: string | null | undefined): string | null {
  const postal = /^\d{5}$/.exec(value?.trim() ?? "")?.[0];
  if (!postal) return null;
  return /^(?:97[1-8]|98[6-8])\d{2}$/.test(postal) ? postal.slice(0, 3) : postal.slice(0, 2);
}

function postalCodeFromAddress(value: string | null | undefined): string | null {
  const text = value?.replace(/\s+/g, " ").trim() ?? "";
  const contiguous = /\b(\d{5})\s+[A-Za-zÀ-ÿ]/.exec(text);
  if (contiguous?.[1]) return contiguous[1];
  const spaced = /(?<!\d)(\d{2})\s+(\d{3})\s+[A-Za-zÀ-ÿ]/.exec(text);
  return spaced ? `${spaced[1]}${spaced[2]}` : null;
}

function postalCodeWasStartingPriceToken(sale: AuctionSale): boolean {
  if (sale.source_name?.trim().toLowerCase() !== "petites_affiches") return false;
  const postal = /^\d{5}$/.exec(sale.postal_code?.trim() ?? "")?.[0];
  if (!postal || new RegExp(`\\b${postal}\\b`).test(sale.address ?? "")) return false;
  const price = sale.starting_price_eur;
  return (
    typeof price === "number" && Number.isFinite(price) && Math.round(price) === Number(postal)
  );
}

function cleanProcedure(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const procedure = { ...(value as Record<string, unknown>) };
  if ("venue_address" in procedure) {
    procedure.venue_address = cleanListingAddress(procedure.venue_address);
  }
  if ("organizer_name" in procedure) {
    procedure.organizer_name = cleanOrganizerName(procedure.organizer_name);
  }
  if ("organizer_contact" in procedure) {
    procedure.organizer_contact = cleanOrganizerContact(procedure.organizer_contact);
  }
  return procedure;
}

export function sanitizeAuctionSaleForDisplay(sale: AuctionSale): AuctionSale {
  const addressPostalCode = postalCodeFromAddress(sale.address);
  const invalidPostal = postalCodeWasStartingPriceToken(sale);
  const postalCode = addressPostalCode ?? (invalidPostal ? null : sale.postal_code);
  const postalDepartment = departmentFromPostalCode(postalCode);
  const department =
    postalDepartment && sale.department && sale.department !== postalDepartment
      ? postalDepartment
      : invalidPostal && sale.department === departmentFromPostalCode(sale.postal_code)
        ? null
        : sale.department?.trim() || postalDepartment;
  const visitDates = Array.isArray(sale.visit_dates)
    ? sale.visit_dates.map(cleanVisitText).filter((value): value is string => Boolean(value))
    : cleanVisitText(sale.visit_dates)
      ? [cleanVisitText(sale.visit_dates)!]
      : [];
  return {
    ...sale,
    address: cleanListingAddress(sale.address),
    department,
    postal_code: postalCode,
    sale_date: cleanDateForListing(sale.sale_date),
    visit_dates: visitDates,
    lawyer_name: cleanOrganizerName(sale.lawyer_name),
    lawyer_contact: cleanOrganizerContact(sale.lawyer_contact),
    sale_procedure: cleanProcedure(sale.sale_procedure),
  };
}
