import Link from "next/link";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import { fetchFavoriteSales } from "@/lib/client-api";
import { PLAN_LIMITS } from "@/lib/plans";
import * as queryKeys from "@/lib/query-keys";

export const FAVORITE_ADD_LABEL = "Ajouter aux favoris";
export const FAVORITE_REMOVE_LABEL = "Retirer des favoris";
/** Pour un visiteur : le cœur reste visible et dit ce que le compte gratuit apporte. */
export const FAVORITE_ANONYMOUS_TITLE = `Créer un compte gratuit pour garder cette vente (${PLAN_LIMITS.decouverte.favoriteSales} favoris)`;
/** Compte reconnu dont la liste connectée n'est pas encore arrivée : le cœur attend les droits. */
export const FAVORITE_VERIFYING_TITLE = "Vérification du compte…";

/**
 * Confirms an add and, on a capped plan, shows how many places are used. Links to the list
 * (« Voir mes favoris ») and to the alert form.
 */
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
  // La suite logique d'un ajout : retrouver la liste (repasse design n° 27), puis l'alerte.
  toast.success(message, {
    description: (
      <span className="flex flex-wrap gap-x-4 gap-y-1">
        <Link href="/favoris" className="font-semibold underline">
          Voir mes favoris
        </Link>
        <Link href="/alertes" className="font-semibold underline">
          Être prévenu des nouvelles ventes : créer une alerte
        </Link>
      </span>
    ),
  });
}
