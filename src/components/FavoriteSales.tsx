"use client";

import Link from "next/link";
import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Heart from "lucide-react/dist/esm/icons/heart.js";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import {
  addFavoriteSale,
  fetchFavoriteSales,
  fetchSalesAiReviewProjections,
} from "@/lib/client-api";
import {
  type AiReviewProjectionReadModel,
  type AiReviewRequestStatus,
} from "@/lib/ai-review-guard";
import { userMessage } from "@/lib/user-messages";
import { Badge, Card, PageShell, buttonClasses } from "@/components/ui/primitives";
import { ListingCard } from "@/components/search/SearchResults";
import { FavoriteButton } from "./FavoriteButton";

const NOOP = () => undefined;

export function FavoriteSales() {
  const { user, loading } = useAuth();
  const query = useQuery({
    queryKey: ["favorites", user?.id],
    queryFn: fetchFavoriteSales,
    enabled: Boolean(user) && !loading,
  });
  const data = user && !loading ? query.data : undefined;
  const isAnalysis = data?.plan.code === "analyse";
  const favoriteSaleIds = useMemo(
    () => data?.favorites.map(({ saleId }) => saleId) ?? [],
    [data?.favorites],
  );
  const aiReviewQuery = useQuery({
    queryKey: ["favorites-ai-review", user?.id, favoriteSaleIds],
    queryFn: () => fetchSalesAiReviewProjections(favoriteSaleIds),
    // Discovery rows already come from the redacted public view. The AI
    // review endpoint reads the Analyse view and would turn valid public city,
    // price and date fields into "à confirmer" placeholders for free users.
    enabled: Boolean(user && !loading && isAnalysis && favoriteSaleIds.length),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const aiReviewBySaleId = useMemo(() => {
    const grouped: Record<string, AiReviewProjectionReadModel[]> = {};
    for (const projection of aiReviewQuery.data?.projections ?? []) {
      if (!projection.auction_sale_id) continue;
      (grouped[projection.auction_sale_id] ??= []).push(projection);
    }
    return grouped;
  }, [aiReviewQuery.data]);
  const aiReviewStatus: AiReviewRequestStatus =
    !user || loading || !isAnalysis || favoriteSaleIds.length === 0
      ? "disabled"
      : aiReviewQuery.isError
        ? "error"
        : aiReviewQuery.data
          ? "ready"
          : "loading";
  const queryClient = useQueryClient();
  const handleFavoriteChange = useCallback(
    (saleId: string, isFavorite: boolean) => {
      if (isFavorite) return;
      toast("Favori supprimé", {
        duration: 5000,
        action: {
          label: "Annuler",
          onClick: () => {
            addFavoriteSale({ data: { saleId } })
              .then(() => queryClient.invalidateQueries({ queryKey: ["favorites", user?.id] }))
              .catch((error: unknown) =>
                toast.error(userMessage(error, "Impossible de rétablir ce favori.")),
              );
          },
        },
      });
    },
    [queryClient, user?.id],
  );
  const limit = data?.plan.limit ?? null;

  return (
    <PageShell
      eyebrow="Mon espace"
      title="Mes favoris"
      description={
        <>
          Retrouvez ici les ventes que vous suivez, sur tous vos appareils. L’offre Découverte
          permet 3 favoris ; l’offre Analyse n’a pas de limite.
          {limit != null && data ? (
            <>
              {" "}
              <Badge tone="gold">
                {data.favorites.length + (data.unavailableSaleIds?.length ?? 0)} sur {limit}
              </Badge>
            </>
          ) : null}
        </>
      }
      actions={
        <Link href="/sales" className={buttonClasses({ variant: "dark" })}>
          Rechercher d’autres ventes
        </Link>
      }
    >
      {query.isPending || loading ? (
        <p role="status" className="text-ink-soft">
          Chargement de vos favoris…
        </p>
      ) : null}
      {query.isError ? (
        <Card role="alert">
          <p className="font-semibold">Impossible de charger vos favoris pour le moment.</p>
          <p className="mt-1 text-sm text-ink-soft">{userMessage(query.error)}</p>
          <button
            type="button"
            onClick={() => void query.refetch()}
            className={buttonClasses({ className: "mt-3" })}
          >
            Réessayer
          </button>
        </Card>
      ) : null}
      {data?.favorites.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 py-12 text-center">
          <Heart className="size-8 text-gold-text" aria-hidden />
          <p className="font-display text-2xl font-semibold">Aucun favori pour le moment</p>
          <p className="max-w-md text-ink-soft">
            Touchez le cœur sur une annonce du catalogue pour la retrouver ici.
          </p>
          <Link href="/sales" className={buttonClasses({ variant: "primary" })}>
            Voir les ventes
          </Link>
        </Card>
      ) : null}
      {data && data.favorites.length > 0 ? (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.favorites.map(({ saleId, sale }) => (
            <li key={saleId} className="min-w-0">
              <ListingCard
                sale={sale}
                returnTo="/favoris"
                locked={false}
                analysisLocked={!isAnalysis}
                active={false}
                onHover={NOOP}
                onSelect={NOOP}
                aiReviewProjections={aiReviewBySaleId[saleId]}
                aiReviewStatus={aiReviewStatus}
                favoriteScope={user?.id ?? null}
                initialFavorite
                onFavoriteChange={handleFavoriteChange}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {data?.unavailableSaleIds?.length ? (
        <section className="mt-10">
          <h2 className="font-display text-2xl font-semibold">Annonces retirées du catalogue</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Ces ventes ne sont plus publiées. Retirez-les pour libérer une place de favori.
          </p>
          <ul className="mt-4 grid gap-3">
            {data.unavailableSaleIds.map((saleId) => (
              <li key={saleId}>
                <Card className="flex items-center justify-between gap-3 !py-3">
                  <span>Annonce retirée du catalogue</span>
                  <FavoriteButton saleId={saleId} />
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="mt-10 text-sm text-ink-soft">
        Les favoris n’envoient pas d’email. Pour être prévenu de nouvelles ventes, créez une{" "}
        <Link href="/alertes" className="font-semibold text-gold-text underline">
          alerte
        </Link>
        .
      </p>
    </PageShell>
  );
}
