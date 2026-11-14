import "server-only";
import { unstable_cache } from "next/cache";
import { normalizeDepartmentCity } from "@/lib/department-pages";
import { saleRows } from "@/lib/department-pages.server";
import { PUBLIC_CATALOGUE_CACHE_TAG } from "@/lib/public-catalogue.server";
import { tryPublicLoad, type PublicLoadResult } from "@/lib/public-load-result";
import { isProductionRuntime } from "@/lib/runtime-phase";
import {
  SALE_LANDING_KEYS,
  SALE_LANDING_LISTED_SALES,
  SALE_LANDING_PAGES,
  isSaleLandingIndexable,
  type SaleLandingData,
  type SaleLandingKey,
  type SaleLandingPage,
} from "@/lib/sale-landing-pages";
import {
  buildPreviewSearchArgs,
  mapPreviewRows,
  runPreviewSearch,
  type PreviewRpcClient,
  type PreviewSearchRow,
} from "@/lib/search/preview-search";
import type { SalesSearchParams } from "@/lib/search/search-url-state";
import { createPublicSupabaseClient } from "@/lib/supabase-public.server";
import { publicSupabaseConfigurationError } from "@/lib/supabase-configuration-error";

/**
 * Ventes des pages par type de bien ou de vente, lues comme le visiteur de `/sales` : le client
 * anonyme, la fonction publique `search_auction_sales_preview_v3` et le filtre de la page (mêmes
 * règles de visibilité et de masquage que la recherche et les pages de département). Deux appels
 * légers par page, sans lecture complète du catalogue.
 *
 * Mis en cache une heure sous l'étiquette du catalogue public : l'appel du pipeline qui annonce une
 * vente retirée ou modifiée (`/api/pipeline/revalidate-sale`) la purge avec la recherche.
 */
export const SALE_LANDING_REVALIDATE_SECONDS = 3_600;

/**
 * Le total et les prochaines ventes d'un filtre. La fonction publique ne renvoie pas le statut : un
 * second appel, même filtre et même ordre, lit les ventes reportées. Il suffit d'en lire autant que
 * la page en liste : une vente reportée parmi les N premières ventes (par date) est forcément parmi
 * les N premières ventes reportées.
 */
export async function readSaleLanding(
  client: PreviewRpcClient,
  search: SaleLandingPage["search"],
  now: Date = new Date(),
): Promise<SaleLandingData> {
  const listed: SalesSearchParams = {
    ...search,
    sort: "sale_date_asc",
    limit: SALE_LANDING_LISTED_SALES,
    page: 1,
  };
  const [response, postponed] = await Promise.all([
    runPreviewSearch(client, listed),
    client.rpc("search_auction_sales_preview_v3", {
      ...buildPreviewSearchArgs(listed),
      p_statuses: ["postponed"],
    }),
  ]);
  if (postponed.error) throw postponed.error;
  const postponedIds = new Set(
    mapPreviewRows((postponed.data ?? []) as PreviewSearchRow[]).map((sale) => sale.id),
  );
  return {
    generatedAt: now.toISOString(),
    upcomingCount: response.count,
    // Une seule écriture par arrondissement, comme sur les pages de département.
    sales: saleRows(response.items, postponedIds).map((sale) => ({
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
const cachedSaleLanding = unstable_cache(
  readSaleLandingFromDatabase,
  ["sale-landing-pages", "v1"],
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
 * Adresses des pages indexables pour le sitemap, selon le même seuil que leur balise `robots`. Une
 * lecture en échec n'ajoute pas la page : un incident passager ne doit ni inventer une page ni faire
 * échouer le sitemap. Sans `lastModified` : la liste change à chaque collecte, ce n'est pas une
 * modification du contenu.
 */
export async function loadIndexableSaleLandingPaths(): Promise<string[]> {
  const results = await Promise.all(SALE_LANDING_KEYS.map((key) => tryLoadSaleLanding(key)));
  return SALE_LANDING_KEYS.flatMap((key, index) => {
    const result = results[index];
    return result.status === "ok" && isSaleLandingIndexable(result.data.upcomingCount)
      ? [SALE_LANDING_PAGES[key].path]
      : [];
  });
}
