export const RESOURCES_PATH = "/ventes-immobilieres-judiciaires";

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
