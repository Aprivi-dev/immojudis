import { FRENCH_DEPARTMENTS } from "@/lib/departments";
import { labelFingerprint } from "@/lib/label-fingerprint";

const CODE_BY_NAME = new Map(
  FRENCH_DEPARTMENTS.map(({ code, name }) => [labelFingerprint(name), code]),
);

/**
 * Code officiel d'un département à partir de la valeur stockée : le code
 * (« 33 », « 2A », « 971 ») en production, parfois le nom (« Gironde »).
 */
export function departmentCode(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (/^(\d{2,3}|2[AB])$/i.test(raw)) return raw.toUpperCase();
  // « département de la Gironde », « dept Gironde » : même préfixe que la recherche géographique.
  const name = labelFingerprint(raw)
    .replace(/^(?:departement|dept)\s+/, "")
    .replace(/^(?:du|de la|de l|des|de|d)\s+/, "");
  return CODE_BY_NAME.get(name) ?? null;
}
