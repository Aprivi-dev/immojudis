"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNotificationPreferencesQuery } from "@/hooks/use-notification-preferences";
import type { AiReviewProjectionReadModel } from "@/lib/ai-review-guard";
import {
  fetchDpeExplorer,
  fetchSalesAiReviewProjections,
  fetchSalesStatistics,
} from "@/lib/client-api";
import { getAlerts } from "@/lib/alert-queries";
import { getSaleById } from "@/lib/queries";
import * as queryKeys from "@/lib/query-keys";
import type { SalesSearchParams } from "@/lib/search/search-url-state";
import type { AuctionSale } from "@/lib/types";
import { userMessage } from "@/lib/user-messages";
import { buildSearchStatistics, searchStatisticsFromServer } from "./search-page-state";

/**
 * Lectures de /sales réservées aux comptes connectés : relecture IA des ventes affichées, détail
 * de la vente choisie sur la carte, préférence du récapitulatif par e-mail et alertes enregistrées
 * (décompte de l'alerte gratuite). Aucune ne part sans compte (`userId` nul) : mêmes clés et mêmes
 * conditions que lorsqu'elles étaient écrites dans `SearchPage`.
 *
 * Import statique et non `next/dynamic` : mesuré le 08/11/2026, le chargement à la demande de ces
 * lectures ne retirait que 144 octets à /sales mais ajoutait 33 669 octets au JavaScript client
 * total (Turbopack redécoupe alors les chunks partagés).
 */
export function useSearchAccountData({
  userId,
  authLoading,
  aiReviewSaleIds,
  aiReviewEnabled,
  accessScope,
  discovery,
  selectedMapSaleId,
  selectedMapSaleEnabled,
  savedAlertsEnabled,
}: {
  userId: string | null;
  authLoading: boolean;
  aiReviewSaleIds: readonly string[];
  /** Offre Analyse, liste connectée affichée : la liste publique et Découverte ne sont pas relues. */
  aiReviewEnabled: boolean;
  accessScope: string | null;
  discovery: boolean;
  selectedMapSaleId: string | null;
  /** Catalogue prêt et carte visible : survol, aperçu et carte masquée ne lisent rien. */
  selectedMapSaleEnabled: boolean;
  /** Fenêtre d'alerte ouverte par un compte sans l'offre Analyse. */
  savedAlertsEnabled: boolean;
}) {
  const signedIn = Boolean(userId) && !authLoading;
  const { data: aiReviewData, isError: aiReviewError } = useQuery({
    queryKey: queryKeys.salesAiReview(userId ?? "anonymous", aiReviewSaleIds),
    queryFn: () => fetchSalesAiReviewProjections(aiReviewSaleIds),
    // Discovery rows already use the public redacted view. The AI review
    // endpoint reads Analyse-only projections and must not blank valid public
    // city, price or date values for free users.
    enabled: signedIn && aiReviewEnabled && aiReviewSaleIds.length > 0,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const aiReviewBySaleId = useMemo(() => {
    const grouped: Record<string, AiReviewProjectionReadModel[]> = {};
    for (const projection of aiReviewData?.projections ?? []) {
      if (!projection.auction_sale_id) continue;
      (grouped[projection.auction_sale_id] ??= []).push(projection);
    }
    return grouped;
  }, [aiReviewData]);

  // The map projection is intentionally lightweight. Fetch the complete row
  // only after an authenticated user selects a sale that is actually present
  // in the current map result set. Hovering, preview mode, and a hidden map
  // never trigger this request.
  const { data: selectedMapSaleDetail, isFetching: selectedMapSaleDetailLoading } = useQuery({
    queryKey: queryKeys.salesMapDetail(accessScope, selectedMapSaleId),
    queryFn: () => getSaleById(selectedMapSaleId!, { discovery }),
    enabled: Boolean(selectedMapSaleEnabled && userId && selectedMapSaleId && accessScope),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const { data: notificationPreferences } = useNotificationPreferencesQuery(userId, {
    enabled: signedIn,
  });

  // Alerte gratuite : l'usage (« 0/1 utilisée ») n'est lu qu'à l'ouverture de la fenêtre de création,
  // pour un compte qui n'a pas l'offre Analyse. Même clé que la page « Mes alertes ».
  const { data: savedAlerts } = useQuery({
    queryKey: queryKeys.savedAlerts(userId ?? "anonymous"),
    queryFn: () => getAlerts(userId!),
    enabled: savedAlertsEnabled && signedIn,
    staleTime: 30_000,
    retry: false,
  });

  return {
    aiReviewBySaleId,
    aiReviewReady: Boolean(aiReviewData),
    aiReviewError,
    selectedMapSaleDetail,
    selectedMapSaleDetailLoading,
    emailRecapEnabled: notificationPreferences?.preferences.alertEmailEnabled === true,
    savedAlerts,
  };
}

/**
 * « Repères sur cette recherche » : repères calculés par le serveur (volet ouvert, droits inclus) et
 * explorateur DPE (demandé, droits inclus). Sans repères du serveur, ceux de la page affichée.
 */
export function useSearchStatisticsData({
  search,
  searchKeySignature,
  sales,
  statisticsOpen,
  statisticsLocked,
  dpeExplorerOpen,
  dpeLocked,
  signedIn,
  initialLoading,
}: {
  search: SalesSearchParams;
  searchKeySignature: string;
  sales: AuctionSale[];
  statisticsOpen: boolean;
  statisticsLocked: boolean;
  dpeExplorerOpen: boolean;
  dpeLocked: boolean;
  /** Compte reconnu, session restaurée. */
  signedIn: boolean;
  initialLoading: boolean;
}) {
  const localStatistics = useMemo(() => buildSearchStatistics(sales), [sales]);
  const { data: salesStatisticsData, isFetching: salesStatisticsLoading } = useQuery({
    queryKey: queryKeys.salesStatistics(searchKeySignature),
    queryFn: () => fetchSalesStatistics({ search }),
    enabled: statisticsOpen && !statisticsLocked && signedIn,
    retry: false,
    staleTime: 2 * 60_000,
  });
  const statistics = useMemo(
    () =>
      salesStatisticsData
        ? searchStatisticsFromServer(salesStatisticsData.summary)
        : localStatistics,
    [localStatistics, salesStatisticsData],
  );
  const {
    data: dpeExplorer,
    error: dpeExplorerError,
    isFetching: dpeExplorerLoading,
    refetch: refetchDpeExplorer,
  } = useQuery({
    queryKey: queryKeys.dpeExplorer(searchKeySignature),
    queryFn: () =>
      fetchDpeExplorer({
        department: search.department,
        city: search.city,
        propertyType: search.homeTypes?.length === 1 ? search.homeTypes[0] : undefined,
        dpeClasses: search.dpeClasses,
        includeMap: true,
        limit: 80,
      }),
    enabled: dpeExplorerOpen && !dpeLocked,
    retry: false,
    staleTime: 5 * 60_000,
  });

  return {
    statistics,
    loading:
      initialLoading || (!statisticsLocked && salesStatisticsLoading && !salesStatisticsData),
    dpeExplorer,
    dpeExplorerError: dpeExplorerError ? userMessage(dpeExplorerError) : null,
    dpeExplorerLoading,
    refetchDpeExplorer,
  };
}
