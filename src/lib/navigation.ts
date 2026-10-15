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
  { href: "/classement-des-annonces", label: "Classement des annonces" },
  { href: "/mes-droits", label: "Mes droits" },
];

export const ACCOUNT_LINKS: readonly SiteLink[] = [
  { href: "/favoris", label: "Mes favoris" },
  { href: "/alertes", label: "Mes alertes" },
  { href: "/comparaisons", label: "Mes comparaisons" },
  { href: "/compte", label: "Mon compte" },
];

/** Pourquoi la personne arrive sur la page de connexion : sert au bandeau d'explication. */
export const LOGIN_REASONS = ["alerte", "favori", "export", "offre", "fiche"] as const;
export type LoginReason = (typeof LOGIN_REASONS)[number];

export function loginReason(value: unknown): LoginReason | undefined {
  return LOGIN_REASONS.find((reason) => reason === value);
}

/**
 * Adresse de connexion qui ramène la personne sur la page d'où elle vient. Elle ouvre par défaut
 * « Créer un compte » (`mode=investor`) : un visiteur qui touche un cœur ou une cloche n'a pas
 * encore de compte. `reason` explique l'action qui a déclenché le détour.
 */
export function loginPathWithRedirect(
  returnTo: string | null | undefined,
  options: { mode?: LoginPageMode; reason?: LoginReason } = {},
): string {
  const { mode = "investor", reason } = options;
  const query = new URLSearchParams();
  const isSameSitePath = (path: string) => path.startsWith("/") && !path.startsWith("//");
  const isLoginPage = (path: string) => path === "/login" || path.startsWith("/login?");
  if (returnTo && isSameSitePath(returnTo) && !isLoginPage(returnTo)) {
    query.set("redirect", returnTo);
  }
  if (mode !== "login") query.set("mode", mode);
  if (reason) query.set("reason", reason);
  const serialized = query.toString();
  return serialized ? `/login?${serialized}` : "/login";
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
