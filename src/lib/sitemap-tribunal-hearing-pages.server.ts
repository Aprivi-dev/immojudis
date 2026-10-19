import "server-only";
import { loadPublicTribunalActivity } from "@/lib/public-tribunal-activity.server";
import { indexableTribunalPages } from "@/lib/tribunal-pages";
import {
  HEARINGS_PATH,
  dedupeHearings,
  isHearingsPageIndexable,
  windowHearings,
} from "@/lib/upcoming-hearings";
import { tryLoadUpcomingHearings } from "@/lib/upcoming-hearings.server";

/**
 * Adresses des pages `/tribunaux/[slug]` et `/audiences-a-venir` pour le sitemap : seulement celles
 * qui sont indexables (au moins trois ventes à venir pour un tribunal, trois audiences pour la page
 * des audiences), selon le même seuil que leur balise `robots`. Une lecture en échec n'ajoute rien :
 * un incident passager ne doit ni inventer des pages ni faire échouer le sitemap. Sans
 * `lastModified` : les chiffres sont refaits toutes les heures, ce qui n'est pas une modification
 * du contenu.
 */
export async function loadTribunalAndHearingPaths(): Promise<string[]> {
  try {
    const [tribunals, hearings] = await Promise.all([
      loadPublicTribunalActivity(),
      tryLoadUpcomingHearings(),
    ]);
    const paths: string[] = [];
    if (tribunals.status === "ok") {
      paths.push(...indexableTribunalPages(tribunals.items).map((page) => page.path));
    }
    if (hearings.status === "ok") {
      const windows = windowHearings(dedupeHearings(hearings.hearings));
      if (isHearingsPageIndexable(windows.weekCount + windows.laterCount)) {
        paths.push(HEARINGS_PATH);
      }
    }
    return paths;
  } catch (error) {
    console.warn("[sitemap] Pages des tribunaux et des audiences indisponibles:", error);
    return [];
  }
}
