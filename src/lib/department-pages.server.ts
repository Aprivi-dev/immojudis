import { unstable_cache } from "next/cache";
import {
  aggregateDepartments,
  type DepartmentCatalogue,
  type DepartmentSaleInput,
} from "@/lib/department-pages";
import { excludeHomepageExampleSales } from "@/lib/example-sale-identity";
import { runPreviewSearch, type PreviewRpcClient } from "@/lib/search/preview-search";
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

type Reader = (page: number) => Promise<{ items: DepartmentSaleInput[]; count: number }>;

function saleRows(
  items: Awaited<ReturnType<typeof runPreviewSearch>>["items"],
): DepartmentSaleInput[] {
  return excludeHomepageExampleSales(items).map((sale) => ({
    id: sale.id,
    department: sale.department ?? null,
    city: sale.city ?? null,
    propertyType: sale.property_type ?? null,
    saleDate: sale.sale_date ?? null,
    startingPriceEur: sale.starting_price_eur ?? null,
    surfaceM2: sale.app_surface_m2 ?? null,
  }));
}

/** Lit toutes les pages de la liste publique, de la plus proche audience à la plus lointaine. */
export async function readAllPublicSales(read: Reader): Promise<DepartmentSaleInput[]> {
  const first = await read(1);
  const pages = Math.min(MAX_PAGES, Math.ceil(first.count / PAGE_SIZE));
  const rows = [...first.items];
  for (let start = 2; start <= pages; start += PARALLEL_PAGES) {
    const batch = Array.from(
      { length: Math.min(PARALLEL_PAGES, pages - start + 1) },
      (_, index) => start + index,
    );
    for (const page of await Promise.all(batch.map(read))) rows.push(...page.items);
  }
  return rows;
}

async function readDepartmentCatalogue(): Promise<DepartmentCatalogue> {
  const client = createPublicSupabaseClient();
  if (!client) throw new Error("Supabase n'est pas configuré côté serveur.");
  const rows = await readAllPublicSales(async (page) => {
    const response = await runPreviewSearch(client as unknown as PreviewRpcClient, {
      sort: "sale_date_asc",
      limit: PAGE_SIZE,
      page,
    });
    return { items: saleRows(response.items), count: response.count };
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

/** Lève une erreur si la base est indisponible : l'appelant décide de ce qu'il en fait. */
export function loadDepartmentCatalogue(): Promise<DepartmentCatalogue> {
  return cachedDepartmentCatalogue();
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
