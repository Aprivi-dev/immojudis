import "server-only";
import { unstable_cache } from "next/cache";
import type { DepartmentSale } from "@/lib/department-pages";
import { createPublicSupabaseClient } from "@/lib/supabase-public.server";
import { TRIBUNAL_PAGE_LISTED_SALES } from "@/lib/tribunal-pages";

/**
 * Prochaines ventes d'un tribunal, lues comme un visiteur anonyme avec la fonction publique
 * `get_public_tribunal_sales` (même règle de visibilité que les cartes de la recherche et que
 * l'activité par tribunal : les chiffres de la page et sa liste parlent des mêmes ventes). Aucune
 * adresse exacte n'en sort.
 */
export const TRIBUNAL_SALES_REVALIDATE_SECONDS = 3_600;
export const TRIBUNAL_SALES_CACHE_TAG = "tribunal-pages";

/** Ligne de `get_public_tribunal_sales` : numeric arrive parfois en chaîne de PostgREST. */
export type TribunalSaleRow = {
  id: string;
  city: string | null;
  department: string | null;
  property_type: string | null;
  sale_date: string | null;
  starting_price_eur: number | string | null;
  surface_m2: number | string | null;
  status: string | null;
};

type TribunalRpcClient = {
  rpc: (
    fn: "get_public_tribunal_sales",
    args: { p_tribunal_code: string; p_limit: number },
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

function finite(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function tribunalSaleStatus(status: string | null): DepartmentSale["status"] {
  if (status === "postponed") return "postponed";
  return status == null || status.trim() === "" || status === "unknown" ? "unknown" : "scheduled";
}

/**
 * Une vente reportée n'a plus de date valable : la page ne l'annonce pas comme prochaine audience.
 * Un statut que la base ne connaît pas (`unknown`, ou absent) reste `unknown` : il n'est pas
 * présenté comme une vente à venir confirmée.
 */
export function mapTribunalSaleRows(rows: readonly TribunalSaleRow[]): DepartmentSale[] {
  return rows.map((row) => ({
    id: row.id,
    city: row.city,
    propertyType: row.property_type,
    saleDate: row.sale_date,
    startingPriceEur: finite(row.starting_price_eur),
    surfaceM2: finite(row.surface_m2),
    // La fonction ne rend que des ventes au tribunal.
    venueType: "tribunal" as const,
    status: tribunalSaleStatus(row.status),
  }));
}

async function readTribunalSales(tribunalCode: string): Promise<DepartmentSale[]> {
  const client = createPublicSupabaseClient();
  if (!client) throw new Error("Supabase n'est pas configuré côté serveur.");
  const { data, error } = await (client as unknown as TribunalRpcClient).rpc(
    "get_public_tribunal_sales",
    { p_tribunal_code: tribunalCode, p_limit: TRIBUNAL_PAGE_LISTED_SALES },
  );
  if (error) throw error;
  return mapTribunalSaleRows((data ?? []) as TribunalSaleRow[]);
}

// Une lecture par heure, tribunal par tribunal. Une erreur n'est jamais mise en cache.
const cachedTribunalSales = unstable_cache(readTribunalSales, ["tribunal-pages", "sales", "v1"], {
  revalidate: TRIBUNAL_SALES_REVALIDATE_SECONDS,
  tags: [TRIBUNAL_SALES_CACHE_TAG],
});

export type TribunalSalesResult = { status: "ok"; sales: DepartmentSale[] } | { status: "error" };

/**
 * Les prochaines ventes d'un tribunal. Ne lève pas : la fonction peut manquer (migration pas
 * encore appliquée) ou la base être indisponible ; la page garde alors ses chiffres, qui viennent
 * d'ailleurs, et renvoie vers la recherche.
 */
export async function tryLoadTribunalSales(tribunalCode: string): Promise<TribunalSalesResult> {
  try {
    return { status: "ok", sales: await cachedTribunalSales(tribunalCode) };
  } catch (error) {
    console.warn("[tribunaux] Ventes du tribunal indisponibles:", tribunalCode, error);
    return { status: "error" };
  }
}
