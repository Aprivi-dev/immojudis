import { FRENCH_DEPARTMENTS, type FrenchDepartment } from "@/lib/departments";

/**
 * Départements proposés par le simulateur de frais : le référentiel `src/lib/departments.ts`, sans
 * copie. Le test vérifie que chaque code est reconnu par `departmentCode`, qui alimente le taux de
 * droits de mutation.
 */
export const FEES_SIMULATOR_DEPARTMENTS: ReadonlyArray<FrenchDepartment> = FRENCH_DEPARTMENTS;
