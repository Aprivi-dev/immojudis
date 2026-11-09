import "server-only";
import { loadPublicTribunalActivity } from "@/lib/public-tribunal-activity.server";
import { loadAmbiguousTribunalCodes } from "@/lib/tribunal-ambiguity.server";
import {
  indexableTribunalPages,
  isTribunalPageIndexable,
  tribunalActivityWithoutDuplicates,
  type TribunalPage,
} from "@/lib/tribunal-pages";
import { tryLoadTribunalSales } from "@/lib/tribunal-pages.server";
import {
  HEARINGS_PATH,
  dedupeHearings,
  isHearingsPageIndexable,
  windowHearings,
} from "@/lib/upcoming-hearings";
import { tryLoadUpcomingHearings } from "@/lib/upcoming-hearings.server";

/** Lectures des ventes de tribunal menées en même temps (voir `withoutDuplicateOnlyPages`). */
const TRIBUNAL_SALES_READ_CONCURRENCY = 6;

/**
 * Retire les tribunaux qui n'atteignent le seuil qu'en comptant deux fois une vente publiée par deux
 * sources. La page compte ses ventes sans ces doublons (`tribunalActivityWithoutDuplicates` dans sa
 * balise `robots`) : sans ce filtre, le sitemap annonçait des pages en `noindex`, ce que la Search
 * Console signale. La lecture est celle de la page, dans le même cache d'une heure. Une lecture en
 * échec garde le tribunal : la page retombe alors elle aussi sur le compteur de l'activité.
 */
async function withoutDuplicateOnlyPages(pages: readonly TribunalPage[]): Promise<TribunalPage[]> {
  const kept: boolean[] = new Array(pages.length).fill(true);
  let next = 0;
  async function worker() {
    while (next < pages.length) {
      const index = next;
      next += 1;
      const page = pages[index];
      const sales = await tryLoadTribunalSales(page.activity.code);
      kept[index] = isTribunalPageIndexable(
        tribunalActivityWithoutDuplicates(page.activity, sales).upcomingCount,
      );
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(TRIBUNAL_SALES_READ_CONCURRENCY, pages.length) }, worker),
  );
  return pages.filter((_, index) => kept[index]);
}

/**
 * Adresses des pages `/tribunaux/[slug]` et `/audiences-a-venir` pour le sitemap : seulement celles
 * qui sont indexables (au moins trois ventes à venir pour un tribunal, doublons écartés comme sur sa
 * page, trois audiences pour la page des audiences), selon le même seuil que leur balise `robots`. Une lecture en échec n'ajoute rien :
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
      // Même règle d'adresse que la page : deux tribunaux de même nom gardent leur adresse par code.
      const ambiguous = await loadAmbiguousTribunalCodes(tribunals.items);
      const pages = await withoutDuplicateOnlyPages(
        indexableTribunalPages(tribunals.items, ambiguous),
      );
      paths.push(...pages.map((page) => page.path));
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
