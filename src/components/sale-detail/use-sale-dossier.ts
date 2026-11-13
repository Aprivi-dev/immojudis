"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { fetchFavoriteDossier, saveFavoriteDossier } from "@/lib/client-api";
import type { FavoriteDossierInput, FavoriteDossierResponse } from "@/lib/favorite-dossier-shared";
import * as queryKeys from "@/lib/query-keys";
import { toast } from "@/lib/toast";
import { userMessage } from "@/lib/user-messages";

/**
 * « Mon dossier » d'une vente (statut et enchère plafond enregistrés sur le compte), lu et écrit avec
 * la même clé de requête que la carte « Mon dossier » : le panneau de la fiche, le bouton
 * « Enregistrer ce plafond » et la carte se tiennent à jour ensemble.
 */
export function useSaleDossier(saleId: string) {
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id ?? null;
  const dossierKey = queryKeys.favoriteDossier(userId, saleId);
  const query = useQuery({
    queryKey: dossierKey,
    queryFn: () => fetchFavoriteDossier(saleId),
    enabled: Boolean(userId) && !loading,
  });
  const save = useMutation({
    mutationFn: (changes: Omit<FavoriteDossierInput, "saleId">) =>
      saveFavoriteDossier({ data: { saleId, ...changes } }),
    onSuccess: (response: FavoriteDossierResponse) => {
      queryClient.setQueryData(dossierKey, response);
      void queryClient.invalidateQueries({ queryKey: queryKeys.favorites(userId), exact: true });
    },
    onError: (error: unknown) =>
      toast.error(userMessage(error, "Impossible d’enregistrer votre dossier.")),
  });
  const dossier = query.data?.dossier ?? null;
  // Un plafond de 0 € n'existe pas : une ancienne valeur nulle compte comme absente.
  const savedCeiling =
    dossier?.bidCeilingEur != null && dossier.bidCeilingEur > 0 ? dossier.bidCeilingEur : null;
  return { userId, query, dossier, savedCeiling, save };
}
