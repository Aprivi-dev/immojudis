import { getSupabase } from "@/integrations/supabase/lazy";

/**
 * Filtre de `/sales` « Mise à prix sous la fourchette des ventes comparables » (point 71).
 *
 * La bande d'écart au marché se calcule vente par vente dans la base
 * (`get_public_sale_market_gap_band`, migration 20261029120000) : les vues du catalogue n'en ont pas la
 * colonne. La fonction `list_public_sale_ids_under_market_range` (migration 20261030110000) rend les
 * identifiants des ventes dont la bande publique est `under` : même porte que la fiche, c'est-à-dire
 * estimation assez fiable seulement, et jamais un bien occupé (la base dit alors `occupied`). La recherche
 * croise cette liste avec les lignes qu'elle lit déjà pour ses autres filtres avancés
 * (`applyClientSearchFilters`).
 *
 * La liste ne change qu'avec les estimations (recalculées par lots) : le navigateur la garde 5 minutes,
 * comme la recherche d'aperçu. Une panne n'est jamais gardée.
 */
export const UNDER_RANGE_FILTER_UNAVAILABLE_MESSAGE =
  "Le filtre « sous la fourchette » est momentanément indisponible. Retirez-le ou réessayez dans un instant.";

const CACHE_MS = 5 * 60_000;

let cached: { at: number; ids: Promise<ReadonlySet<string>> } | null = null;

/** Fonction de base absente (migration pas encore appliquée). */
function isMissingFunction(error: { code?: unknown } | null): boolean {
  return error?.code === "PGRST202" || error?.code === "42883";
}

async function readUnderRangeSaleIds(): Promise<ReadonlySet<string>> {
  const client = await getSupabase();
  const { data, error } = await client.rpc("list_public_sale_ids_under_market_range");
  if (error) {
    if (!isMissingFunction(error)) {
      console.warn("[search] liste des ventes sous la fourchette indisponible:", error.code);
    }
    throw new Error(UNDER_RANGE_FILTER_UNAVAILABLE_MESSAGE);
  }
  const ids = Array.isArray(data) ? data : [];
  return new Set(
    ids.filter((id): id is string => typeof id === "string").map((id) => id.toLowerCase()),
  );
}

/**
 * Identifiants (en minuscules) des ventes dont la mise à prix est sous la fourchette des ventes
 * comparables. Lève, avec un message lisible, quand la liste n'a pas pu être lue : le filtre n'affiche
 * jamais « toutes les ventes » à sa place.
 */
export async function fetchUnderRangeSaleIds(now = Date.now()): Promise<ReadonlySet<string>> {
  if (cached && now - cached.at < CACHE_MS) return cached.ids;
  const entry = { at: now, ids: readUnderRangeSaleIds() };
  cached = entry;
  entry.ids.catch(() => {
    if (cached === entry) cached = null;
  });
  return entry.ids;
}

/** Pour les tests : oublie la liste gardée. */
export function resetUnderRangeSaleIdsCache(): void {
  cached = null;
}
