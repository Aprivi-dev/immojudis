export const RESOURCES_PATH = "/ressources";
export const OFFERS_PATH = "/offres";

export type SiteLink = { readonly href: string; readonly label: string };

/** Les cinq entrées de l'en-tête, identiques sur toutes les pages. */
export const SITE_NAV_LINKS: readonly SiteLink[] = [
  { href: "/sales", label: "Ventes" },
  { href: "/tribunaux", label: "Tribunaux" },
  { href: "/avocats", label: "Avocats" },
  { href: RESOURCES_PATH, label: "Ressources" },
  { href: OFFERS_PATH, label: "Offres" },
];

/** Pages d'information, reprises dans le menu mobile. */
export const SITE_INFO_LINKS: readonly SiteLink[] = [
  { href: "/comment-ca-marche", label: "Comment ça marche" },
  { href: "/a-propos", label: "À propos" },
  { href: "/contact", label: "Contact" },
];

export const SITE_LEGAL_LINKS: readonly SiteLink[] = [
  { href: "/legal", label: "Mentions légales" },
  { href: "/conditions-generales", label: "Conditions générales" },
  { href: "/privacy", label: "Confidentialité" },
  { href: "/mes-droits", label: "Mes droits" },
];

export const ACCOUNT_LINKS: readonly SiteLink[] = [
  { href: "/favoris", label: "Mes favoris" },
  { href: "/alertes", label: "Mes alertes" },
  { href: "/comparaisons", label: "Mes comparaisons" },
  { href: "/compte", label: "Mon compte" },
];

/** Adresse de connexion qui ramène la personne sur la page d'où elle vient. */
export function loginPathWithRedirect(returnTo: string | null | undefined): string {
  if (!returnTo || !returnTo.startsWith("/") || returnTo.startsWith("//")) return "/login";
  if (returnTo === "/login" || returnTo.startsWith("/login?")) return "/login";
  return `/login?redirect=${encodeURIComponent(returnTo)}`;
}

export type LoginPageMode = "login" | "investor" | "professional";

export function loginPageMode(value: unknown): LoginPageMode {
  return value === "investor" || value === "professional" ? value : "login";
}

export function safeSalesReturnTo(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/")) return undefined;

  const base = "http://immojudis.local";
  const url = new URL(value, base);
  if (url.origin !== base || url.pathname !== "/sales" || url.hash) return undefined;

  return `${url.pathname}${url.search}`;
}

export function saleDetailPath(saleId: string, returnTo?: string): string {
  const path = `/sales/${encodeURIComponent(saleId)}`;
  const safeReturnTo = safeSalesReturnTo(returnTo);
  if (!safeReturnTo) return path;

  const search = new URLSearchParams({ from: safeReturnTo });
  return `${path}?${search.toString()}`;
}

export type SearchValue = string | number | boolean | null | undefined;

/**
 * Adds a query string to a path. Empty values (`undefined`, `null`, `""`) are left out, so a
 * filter that is not set never shows up in the URL.
 */
export function pathWithSearch(path: string, search?: Record<string, SearchValue>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  const serialized = query.toString();
  return serialized ? `${path}?${serialized}` : path;
}

/**
 * Reads a query string into a plain record. When a key is repeated the last value wins, the
 * same rule the server pages apply to `searchParams`. Values stay strings: validators own the
 * numeric conversion, so postal codes and department numbers keep their leading zero.
 */
export function searchParamsToRecord(searchParams: {
  forEach(callback: (value: string, key: string) => void): void;
}): Record<string, string> {
  const record: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}
