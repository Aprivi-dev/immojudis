import { departmentCode } from "@/lib/department-code";

// Loyers de référence en €/m²/mois, par département.
//
// Ce ne sont que des ordres de grandeur pour les grandes agglomérations. Un
// département absent n'a PAS de référence : on n'affiche alors aucun
// rendement plutôt que d'inventer un loyer (l'ancien repli à 11 €/m² faussait
// les ventes de Creuse, de Corrèze, etc.). La carte des loyers par commune
// (ANIL / data.gouv.fr) remplacera cette table quand elle sera importée.
const RENT_BY_DEPARTMENT: Record<string, number> = {
  "75": 32,
  "92": 26,
  "93": 19,
  "94": 21,
  "78": 18,
  "77": 14,
  "91": 15,
  "95": 15,
  "69": 15,
  "13": 14,
  "06": 17,
  "33": 14,
  "31": 13,
  "44": 13,
  "67": 12,
  "59": 11,
  "35": 13,
  "34": 13,
  "76": 11,
  "38": 12,
  "83": 14,
  "42": 9,
  "29": 11,
  "21": 11,
};

export type RentReference = {
  rentPerM2: number;
  source: "department_estimate";
};

export function rentReference(department: string | null | undefined): RentReference | null {
  const code = departmentCode(department);
  const rentPerM2 = code ? RENT_BY_DEPARTMENT[code] : undefined;
  return rentPerM2 == null ? null : { rentPerM2, source: "department_estimate" };
}

/** Loyer de référence en €/m²/mois, ou `null` quand aucune référence locale n'existe. */
export function defaultRentPerM2(department: string | null | undefined): number | null {
  return rentReference(department)?.rentPerM2 ?? null;
}

export const RENT_REFERENCE_UNAVAILABLE = "Loyer de référence indisponible";
