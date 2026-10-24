import "server-only";
import { unstable_cache } from "next/cache";
import {
  aggregateDepartments,
  type DepartmentCatalogue,
  type DepartmentSaleInput,
} from "@/lib/department-pages";
import { excludeHomepageExampleSales } from "@/lib/example-sale-identity";
import { getSaleProcedure } from "@/lib/sale-procedure";
import {
  buildPreviewSearchArgs,
  mapPreviewRows,
  runPreviewSearch,
  type PreviewRpcClient,
  type PreviewSearchRow,
} from "@/lib/search/preview-search";
import { createPublicSupabaseClient } from "@/lib/supabase-public.server";

/**
 * Catalogue des ventes à venir par département, lu comme le visiteur de `/sales` : le même client
 * anonyme, la même fonction publique `search_auction_sales_preview_v3` (même règle de visibilité
 * que le sitemap des ventes : statut à venir, annonce encore en ligne, hors quarantaine). Aucun
 * dédoublonnage n'existe à la lecture, ni pour `/sales` ni pour le sitemap : les doublons entre
 * sources sont fusionnés en amont, par le pipeline (`DEDUPE_RECONCILE_ENABLED`). Les comptes de
 * ces pages sont donc ceux de la liste publique, à l'identifiant près.
 */
export const DEPARTMENT_CATALOGUE_REVALIDATE_SECONDS = 3_600;
const DEPARTMENT_CATALOGUE_CACHE_TAG = "department-pages";

/** La fonction publique refuse plus de 100 lignes par page et un décalage supérieur à 10 000. */
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const PARALLEL_PAGES = 5;

/** `fetched` : lignes brutes de la page, avant écart de l'annonce de démonstration. */
type Reader<Item> = (page: number) => Promise<{ items: Item[]; count: number; fetched?: number }>;

type PublicSaleItems = Awaited<ReturnType<typeof runPreviewSearch>>["items"];

function saleRows(
  items: PublicSaleItems,
  postponedIds: ReadonlySet<string>,
): DepartmentSaleInput[] {
  return excludeHomepageExampleSales(items).map((sale) => ({
    id: sale.id,
    department: sale.department ?? null,
    city: sale.city ?? null,
    propertyType: sale.property_type ?? null,
    saleDate: sale.sale_date ?? null,
    startingPriceEur: sale.starting_price_eur ?? null,
    surfaceM2: sale.app_surface_m2 ?? null,
    venueType: getSaleProcedure(sale).venueType,
    status: postponedIds.has(sale.id) ? "postponed" : "scheduled",
  }));
}

/**
 * Lit toutes les pages de la liste publique, de la plus proche audience à la plus lointaine. Quand
 * le total annoncé par la fonction publique dépasse ce qui a pu être lu (au plus MAX_PAGES pages),
 * le catalogue est tronqué : l'écart est journalisé, sans bloquer la page.
 */
export async function readAllPublicSales<Item = DepartmentSaleInput>(
  read: Reader<Item>,
  scope: string = "catalogue",
): Promise<Item[]> {
  const first = await read(1);
  const pages = Math.min(MAX_PAGES, Math.ceil(first.count / PAGE_SIZE));
  const rows = [...first.items];
  let fetched = first.fetched ?? first.items.length;
  for (let start = 2; start <= pages; start += PARALLEL_PAGES) {
    const batch = Array.from(
      { length: Math.min(PARALLEL_PAGES, pages - start + 1) },
      (_, index) => start + index,
    );
    for (const page of await Promise.all(batch.map(read))) {
      rows.push(...page.items);
      fetched += page.fetched ?? page.items.length;
    }
  }
  if (first.count > fetched) {
    console.warn(
      JSON.stringify({
        scope: "department-pages",
        event: "catalogue_truncated",
        source: scope,
        announcedCount: first.count,
        readCount: fetched,
        pagesRead: pages,
        maxPages: MAX_PAGES,
        pageSize: PAGE_SIZE,
      }),
    );
  }
  return rows;
}

/**
 * Identifiants des ventes reportées. La fonction publique ne renvoie pas le statut d'une vente : un
 * second appel, filtré sur `postponed` (même fonction, mêmes règles de visibilité), les repère. Une
 * vente reportée n'a plus de date valable : la page ne l'annonce pas comme prochaine audience.
 */
async function readPostponedSaleIds(client: PreviewRpcClient): Promise<Set<string>> {
  const ids = new Set<string>();
  await readAllPublicSales(async (page) => {
    const { data, error } = await client.rpc("search_auction_sales_preview_v3", {
      ...buildPreviewSearchArgs({ sort: "sale_date_asc", limit: PAGE_SIZE, page }),
      p_statuses: ["postponed"],
    });
    if (error) throw error;
    const rows = (data ?? []) as PreviewSearchRow[];
    for (const sale of mapPreviewRows(rows)) ids.add(sale.id);
    return { items: [], count: Number(rows[0]?.total_count ?? 0), fetched: rows.length };
  }, "postponed");
  return ids;
}

async function readDepartmentCatalogue(): Promise<DepartmentCatalogue> {
  const client = createPublicSupabaseClient();
  if (!client) throw new Error("Supabase n'est pas configuré côté serveur.");
  const rpcClient = client as unknown as PreviewRpcClient;
  const postponedIds = await readPostponedSaleIds(rpcClient);
  const rows = await readAllPublicSales(async (page) => {
    const response = await runPreviewSearch(rpcClient, {
      sort: "sale_date_asc",
      limit: PAGE_SIZE,
      page,
    });
    return {
      items: saleRows(response.items, postponedIds),
      count: response.count,
      fetched: response.items.length,
    };
  });
  return aggregateDepartments(rows);
}

// Partagé par l'index, les pages de département et le sitemap : une lecture par heure et par
// instance. Une erreur n'est jamais mise en cache (`unstable_cache` ne garde que les succès).
const cachedDepartmentCatalogue = unstable_cache(
  readDepartmentCatalogue,
  ["department-pages", "catalogue", "v1"],
  {
    revalidate: DEPARTMENT_CATALOGUE_REVALIDATE_SECONDS,
    tags: [DEPARTMENT_CATALOGUE_CACHE_TAG],
  },
);

// Lecture en vol, partagée au niveau du module : `generateMetadata`, la page et le sitemap d'un même
// processus qui arrivent pendant une lecture complète (jusqu'à 100 appels à la base) attendent la
// même promesse au lieu d'en lancer chacun une. Elle est libérée dès qu'elle se termine, succès ou
// échec : un échec n'est donc jamais rejoué par les appels suivants. Le cache de données prend le
// relais ensuite.
let inFlight: Promise<DepartmentCatalogue> | null = null;

/** Lève une erreur si la base est indisponible : l'appelant décide de ce qu'il en fait. */
export function loadDepartmentCatalogue(): Promise<DepartmentCatalogue> {
  if (!inFlight) {
    const reading = cachedDepartmentCatalogue().finally(() => {
      if (inFlight === reading) inFlight = null;
    });
    inFlight = reading;
  }
  return inFlight;
}

export type DepartmentCatalogueResult =
  | { status: "ok"; catalogue: DepartmentCatalogue }
  | { status: "error" };

/** Variante qui ne lève pas : pour le sitemap et l'index, qui doivent rester disponibles. */
export async function tryLoadDepartmentCatalogue(): Promise<DepartmentCatalogueResult> {
  try {
    return { status: "ok", catalogue: await loadDepartmentCatalogue() };
  } catch (error) {
    console.warn("[departements] Catalogue indisponible:", error);
    return { status: "error" };
  }
}
