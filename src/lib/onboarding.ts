import { saleDetailPath, type LoginPageMode } from "@/lib/navigation";
import { HOME_TYPE_OPTIONS } from "@/lib/search/search-filters";
import type { SalesSearchUrlRecord } from "@/lib/search/search-url-state";

/** Paramètre de `/bienvenue` qui porte la fiche à retrouver après la première recherche. */
export const ONBOARDING_RETURN_PARAM = "retour";

const SALE_DETAIL_PATH = /^\/sales\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i;
const RETURN_BASE = "http://immojudis.local";

/**
 * Adresse d'une fiche de vente (`/sales/<identifiant>`, avec au plus une origine `?from=` valide),
 * ou `undefined`. Une adresse reconstruite est rendue, jamais la chaîne reçue : `/bienvenue` ne
 * ramène que sur une fiche du site.
 */
export function saleDetailReturnPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/sales/") || value.startsWith("//")) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value, RETURN_BASE);
  } catch {
    return undefined;
  }
  if (url.origin !== RETURN_BASE || url.hash) return undefined;
  const match = SALE_DETAIL_PATH.exec(url.pathname);
  if (!match) return undefined;
  if ([...url.searchParams.keys()].some((key) => key !== "from")) return undefined;
  return saleDetailPath(match[1], url.searchParams.get("from") ?? undefined);
}

export function postAuthDestination({
  mode,
  redirect,
  professional,
}: {
  mode: LoginPageMode;
  redirect?: string;
  professional: boolean;
}): string {
  // Une personne qui crée son compte depuis une fiche passe aussi par la première recherche, puis
  // retrouve la fiche (`/bienvenue?retour=`) ; une personne qui se connecte y retourne directement.
  if (mode === "investor" && !professional) {
    const sale = saleDetailReturnPath(redirect);
    if (sale) return `/bienvenue?${ONBOARDING_RETURN_PARAM}=${encodeURIComponent(sale)}`;
  }
  // Preserve a listing, checkout or filtered search that prompted registration.
  if (redirect && redirect !== "/sales") return redirect;
  if (mode === "investor" && !professional) return "/bienvenue";
  return redirect ?? (professional || mode === "professional" ? "/espace-pro" : "/sales");
}

export type FirstSearch = {
  area: string;
  maxPrice: string;
  homeType: string;
};

/** « 33 », « 2A », « 974 » or a postal code: a département the free alert can follow. */
function departmentFromArea(area: string): string | undefined {
  const value = area.trim().toUpperCase();
  if (/^(0[1-9]|[1-8]\d|9[0-5]|2A|2B)$/.test(value) || /^97[1-6]$/.test(value)) return value;
  const postal = value.match(/^(\d{5})$/)?.[1];
  if (!postal) return undefined;
  if (postal.startsWith("97")) return postal.slice(0, 3);
  if (postal.startsWith("20")) return Number(postal) < 20200 ? "2A" : "2B";
  return postal.slice(0, 2);
}

export function firstSearchToUrl(search: FirstSearch): SalesSearchUrlRecord {
  const maxPrice = Number(search.maxPrice);
  // A département is a public criterion the free alert accepts; a free-text
  // query is not, so the first search could not be saved as an alert.
  const department = departmentFromArea(search.area);
  return {
    query: department ? undefined : search.area.trim().slice(0, 120) || undefined,
    department,
    maxPrice:
      Number.isFinite(maxPrice) && maxPrice > 0 && maxPrice <= 1_000_000_000 ? maxPrice : undefined,
    homeTypes: HOME_TYPE_OPTIONS.some((option) => option.value === search.homeType)
      ? search.homeType
      : undefined,
  };
}
