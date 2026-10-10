import { resolveFrenchGeoSearch } from "@/lib/search/french-geo-search";

/**
 * Code officiel d'un département à partir de la valeur stockée : le code
 * (« 33 », « 2A », « 971 ») en production, parfois le nom (« Gironde »).
 */
export function departmentCode(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (/^(\d{2,3}|2[AB])$/i.test(raw)) return raw.toUpperCase();
  const resolved = resolveFrenchGeoSearch(raw);
  return resolved.kind === "department" && resolved.departments.length === 1
    ? resolved.departments[0]
    : null;
}
