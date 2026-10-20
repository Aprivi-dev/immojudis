"use client";

import { useId } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import FolderHeart from "lucide-react/dist/esm/icons/folder-heart.js";
import { FavoriteButton } from "@/components/FavoriteButton";
import { SaleRemindersToggle } from "@/components/SaleRemindersToggle";
import { Button, Card, Eyebrow } from "@/components/ui/primitives";
import { useAuth } from "@/hooks/use-auth";
import { fetchFavoriteDossier, saveFavoriteDossier } from "@/lib/client-api";
import {
  FAVORITE_DOSSIER_STATUSES,
  favoriteDossierStatusLabel,
  normalizeFavoriteDossierStatus,
  type FavoriteDossierInput,
  type FavoriteDossierResponse,
} from "@/lib/favorite-dossier-shared";
import { formatDate, formatPrice } from "@/lib/format";
import { queryKeys } from "@/lib/query-keys";
import { toast } from "@/lib/toast";
import { userMessage } from "@/lib/user-messages";

/**
 * « Mon dossier » (point 68), gratuit : le statut personnel et l'enchère plafond d'une vente suivie,
 * enregistrés sur le compte et retrouvés dans « Mes favoris ». Le stockage est gratuit ; le calcul
 * de l'enchère plafond garde ses droits (Analyse, ou la vente débloquée) : `calculatedCeiling` est
 * le résultat du calculateur de la fiche, absent quand le compte n'y a pas accès.
 */
export function SaleFileCard({
  saleId,
  calculatedCeiling,
  calculationPending = false,
}: {
  saleId: string;
  /** Enchère plafond calculée par le calculateur de la fiche, en euros ; null si elle n'est pas disponible. */
  calculatedCeiling: number | null;
  /** Le calcul est ouvert à ce compte mais l'estimation de marché n'est pas encore arrivée. */
  calculationPending?: boolean;
}) {
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const statusId = useId();
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
      // La liste « Mes favoris » (clé exacte) : la réponse du serveur vient déjà d'être posée sur ce dossier.
      void queryClient.invalidateQueries({ queryKey: queryKeys.favorites(userId), exact: true });
      toast.success("Dossier enregistré sur votre compte.");
    },
    onError: (error: unknown) =>
      toast.error(userMessage(error, "Impossible d’enregistrer votre dossier.")),
  });

  if (!userId || loading) return null;

  const dossier = query.data?.dossier;
  const ceiling =
    calculatedCeiling != null && Number.isFinite(calculatedCeiling) && calculatedCeiling >= 0
      ? Math.round(calculatedCeiling)
      : null;

  return (
    <Card as="section" aria-labelledby="sale-file-title" className="mt-4" id="mon-dossier">
      <Eyebrow className="flex items-center gap-2">
        <FolderHeart className="size-4" aria-hidden /> Gratuit, sur votre compte
      </Eyebrow>
      <h2 id="sale-file-title" className="mt-2 font-display text-2xl text-brand-navy">
        Mon dossier
      </h2>

      {query.isPending ? (
        <p role="status" className="mt-2 text-sm text-ink-soft">
          Chargement de votre dossier…
        </p>
      ) : query.isError ? (
        <div role="alert" className="mt-2 text-sm">
          <p>{userMessage(query.error, "Votre dossier est momentanément indisponible.")}</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={() => void query.refetch()}
          >
            Réessayer
          </Button>
        </div>
      ) : dossier && !dossier.followed ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-xl text-sm leading-relaxed text-ink-soft">
            Suivez cette vente pour y enregistrer votre statut et votre enchère plafond. Vous les
            retrouverez dans vos favoris, sur tous vos appareils.
          </p>
          <FavoriteButton saleId={saleId} />
        </div>
      ) : dossier ? (
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={statusId} className="text-sm font-semibold text-brand-navy">
              Mon statut
            </label>
            <select
              id={statusId}
              className="form-input mt-1 min-h-11 w-full"
              value={dossier.personalStatus ?? ""}
              disabled={save.isPending}
              onChange={(event) =>
                save.mutate({ personalStatus: normalizeFavoriteDossierStatus(event.target.value) })
              }
            >
              <option value="">Aucun statut</option>
              {FAVORITE_DOSSIER_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {favoriteDossierStatusLabel(status)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <p className="text-sm font-semibold text-brand-navy">Mon enchère plafond</p>
            <p className="mt-1 text-sm" data-testid="saved-ceiling">
              {dossier.bidCeilingEur != null ? (
                <>
                  <strong className="tabular-nums">{formatPrice(dossier.bidCeilingEur)}</strong>
                  {dossier.bidCeilingSavedAt
                    ? ` · enregistrée le ${formatDate(dossier.bidCeilingSavedAt)}`
                    : null}
                </>
              ) : (
                "Aucune enchère plafond enregistrée."
              )}
            </p>
            {ceiling == null && calculationPending ? (
              <p role="status" className="mt-2 text-xs leading-relaxed text-ink-soft">
                Calcul de l’enchère plafond en cours…
              </p>
            ) : ceiling == null ? (
              <p className="mt-2 text-xs leading-relaxed text-ink-soft">
                Aucun calcul d’enchère plafond n’est disponible pour cette vente avec votre accès
                actuel : il n’y a donc rien à enregistrer pour l’instant.
              </p>
            ) : ceiling === dossier.bidCeilingEur ? (
              <p className="mt-2 text-xs leading-relaxed text-ink-soft">
                C’est le résultat du calcul actuel.
              </p>
            ) : (
              <div className="mt-2">
                {dossier.bidCeilingEur != null ? (
                  <p className="mb-2 text-xs leading-relaxed text-ink-soft">
                    Le calcul actuel donne {formatPrice(ceiling)} : votre plafond enregistré ne
                    change que si vous l’enregistrez.
                  </p>
                ) : null}
                <Button
                  variant="primary"
                  size="sm"
                  disabled={save.isPending}
                  onClick={() => save.mutate({ bidCeilingEur: ceiling })}
                >
                  Enregistrer mon plafond calculé ({formatPrice(ceiling)})
                </Button>
              </div>
            )}
            {dossier.bidCeilingEur != null ? (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                disabled={save.isPending}
                onClick={() => save.mutate({ bidCeilingEur: null })}
              >
                Retirer mon plafond
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {dossier?.followed ? (
        <SaleRemindersToggle
          userId={userId}
          className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-4 py-3 text-sm"
        />
      ) : null}

      <p className="mt-4 text-xs leading-relaxed text-ink-soft">
        L’enchère plafond est une simulation fondée sur vos hypothèses : elle ne garantit aucun prix
        d’adjudication et ne remplace pas le conseil de votre avocat.
      </p>
    </Card>
  );
}
