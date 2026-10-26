import { useQuery } from "@tanstack/react-query";
import { fetchSalePepite, type PepiteView } from "@/lib/client-api/sale-pepite";
import * as queryKeys from "@/lib/query-keys";
import { fetchPepiteSaleIds } from "@/lib/search/pepite-filter";
import type { PepitePayload } from "@/lib/sale-pepite-view";

/**
 * Le repère « Pépite » d'une fiche. Sans réponse d'avance (`known` absent : fiche d'un compte, dont la ligne ne
 * porte pas le repère), la liste publique des pépites (gardée 5 minutes, jamais un appel par fiche) dit si la
 * vente en est une ; seule une pépite appelle la route. `known` (aperçu public : `get_public_sale_pepite` lu avec
 * la fiche) évite même cette lecture. En mode « shadow », ou sans la migration : aucune pépite, aucun appel.
 * Une panne ou un 404 donnent `null` : le repère disparaît, la fiche ne change pas.
 */
export function useSalePepite({
  saleId,
  view,
  userKey,
  known,
  enabled = true,
}: {
  saleId: string;
  view: PepiteView;
  userKey: string;
  known?: boolean;
  enabled?: boolean;
}): PepitePayload | null {
  const ids = useQuery({
    queryKey: queryKeys.pepiteSaleIds(),
    queryFn: () => fetchPepiteSaleIds(),
    enabled: enabled && known === undefined,
    staleTime: 5 * 60_000,
    // Une erreur (429, 503) n'est pas gardée comme « aucune pépite » : pas de repère, et la liste se relira.
    retry: false,
  });
  const isPepite = known === true || (known === undefined && ids.data?.has(saleId) === true);
  const query = useQuery({
    queryKey: queryKeys.salePepite(saleId, view, userKey),
    queryFn: () => fetchSalePepite(saleId, view),
    enabled: enabled && isPepite,
    staleTime: 5 * 60_000,
    retry: false,
  });
  return query.data ?? null;
}
