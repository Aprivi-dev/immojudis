import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getAiReviewFieldResult,
  type AiReviewProjectionReadModel,
  type AiReviewRequestStatus,
} from "@/lib/ai-review-guard";
import {
  fetchAlertNotifications,
  fetchFavoriteSales,
  fetchSaleChangeEvents,
} from "@/lib/client-api";
import { favoriteDossierStatusLabel } from "@/lib/favorite-dossier-shared";
import type { FavoriteSale } from "@/lib/favorites";
import * as queryKeys from "@/lib/query-keys";
import { parisDateKey } from "@/lib/sale-countdown";
import {
  recentSaleChanges,
  type DescribedSaleChange,
  type SaleChangeTopic,
} from "@/lib/sale-change-display";

/**
 * Nombre de notifications lues pour la case « nouvelles ventes de vos alertes » : la même lecture
 * que la cloche de l'en-tête (même clé, même taille), donc aucun appel de plus quand elle est déjà
 * faite. Au-delà, la case dit « 12+ ».
 */
const FOLLOWED_ALERT_NOTIFICATION_LIMIT = 12;

/** « Mon dossier » d'une vente suivie, tel que la carte le montre. */
export type FollowedSaleDossier = {
  /** Libellé du statut personnel (« Analyse en cours »), `null` s'il n'est pas choisi. */
  statusLabel: string | null;
  bidCeilingEur: number | null;
};

type FollowedAlertNews = {
  /** Ventes distinctes des notifications non lues. */
  saleCount: number;
  /** Alertes distinctes dont viennent ces ventes. */
  alertCount: number;
  /** Toutes les notifications lues sont non lues : il y en a peut-être davantage. */
  capped: boolean;
};

export type FollowedSales = {
  /** Ventes suivies (favoris), `null` tant que la liste n'est pas lue ou en cas d'échec. */
  favorites: readonly FavoriteSale[] | null;
  /** Ventes suivies dont la vente a lieu aujourd'hui (jour de Paris). */
  todaySales: readonly FavoriteSale[];
  dossierBySaleId: ReadonlyMap<string, FollowedSaleDossier>;
  /** Changements récents des ventes suivies (30 jours), `null` tant qu'ils ne sont pas lus. */
  changes: readonly DescribedSaleChange[] | null;
  /** Dernier changement de chaque vente suivie. */
  lastChangeBySaleId: ReadonlyMap<string, DescribedSaleChange>;
  /** Nouvelles ventes des alertes (notifications non lues), `null` tant qu'elles ne sont pas lues. */
  alertNews: FollowedAlertNews | null;
};

const NO_FAVORITES: readonly FavoriteSale[] = [];
const NO_DOSSIERS: ReadonlyMap<string, FollowedSaleDossier> = new Map();
const NO_CHANGES: ReadonlyMap<string, DescribedSaleChange> = new Map();

/**
 * Le suivi d'un abonné de l'offre Analyse sur /sales : ses ventes suivies et leur dossier (statut,
 * plafond), leurs derniers changements et les nouvelles ventes de ses alertes. Trois lectures qui
 * existent déjà ailleurs, sous les mêmes clés : « Mes favoris » (`favorites`), « Changements
 * récents » (`saleChangeEvents`) et la cloche de l'en-tête (`alertNotifications`). Rien n'est lu
 * pour un visiteur ni pour l'offre Découverte (`enabled` faux) : le suivi des changements est
 * réservé à l'offre Analyse.
 *
 * Une valeur retenue par la relecture de la fiche (prix, date) reste masquée dans le détail d'un
 * changement, comme sur « Mes favoris » ; tant que la relecture n'a pas répondu, aucun changement
 * n'est donné (rien de retenu ne doit apparaître puis disparaître).
 */
