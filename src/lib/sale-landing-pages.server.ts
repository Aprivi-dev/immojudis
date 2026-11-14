import "server-only";
import { unstable_cache } from "next/cache";
import { compareSalesByDate, normalizeDepartmentCity } from "@/lib/department-pages";
import { readPublicSaleRows } from "@/lib/department-pages.server";
import { PUBLIC_CATALOGUE_CACHE_TAG } from "@/lib/public-catalogue.server";
import { tryPublicLoad, type PublicLoadResult } from "@/lib/public-load-result";
import { isProductionRuntime } from "@/lib/runtime-phase";
import {
  SALE_LANDING_LISTED_SALES,
  SALE_LANDING_PAGES,
  isSaleLandingIndexable,
  saleLandingSearchPath,
  visibleSaleLandingKeys,
  type SaleLandingData,
  type SaleLandingKey,
  type SaleLandingPage,
} from "@/lib/sale-landing-pages";
import type { PreviewRpcClient } from "@/lib/search/preview-search";
import { createPublicSupabaseClient } from "@/lib/supabase-public.server";
import { publicSupabaseConfigurationError } from "@/lib/supabase-configuration-error";

/**
 * Ventes des pages par type de bien ou de vente, lues comme le visiteur de `/sales` : le client
 * anonyme, la fonction publique `search_auction_sales_preview_v3` et le filtre de la page (mêmes
 * règles de visibilité et de masquage que la recherche et les pages de département). Toutes les
 * ventes du filtre sont lues, comme le catalogue des pages de département, mais pas le reste.
 *
 * Mis en cache une heure sous l'étiquette du catalogue public : l'appel du pipeline qui annonce une
 * vente retirée ou modifiée (`/api/pipeline/revalidate-sale`) la purge avec la recherche.
 */
export const SALE_LANDING_REVALIDATE_SECONDS = 3_600;

/**
 * Le total et les prochaines ventes d'un filtre. La fonction publique place les ventes
 * géolocalisées avant les autres, même triée par date : ses premières lignes ne sont pas les
 * prochaines ventes. Tout le filtre est donc lu (reportées comprises), puis trié par date comme
 * une page de département (`compareSalesByDate`), et la page garde les premières.
 */
export async function readSaleLanding(
  client: PreviewRpcClient,
  search: SaleLandingPage["search"],
  now: Date = new Date(),
): Promise<SaleLandingData> {
  const rows = await readPublicSaleRows(
    client,
    search,
    `sale-landing:${saleLandingSearchPath({ search })}`,
  );
  // Un identifiant compte une fois, comme dans `aggregateDepartments` : la pagination de la
  // recherche peut rendre deux fois la même vente.
  const sales = [...new Map(rows.map((sale) => [sale.id, sale])).values()].sort(compareSalesByDate);
  return {
    generatedAt: now.toISOString(),
    upcomingCount: sales.length,
    // Une seule écriture par arrondissement, comme sur les pages de département.
    sales: sales.slice(0, SALE_LANDING_LISTED_SALES).map((sale) => ({
      ...sale,
      city: normalizeDepartmentCity(sale.city),
    })),
  };
}

async function readSaleLandingFromDatabase(key: SaleLandingKey): Promise<SaleLandingData> {
  const client = createPublicSupabaseClient();
  if (!client) throw publicSupabaseConfigurationError();
  return readSaleLanding(client as unknown as PreviewRpcClient, SALE_LANDING_PAGES[key].search);
}

// Partagé par la page, ses métadonnées et le sitemap ; la clé de la page fait partie de la clé du
// cache. Une erreur n'est jamais mise en cache (`unstable_cache` ne garde que les succès).
// « v2 » : les ventes y sont triées par date sur tout le filtre ; une liste mise en cache avant ne
// l'est pas.
const cachedSaleLanding = unstable_cache(
  readSaleLandingFromDatabase,
  ["sale-landing-pages", "v2"],
  {
    revalidate: SALE_LANDING_REVALIDATE_SECONDS,
    tags: [PUBLIC_CATALOGUE_CACHE_TAG],
  },
);

export type SaleLandingResult = PublicLoadResult<{ data: SaleLandingData }>;

/** Ne lève pas : une base en panne donne `error`. */
export function tryLoadSaleLanding(key: SaleLandingKey): Promise<SaleLandingResult> {
  return tryPublicLoad(`[pages par type] Ventes « ${key} » indisponibles:`, async () => ({
    data: await cachedSaleLanding(key),
  }));
}

/**
 * Lecture d'une page rendue à l'avance (ISR), sur le modèle de `/audiences-a-venir`
 * (`isProductionRuntime`) : en production, une régénération qui ne peut pas lire la base lève, pour
 * que la dernière bonne page reste servie ; pendant le build (et en développement), `null` : la page
 * est produite sans sa liste, en `noindex`.
 */
export async function loadSaleLandingForPage(key: SaleLandingKey): Promise<SaleLandingData | null> {
  const result = await tryLoadSaleLanding(key);
  if (result.status === "ok") return result.data;
  if (isProductionRuntime()) throw new Error(`Ventes « ${key} » indisponibles.`);
  return null;
}

/**
 * Adresses des pages indexables pour le sitemap, selon la même règle que leur balise `robots`
 * (`isSaleLandingIndexable`) ; une page qui n'est pas proposée n'est pas lue. Une lecture en échec
 * n'ajoute pas la page : un incident passager ne doit ni inventer une page ni faire échouer le
 * sitemap. Sans `lastModified` : la liste change à chaque collecte, ce n'est pas une modification
 * du contenu.
 */
export async function loadIndexableSaleLandingPaths(): Promise<string[]> {
  const keys = visibleSaleLandingKeys();
  const results = await Promise.all(keys.map((key) => tryLoadSaleLanding(key)));
  return keys.flatMap((key, index) => {
    const result = results[index];
    const page = SALE_LANDING_PAGES[key];
    return result.status === "ok" && isSaleLandingIndexable(page, result.data.upcomingCount)
      ? [page.path]
      : [];
  });
}
