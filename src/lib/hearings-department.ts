/**
 * Choix du département sur la page « Audiences à venir ». Module à part, sans dépendance : le
 * sélecteur, qui s'exécute dans le navigateur, n'a pas à charger tout le calcul des audiences
 * (`upcoming-hearings.ts`, qui tire les pages de tribunaux et le SEO).
 */

/** Paramètre d'adresse du filtre par département de la page « Audiences à venir ». */
export const HEARINGS_DEPARTMENT_PARAM = "departement";

export type HearingDepartment = { code: string; count: number };

/** Le code du paramètre d'adresse s'il désigne un département de la liste, sinon `null` (aucun filtre). */
export function validHearingDepartment(
  value: string | null | undefined,
  departments: readonly { code: string }[],
): string | null {
  const code = value?.trim().toUpperCase() ?? "";
  return departments.find((department) => department.code.toUpperCase() === code)?.code ?? null;
}
