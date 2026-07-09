import type { AuctionSale } from "@/lib/types";

export type SaleSourceLink = { label: string; href: string };

const SOURCE_LABELS: Record<string, string> = {
  agrasc: "AGRASC",
  avoventes: "Avoventes",
  cessions_etat: "Cessions de l'Etat",
  encheres_immobilieres: "Enchères Immobilières",
  encheres_publiques: "Enchères Publiques",
  info_encheres: "Info-Enchères",
  licitor: "Licitor",
  notaires: "Immobilier.notaires",
  petites_affiches: "Petites Affiches",
  vench: "Vench",
};

const HOST_LABELS: Array<[RegExp, string]> = [
  [/avoventes\.fr$/i, "Avoventes"],
  [/licitor\.com$/i, "Licitor"],
  [/info-encheres\.com$/i, "Info-Enchères"],
  [/vench\.fr$/i, "Vench"],
  [/encheresimmobilieres\.fr$/i, "Enchères Immobilières"],
  [/encheres-publiques\.com$/i, "Enchères Publiques"],
  [/petitesaffiches\.fr$/i, "Petites Affiches"],
  [/immobilier\.notaires\.fr$/i, "Immobilier.notaires"],
  [/cessions\.immobilier-etat\.gouv\.fr$/i, "Cessions de l'Etat"],
  [/agrasc\.gouv\.fr$/i, "AGRASC"],
];

export function saleSourceLinks(sale: AuctionSale): SaleSourceLink[] {
  const links: SaleSourceLink[] = [];
  const add = (label: string | null | undefined, href: unknown, fallback?: string) => {
    const clean = cleanHref(href);
    if (!clean || links.some((link) => link.href === clean)) return;
    links.push({ label: sourceLabel(label, clean, fallback), href: clean });
  };

  add(sale.source_name, sale.source_url, "Source officielle");
  if (Array.isArray(sale.source_urls)) {
    sale.source_urls.forEach((href, index) => add(null, href, `Source ${index + 1}`));
  } else if (sale.source_urls && typeof sale.source_urls === "object") {
    Object.entries(sale.source_urls as Record<string, unknown>).forEach(([label, href]) =>
      add(label, href, label),
    );
  }
  return links;
}

export function sourceLabel(
  sourceName: string | null | undefined,
  href: string | null | undefined,
  fallback = "Source",
): string {
  const normalized = normalizeSourceName(sourceName);
  if (normalized && SOURCE_LABELS[normalized]) return SOURCE_LABELS[normalized];
  const fromHost = href ? sourceLabelFromUrl(href) : null;
  if (fromHost) return fromHost;
  return cleanLabel(sourceName) ?? fallback;
}

export function sourceLabelFromUrl(href: string): string | null {
  try {
    const host = new URL(href, "https://immojudis.local").hostname.replace(/^www\./i, "");
    const known = HOST_LABELS.find(([pattern]) => pattern.test(host));
    if (known) return known[1];
    if (host && host !== "immojudis.local") return host;
  } catch {
    return null;
  }
  return null;
}

function cleanHref(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cleanLabel(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSourceName(value: string | null | undefined): string | null {
  const label = cleanLabel(value);
  if (!label) return null;
  return label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
