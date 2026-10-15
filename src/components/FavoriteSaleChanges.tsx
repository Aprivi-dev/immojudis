"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { PremiumFeaturePreview } from "@/components/PremiumFeaturePreview";
import { Card, buttonClasses } from "@/components/ui/primitives";
import {
  getAiReviewFieldResult,
  type AiReviewProjectionReadModel,
  type AiReviewRequestStatus,
} from "@/lib/ai-review-guard";
import { fetchSaleChangeEvents } from "@/lib/client-api";
import type { FavoriteSale } from "@/lib/favorites";
import { propertyTypeLabel } from "@/lib/format";
import { saleDetailPath } from "@/lib/navigation";
import { queryKeys } from "@/lib/query-keys";
import {
  MAX_DISPLAYED_SALE_CHANGES,
  RECENT_SALE_CHANGE_DAYS,
  recentSaleChanges,
  saleChangeDetectedOn,
  type SaleChangeTopic,
} from "@/lib/sale-change-display";
import { userMessage } from "@/lib/user-messages";

type Props = {
  userId: string | null | undefined;
  favorites: readonly FavoriteSale[];
  /** The offer that includes the follow-up of the changes (`alerts.realtimeChanges`). */
  isAnalysis: boolean;
  aiReviewBySaleId?: Record<string, AiReviewProjectionReadModel[]>;
  aiReviewStatus?: AiReviewRequestStatus;
};

function LockedChanges() {
  return (
    <section className="mb-8" aria-label="Changements des ventes suivies">
      <PremiumFeaturePreview
        title="Suivez les changements de vos ventes"
        description="Avec l’offre Analyse, les changements détectés sur vos favoris (date, mise à prix, statut de la vente, documents) s’affichent ici."
        labels={["Date modifiée", "Mise à prix modifiée", "Vente retirée ou adjugée"]}
      />
    </section>
  );
}

function isForbidden(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { status?: unknown }).status === 403
  );
}

/**
 * « Changements récents » of « Mes favoris »: what the monitor detected on the followed sales
 * (date, starting price, status, documents). Included in the Analyse offer; the Découverte offer
 * only sees a locked preview, and the API is not called for it.
 */
export function FavoriteSaleChanges(props: Props) {
  return props.isAnalysis ? <AnalysisChanges {...props} /> : <LockedChanges />;
}

function AnalysisChanges({
  userId,
  favorites,
  aiReviewBySaleId = {},
  aiReviewStatus = "disabled",
}: Props) {
  const query = useQuery({
    queryKey: queryKeys.saleChangeEvents(userId),
    queryFn: () => fetchSaleChangeEvents({ limit: 100 }),
    enabled: Boolean(userId),
    staleTime: 60_000,
    // « Réessayer » is the retry: a refusal (403) is an answer, not a failure to repeat.
    retry: false,
  });

  const salesById = useMemo(
    () => new Map(favorites.map(({ saleId, sale }) => [saleId, sale])),
    [favorites],
  );
  const changes = useMemo(() => {
    if (!query.data) return [];
    // Values held back by the review of the fiche stay masked here too.
    const hiddenTopics = (saleId: string) => {
      const hidden = new Set<SaleChangeTopic>();
      const projections = aiReviewBySaleId[saleId];
      if (getAiReviewFieldResult(projections, "sale.starting_price_eur", aiReviewStatus).blocked) {
        hidden.add("price");
      }
      if (getAiReviewFieldResult(projections, "sale.sale_date", aiReviewStatus).blocked) {
        hidden.add("date");
      }
      return hidden;
    };
    return recentSaleChanges(query.data.events, new Set(salesById.keys()), { hiddenTopics });
  }, [query.data, salesById, aiReviewBySaleId, aiReviewStatus]);

  if (isForbidden(query.error)) return <LockedChanges />;

  // The values are shown once the review of the fiche answered: nothing held back may flash.
  const pending = query.isPending || aiReviewStatus === "loading";
  const shown = changes.slice(0, MAX_DISPLAYED_SALE_CHANGES);

  function saleLabel(saleId: string): string {
    const sale = salesById.get(saleId);
    if (!sale) return "Vente suivie";
    const projections = aiReviewBySaleId[saleId];
    const typeBlocked = getAiReviewFieldResult(
      projections,
      "property.property_type",
      aiReviewStatus,
    ).blocked;
    const cityBlocked = getAiReviewFieldResult(
      projections,
      "property.city",
      aiReviewStatus,
    ).blocked;
    const type = typeBlocked ? "Bien" : propertyTypeLabel(sale.property_type);
    return sale.city && !cityBlocked ? `${type} à ${sale.city}` : type;
  }

  return (
    <section className="mb-8" aria-labelledby="favorite-changes-title">
      <h2 id="favorite-changes-title" className="font-display text-2xl font-semibold">
        Changements récents
      </h2>
      <p className="mt-1 text-sm text-ink-soft">
        Ce qui a changé sur vos ventes suivies ces {RECENT_SALE_CHANGE_DAYS} derniers jours.
      </p>

      {pending ? (
        <p role="status" className="mt-4 text-ink-soft">
          Chargement des changements de vos ventes…
        </p>
      ) : null}

      {query.isError ? (
        <Card role="alert" className="mt-4">
          <p className="font-semibold">Impossible de charger les changements pour le moment.</p>
          <p className="mt-1 text-sm text-ink-soft">{userMessage(query.error)}</p>
          <button
            type="button"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            className={buttonClasses({ className: "mt-3" })}
          >
            Réessayer
          </button>
        </Card>
      ) : null}

      {!pending && query.data && shown.length === 0 ? (
        <Card className="mt-4">
          <p className="font-semibold">Aucun changement détecté</p>
          <p className="mt-1 text-sm text-ink-soft">
            Aucun changement détecté sur vos favoris ces {RECENT_SALE_CHANGE_DAYS} derniers jours
            dans les annonces que nous collectons. L’absence de changement affiché n’est pas une
            garantie : vérifiez la date et le statut auprès de l’avocat poursuivant avant de vous
            déplacer.
          </p>
        </Card>
      ) : null}

      {!pending && shown.length > 0 ? (
        <>
          <ul className="mt-4 grid gap-3">
            {shown.map(({ event, label, detail }) => {
              const detectedOn = saleChangeDetectedOn(event.detectedAt);
              return (
                <li key={event.id}>
                  <Card className="!py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <p className="font-semibold">{label}</p>
                      {detectedOn ? (
                        <time dateTime={event.detectedAt} className="text-sm text-ink-soft">
                          Détecté le {detectedOn}
                        </time>
                      ) : null}
                    </div>
                    {detail ? <p className="mt-1 text-sm">{detail}</p> : null}
                    <p className="mt-1 text-sm">
                      <Link
                        href={saleDetailPath(event.saleId)}
                        className="font-semibold text-gold-text underline underline-offset-4"
                      >
                        {saleLabel(event.saleId)}
                      </Link>
                    </p>
                  </Card>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-xs text-ink-soft">
            Changements détectés automatiquement dans les annonces collectées, à la date indiquée.
            Vérifiez toute date ou tout montant auprès de l’avocat poursuivant ou de l’annonce
            officielle.
            {changes.length > shown.length
              ? ` Les ${MAX_DISPLAYED_SALE_CHANGES} plus récents sont affichés.`
              : ""}
          </p>
        </>
      ) : null}
    </section>
  );
}
