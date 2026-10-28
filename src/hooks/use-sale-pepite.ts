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
export type SalePepiteArgs = {
  saleId: string;
  view: PepiteView;
  userKey: string;
  known?: boolean;
  enabled?: boolean;
};

/**
 * Où en est la lecture du repère : `idle` (pas une pépite, ou la liste publique n'est pas encore lue),
 * `loading` (la route est en cours), `error` (panne, limite de débit : le repère reste affiché sans son
 * détail), `absent` (404 : plus une pépite publiable) ou `ready`.
 */
export type SalePepiteStatus = "idle" | "loading" | "error" | "absent" | "ready";

export function useSalePepite(args: SalePepiteArgs): PepitePayload | null {
  return useSalePepiteState(args).payload;
}

/** `useSalePepite` et l'état de la lecture : pour afficher un emplacement pendant le chargement, une erreur sinon. */
export function useSalePepiteState({
  saleId,
  view,
  userKey,
  known,
  enabled = true,
}: SalePepiteArgs): { payload: PepitePayload | null; status: SalePepiteStatus } {
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
  const payload = query.data ?? null;
  let status: SalePepiteStatus = "idle";
  if (payload) status = "ready";
  else if (enabled && isPepite) {
    if (query.isError) status = "error";
    else if (query.isPending) status = "loading";
    else status = "absent";
  }
  return { payload, status };
}
