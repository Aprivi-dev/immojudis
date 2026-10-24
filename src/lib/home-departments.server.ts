import "server-only";
import type { DepartmentCatalogueResult } from "@/lib/department-pages.server";
import { tryLoadDepartmentCatalogue } from "@/lib/department-pages.server";

const DEPARTMENTS_TIMEOUT_MS = 4_000;

/**
 * Nombre de départements qui ont au moins une vente à venir, pour la bande de chiffres de
 * l'accueil. Il vient du catalogue des pages de département (même lecture, même cache d'une heure :
 * aucune lecture de plus pour l'accueil). `null` si ce catalogue tarde ou manque : le chiffre n'est
 * alors pas affiché.
 */
export async function loadHomeDepartmentCount({
  load = tryLoadDepartmentCatalogue,
  timeoutMs = DEPARTMENTS_TIMEOUT_MS,
}: {
  load?: () => Promise<DepartmentCatalogueResult>;
  timeoutMs?: number;
} = {}): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const result = await Promise.race([load(), timeout]).finally(() => clearTimeout(timer));
  if (!result || result.status !== "ok") return null;
  const count = Object.values(result.catalogue.departments).filter(
    (department) => department.upcomingCount > 0,
  ).length;
  return count > 0 ? count : null;
}
