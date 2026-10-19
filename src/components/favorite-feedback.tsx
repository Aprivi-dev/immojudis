import Link from "next/link";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { fetchFavoriteSales } from "@/lib/client-api";
import { PLAN_LIMITS } from "@/lib/plans";
import { queryKeys } from "@/lib/query-keys";

export const FAVORITE_ADD_LABEL = "Ajouter aux favoris";
export const FAVORITE_REMOVE_LABEL = "Retirer des favoris";
/** Pour un visiteur : le cœur reste visible et dit ce que le compte gratuit apporte. */
export const FAVORITE_ANONYMOUS_TITLE = `Créer un compte gratuit pour garder cette vente (${PLAN_LIMITS.decouverte.favoriteSales} favoris)`;
/** Compte reconnu dont la liste connectée n'est pas encore arrivée : le cœur attend les droits. */
export const FAVORITE_VERIFYING_TITLE = "Vérification du compte…";

/** Confirms an add and, on a capped plan, shows how many places are used. */
export async function announceFavoriteAdded(
  queryClient: QueryClient,
  userId: string,
  limit: number | null,
) {
  let message = "Vente ajoutée aux favoris.";
  if (limit != null) {
    try {
      const list = await queryClient.fetchQuery({
        queryKey: queryKeys.favorites(userId),
        queryFn: fetchFavoriteSales,
        staleTime: 0,
      });
      const used = list.favorites.length + (list.unavailableSaleIds?.length ?? 0);
      message = `Vente ajoutée aux favoris : ${used} ${used > 1 ? "favoris" : "favori"} sur ${limit}.`;
    } catch {
      // The count is a courtesy: the add itself already succeeded.
    }
  }
  toast.success(message, {
    description: (
      <Link href="/alertes" className="font-semibold underline">
        Être prévenu des nouvelles ventes : créer une alerte
      </Link>
    ),
  });
}
