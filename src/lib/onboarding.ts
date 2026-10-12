import type { LoginPageMode } from "@/lib/navigation";
import { HOME_TYPE_OPTIONS } from "@/lib/search/search-filters";
import type { SalesSearchUrlRecord } from "@/lib/search/search-url-state";

export function postAuthDestination({
  mode,
  redirect,
  professional,
}: {
  mode: LoginPageMode;
  redirect?: string;
  professional: boolean;
}): string {
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