export function useFollowedSales({
  userId,
  enabled,
  today,
  aiReviewBySaleId,
  aiReviewStatus,
}: {
  userId: string | null;
  enabled: boolean;
  /** Jour de Paris (AAAA-MM-JJ). */
  today: string;
  aiReviewBySaleId?: Readonly<Record<string, readonly AiReviewProjectionReadModel[]>>;
  aiReviewStatus: AiReviewRequestStatus;
}): FollowedSales {
  const active = enabled && Boolean(userId);
  const favoritesQuery = useQuery({
    queryKey: queryKeys.favorites(userId),
    queryFn: fetchFavoriteSales,
    enabled: active,
    staleTime: 60_000,
    retry: false,
  });
  const changesQuery = useQuery({
    queryKey: queryKeys.saleChangeEvents(userId),
    queryFn: () => fetchSaleChangeEvents({ limit: 100 }),
    enabled: active,
    staleTime: 60_000,
    retry: false,
  });
  const alertsQuery = useQuery({
    queryKey: queryKeys.alertNotifications(userId ?? "anonymous"),
    queryFn: () => fetchAlertNotifications({ limit: FOLLOWED_ALERT_NOTIFICATION_LIMIT }),
    enabled: active,
    staleTime: 60_000,
    retry: false,
  });

  const favorites = active ? (favoritesQuery.data?.favorites ?? null) : null;

  const dossierBySaleId = useMemo(() => {
    if (!favorites?.length) return NO_DOSSIERS;
    return new Map(
      favorites.map((favorite) => [
        favorite.saleId,
        {
          statusLabel: favorite.personalStatus
            ? favoriteDossierStatusLabel(favorite.personalStatus)
            : null,
          bidCeilingEur: favorite.bidCeilingEur,
        },
      ]),
    );
  }, [favorites]);

  const todaySales = useMemo(() => {
    if (!favorites?.length) return NO_FAVORITES;
    return favorites.filter(({ sale }) => {
      const date = sale.sale_date ? new Date(sale.sale_date) : null;
      return date != null && Number.isFinite(date.getTime()) && parisDateKey(date) === today;
    });
  }, [favorites, today]);

  const changes = useMemo(() => {
    if (!active || !changesQuery.data || !favorites || aiReviewStatus === "loading") return null;
    const hiddenTopics = (saleId: string) => {
      const hidden = new Set<SaleChangeTopic>();
      const projections = aiReviewBySaleId?.[saleId];
      if (getAiReviewFieldResult(projections, "sale.starting_price_eur", aiReviewStatus).blocked) {
        hidden.add("price");
      }
      if (getAiReviewFieldResult(projections, "sale.sale_date", aiReviewStatus).blocked) {
        hidden.add("date");
      }
      return hidden;
    };
    return recentSaleChanges(
      changesQuery.data.events,
      new Set(favorites.map(({ saleId }) => saleId)),
      { hiddenTopics },
    );
  }, [active, aiReviewBySaleId, aiReviewStatus, changesQuery.data, favorites]);

  const lastChangeBySaleId = useMemo(() => {
    if (!changes?.length) return NO_CHANGES;
    const latest = new Map<string, DescribedSaleChange>();
    // `recentSaleChanges` rend les plus récents d'abord : le premier de chaque vente est le dernier.
    for (const change of changes) {
      if (!latest.has(change.event.saleId)) latest.set(change.event.saleId, change);
    }
    return latest;
  }, [changes]);

  const alertNews = useMemo(() => {
    const notifications = active ? alertsQuery.data?.notifications : undefined;
    if (!notifications) return null;
    const unread = notifications.filter(
      (notification) => !notification.readAt && !notification.dismissedAt,
    );
    return {
      saleCount: new Set(unread.map(({ saleId }) => saleId)).size,
      alertCount: new Set(unread.map(({ alertId }) => alertId)).size,
      capped: unread.length >= FOLLOWED_ALERT_NOTIFICATION_LIMIT,
    };
  }, [active, alertsQuery.data]);

  return { favorites, todaySales, dossierBySaleId, changes, lastChangeBySaleId, alertNews };
}
