import { SaleProcedureBadge } from "@/components/SaleProcedurePanel";
import { SaleCountdown } from "@/components/SaleCountdown";
import type * as React from "react";
import { memo, useEffect, useMemo, useState } from "react";
import { getDisplaySurface } from "@/lib/surface";
import { SaleVisual } from "@/components/SaleVisual";
import { saleDisplayTitle } from "@/lib/sale-title";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import CalendarDays from "lucide-react/dist/esm/icons/calendar-days.js";
import Heart from "lucide-react/dist/esm/icons/heart.js";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import Share2 from "lucide-react/dist/esm/icons/share-2.js";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { useViewedSales } from "@/hooks/use-viewed-sales";
import { supabase } from "@/integrations/supabase/client";
import { Link, useNavigate } from "@/lib/router-compat";
import {
  addFavoriteSale as addFavoriteSaleRequest,
  removeFavoriteSale as removeFavoriteSaleRequest,
} from "@/lib/client-api";
import { formatDate, formatPrice, occupancyLabel, propertyTypeLabel } from "@/lib/format";
import type { AuctionSale } from "@/lib/types";
import { MAX_COMPARED_SALES } from "@/lib/search/sale-comparison";
import { ErrorState, ListingCardSkeleton, NoResultsState } from "./SearchFilters";
import { AiReviewField } from "@/components/sale-detail/AiReviewField";
import {
  AI_REVIEW_SURFACE_FIELD_KEYS,
  firstBlockedAiReviewField,
  getAiReviewFieldResult,
  type AiReviewProjectionReadModel,
  type AiReviewRequestStatus,
} from "@/lib/ai-review-guard";
export function SearchResultsList({
  sales,
  returnTo,
  locked,
  analysisLocked,
  isLoading,
  error,
  selectedSaleId,
  hoveredSaleId,
  onHover,
  onSelect,
  comparedSaleIds,
  comparisonDisabled,
  onToggleComparison,
  aiReviewBySaleId,
  aiReviewStatus = "disabled",
}: {
  sales: AuctionSale[];
  returnTo: string;
  locked: boolean;
  analysisLocked: boolean;
  isLoading: boolean;
  error: Error | null;
  selectedSaleId: string | null;
  hoveredSaleId: string | null;
  onHover: (saleId: string | null) => void;
  onSelect: (saleId: string | null) => void;
  comparedSaleIds: string[];
  comparisonDisabled: boolean;
  onToggleComparison: (sale: AuctionSale) => void;
  aiReviewBySaleId?: Readonly<Record<string, readonly AiReviewProjectionReadModel[]>>;
  aiReviewStatus?: AiReviewRequestStatus;
}) {
  const { user, loading: authLoading } = useAuth();
  const saleIds = useMemo(() => sales.map(({ id }) => id), [sales]);
  const favoriteQueryIds = useMemo(() => [...saleIds].sort(), [saleIds]);
  const favoriteQuery = useQuery({
    queryKey: ["search-favorite-status", user?.id ?? null, favoriteQueryIds],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_favorites")
        .select("sale_id")
        .eq("user_id", user!.id)
        .in("sale_id", saleIds);
      if (error) throw error;
      return data.map(({ sale_id }) => sale_id);
    },
    enabled: Boolean(user && !authLoading && !isLoading && !locked && saleIds.length),
    staleTime: 60_000,
    retry: false,
  });
  const favoriteIds = useMemo(() => new Set(favoriteQuery.data ?? []), [favoriteQuery.data]);
  const favoriteScope = user?.id ?? null;

  return (
    <div className="px-3 pb-24 pt-3 sm:px-5 lg:pb-6">
      {error ? <ErrorState error={error} /> : null}

      {!isLoading && sales.length === 0 && !error ? <NoResultsState /> : null}

      <div className="grid grid-cols-1 gap-3">
        {isLoading
          ? Array.from({ length: 8 }).map((_, index) => <ListingCardSkeleton key={index} />)
          : sales.map((sale) => (
              <ListingCard
                key={sale.id}
                sale={sale}
                returnTo={returnTo}
                locked={locked}
                analysisLocked={analysisLocked}
                active={selectedSaleId === sale.id || hoveredSaleId === sale.id}
                onHover={onHover}
                onSelect={onSelect}
                comparisonSelected={comparedSaleIds.includes(sale.id)}
                comparisonDisabled={
                  comparisonDisabled ||
                  (comparedSaleIds.length >= MAX_COMPARED_SALES &&
                    !comparedSaleIds.includes(sale.id))
                }
                onToggleComparison={onToggleComparison}
                aiReviewProjections={aiReviewBySaleId?.[sale.id]}
                aiReviewStatus={aiReviewStatus}
                favoriteScope={favoriteScope}
                initialFavorite={favoriteIds.has(sale.id)}
              />
            ))}
      </div>
    </div>
  );
}
export const ListingCard = memo(function ListingCard({
  sale,
  returnTo,
  locked,
  analysisLocked,
  active,
  onHover,
  onSelect,
  comparisonSelected = false,
  comparisonDisabled = false,
  onToggleComparison,
  aiReviewProjections,
  aiReviewStatus = "ready",
  favoriteScope = null,
  initialFavorite = false,
}: {
  sale: AuctionSale;
  returnTo: string;
  locked: boolean;
  analysisLocked: boolean;
  active: boolean;
  onHover: (saleId: string | null) => void;
  onSelect: (saleId: string | null) => void;
  comparisonSelected?: boolean;
  comparisonDisabled?: boolean;
  onToggleComparison?: (sale: AuctionSale) => void;
  aiReviewProjections?: readonly AiReviewProjectionReadModel[] | null;
  aiReviewStatus?: AiReviewRequestStatus;
  favoriteScope?: string | null;
  initialFavorite?: boolean;
}) {
  const displaySurface = getDisplaySurface(sale);
  const { isViewed } = useViewedSales();
  const premiumLocked = locked || analysisLocked;
  const viewed = !locked && isViewed(sale.id);
  const propertyTypeReview = getAiReviewFieldResult(
    aiReviewProjections,
    "property.property_type",
    aiReviewStatus,
  );
  const cityReview = getAiReviewFieldResult(aiReviewProjections, "property.city", aiReviewStatus);
  const roomsReview = getAiReviewFieldResult(
    aiReviewProjections,
    "property.rooms_count",
    aiReviewStatus,
  );
  const surfaceReviewField = firstBlockedAiReviewField(
    aiReviewProjections,
    AI_REVIEW_SURFACE_FIELD_KEYS,
    aiReviewStatus,
  );
  const guardedPropertyType = propertyTypeReview.blocked
    ? "À confirmer"
    : propertyTypeLabel(sale.property_type);
  const guardedCity = cityReview.blocked ? null : sale.city;
  const title = locked
    ? `${guardedPropertyType}${guardedCity ? ` à ${guardedCity}` : ""}`
    : propertyTypeReview.blocked || cityReview.blocked
      ? `${guardedPropertyType}${guardedCity ? ` à ${guardedCity}` : ""}`
      : saleDisplayTitle(sale);
  const beds = roomsReview.blocked ? null : (sale.bedrooms_count ?? sale.rooms_count);

  return (
    <article
      onMouseEnter={() => onHover(sale.id)}
      onMouseLeave={() => onHover(null)}
      onFocusCapture={() => onHover(sale.id)}
      onBlurCapture={() => onHover(null)}
      className={`group relative grid grid-cols-[100px_minmax(0,1fr)] gap-3 rounded-lg border bg-white p-3 transition-colors sm:grid-cols-[minmax(150px,30%)_minmax(0,1fr)] sm:gap-5 ${active ? "border-[#c98d45] ring-1 ring-[#c98d45]" : "border-[#dce3eb] hover:border-[#c98d45]"}`}
    >
      <Link
        id={`sale-card-${sale.id}`}
        to="/sales/$id"
        params={{ id: sale.id }}
        search={{ from: returnTo }}
        onClick={() => onSelect(sale.id)}
        aria-label={`Voir ${title}`}
        className="absolute inset-0 z-10 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#9c642b]"
      />
      <div className="relative min-h-32 overflow-hidden rounded-md bg-[#edf2f5] sm:min-h-40">
        <ListingImage sale={sale} locked={false} title={title} />
        {viewed && (
          <span className="absolute left-2 top-2 rounded bg-white px-2 py-1 text-xs">Vu</span>
        )}
      </div>
      <div className="min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="font-display text-xl font-semibold leading-tight sm:text-2xl">
              <AiReviewField
                fieldKey="property.city"
                projections={aiReviewProjections}
                reviewStatus={aiReviewStatus}
                fallback="Localisation à préciser"
                sourceName={sale.source_name}
                sourceUrl={sale.source_url}
                showSourceLink={false}
              >
                {[sale.city, sale.department].filter(Boolean).join(" · ") ||
                  "Localisation à préciser"}
              </AiReviewField>
            </h3>
            <p className="mt-1 text-sm text-[#526170]">
              <AiReviewField
                fieldKey="property.property_type"
                projections={aiReviewProjections}
                reviewStatus={aiReviewStatus}
                sourceName={sale.source_name}
                sourceUrl={sale.source_url}
                showSourceLink={false}
              >
                {propertyTypeLabel(sale.property_type)}
              </AiReviewField>{" "}
              ·{" "}
              {surfaceReviewField ? (
                <AiReviewField
                  fieldKey={surfaceReviewField}
                  projections={aiReviewProjections}
                  reviewStatus={aiReviewStatus}
                  fallback="Surface à confirmer"
                  sourceName={sale.source_name}
                  sourceUrl={sale.source_url}
                  showSourceLink={false}
                >
                  {displaySurface.value != null ? displaySurface.label : "Surface n.c."}
                </AiReviewField>
              ) : displaySurface.value != null ? (
                displaySurface.label
              ) : (
                "Surface n.c."
              )}
              {beds != null ? ` · ${beds} ch.` : ""}
            </p>
          </div>
          <CompactFavoriteButton
            key={`${sale.id}:${favoriteScope ?? "anonymous"}`}
            saleId={sale.id}
            // Discovery can save up to three favourites. Keep the favourite
            // control available while the rest of the card stays analysis-gated.
            locked={locked}
            favoriteScope={favoriteScope}
            initialFavorite={initialFavorite}
          />
        </div>
        <p className="mt-2 text-xl font-bold leading-tight text-[#9c642b] sm:text-2xl">
          <AiReviewField
            fieldKey="sale.starting_price_eur"
            projections={aiReviewProjections}
            reviewStatus={aiReviewStatus}
            sourceName={sale.source_name}
            sourceUrl={sale.source_url}
            showSourceLink={false}
          >
            {formatPrice(sale.starting_price_eur)}
          </AiReviewField>
        </p>
        <p className="text-xs text-[#526170]">Mise à prix</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#526170]">
          <span className="inline-flex items-center gap-1">
            <CalendarDays className="h-3.5 w-3.5" />
            <AiReviewField
              fieldKey="sale.sale_date"
              projections={aiReviewProjections}
              reviewStatus={aiReviewStatus}
              sourceName={sale.source_name}
              sourceUrl={sale.source_url}
              showSourceLink={false}
            >
              {formatDate(sale.sale_date)}
            </AiReviewField>
          </span>
          <SaleCountdown sale={sale} precisionUnknown={locked} variant="chip" />
          <SaleProcedureBadge sale={sale} />
          {!premiumLocked && sale.occupancy_status && (
            <span className="rounded bg-[#f0f5f3] px-2 py-1">
              <AiReviewField
                fieldKey="property.occupancy_status"
                projections={aiReviewProjections}
                reviewStatus={aiReviewStatus}
                sourceName={sale.source_name}
                sourceUrl={sale.source_url}
                showSourceLink={false}
              >
                {occupancyLabel(sale.occupancy_status)}
              </AiReviewField>
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-1">
          <span className="text-xs text-[#526170]">
            {locked
              ? "Fiche complète avec un compte gratuit"
              : analysisLocked
                ? "Analyse détaillée avec l’offre Analyse"
                : "Voir le détail"}
          </span>
          <div className="flex items-center">
            <ShareButton sale={sale} title={title} />
            {onToggleComparison && (
              <button
                type="button"
                aria-label={`Comparer ${title}`}
                aria-pressed={comparisonSelected}
                disabled={comparisonDisabled}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onToggleComparison(sale);
                }}
                className="relative z-20 min-h-11 rounded px-2 text-xs font-medium hover:bg-[#eef3f8] focus-visible:outline-2 focus-visible:outline-[#9c642b] disabled:opacity-50"
              >
                {comparisonSelected ? "Sélectionné ✓" : "Comparer"}
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
});

export function ListingImage({
  sale,
  locked,
  title,
}: {
  sale: AuctionSale;
  locked: boolean;
  title: string;
}) {
  return (
    <SaleVisual
      sale={sale}
      title={title}
      locked={locked}
      preferPhoto
      mapWidth={512}
      mapHeight={384}
    />
  );
}

export function ListingBadge({
  children,
  tone,
  icon: Icon,
}: {
  children: React.ReactNode;
  tone: "navy" | "teal" | "cream";
  icon?: React.ComponentType<{ className?: string }>;
}) {
  const toneClass =
    tone === "teal"
      ? "bg-[#0f766e] text-white"
      : tone === "cream"
        ? "bg-[#fffaf2] text-[#8a5b24]"
        : "bg-[#132238] text-white";

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-extrabold uppercase tracking-normal shadow-sm ${toneClass}`}
    >
      {Icon ? <Icon className="h-3 w-3" /> : null}
      {children}
    </span>
  );
}

export function Metric({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 rounded-md bg-[#f3f7fa] px-2 py-1">
      <Icon className="h-3.5 w-3.5 shrink-0 text-[#0f766e]" />
      <span className="truncate">{label}</span>
    </span>
  );
}

export function ListingSignal({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <span className="min-w-0 border-r border-[#e2e8ee] px-2 py-2 last:border-r-0">
      <span className="block text-[9px] font-bold uppercase tracking-[0.08em] text-[#8b949e]">
        {label}
      </span>
      <span className={`mt-0.5 block truncate font-extrabold ${tone}`}>{value}</span>
    </span>
  );
}

export function ShareButton({ sale, title }: { sale: AuctionSale; title: string }) {
  async function share(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();

    const url =
      typeof window !== "undefined"
        ? `${window.location.origin}/sales/${sale.id}`
        : `/sales/${sale.id}`;

    try {
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share({ title, url });
      } else if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        toast.success("Lien copié");
      }
    } catch {
      toast.error("Partage impossible");
    }
  }

  return (
    <button
      type="button"
      onClick={share}
      className="relative z-20 grid h-8 w-8 cursor-pointer place-items-center rounded-full text-[#132238] transition-colors hover:bg-[#eef2f4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e]"
      aria-label="Partager cette vente"
    >
      <Share2 className="h-5 w-5" />
    </button>
  );
}

export function CompactFavoriteButton({
  saleId,
  locked,
  favoriteScope,
  initialFavorite = false,
}: {
  saleId: string;
  locked: boolean;
  favoriteScope?: string | null;
  initialFavorite?: boolean;
}) {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isFavorite, setIsFavorite] = useState(initialFavorite);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setIsFavorite(initialFavorite);
  }, [favoriteScope, initialFavorite, saleId]);

  async function toggle(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();

    if (loading) return;
    if (!user) {
      const redirect =
        typeof window !== "undefined"
          ? `${window.location.pathname}${window.location.search}`
          : "/sales";
      navigate({ to: "/login", search: { redirect } });
      return;
    }
    if (locked) return;

    setBusy(true);
    const searchFavoriteQueryKey = ["search-favorite-status", user.id] as const;
    try {
      await queryClient.cancelQueries({ queryKey: searchFavoriteQueryKey });
      if (isFavorite) {
        await removeFavoriteSaleRequest({ saleId });
        setIsFavorite(false);
      } else {
        await addFavoriteSaleRequest({ data: { saleId } });
        setIsFavorite(true);
      }
      queryClient.setQueriesData<string[] | undefined>(
        { queryKey: ["search-favorite-status", user.id] },
        (favoriteSaleIds) => {
          const nextFavoriteSaleIds = new Set(favoriteSaleIds ?? []);
          if (isFavorite) nextFavoriteSaleIds.delete(saleId);
          else nextFavoriteSaleIds.add(saleId);
          return [...nextFavoriteSaleIds];
        },
      );
      queryClient.invalidateQueries({ queryKey: ["favorites", user.id] });
      await queryClient.invalidateQueries({ queryKey: searchFavoriteQueryKey });
    } catch (error) {
      void queryClient.invalidateQueries({ queryKey: searchFavoriteQueryKey });
      toast.error(error instanceof Error ? error.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-pressed={locked ? undefined : isFavorite}
      aria-label={
        locked
          ? "Connectez-vous pour enregistrer jusqu'à trois favoris gratuits"
          : isFavorite
            ? "Ne plus suivre cette vente"
            : "Suivre cette vente"
      }
      className="relative z-20 grid h-8 w-8 cursor-pointer place-items-center rounded-full text-[#132238] transition-colors hover:bg-[#eef2f4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {locked ? (
        <LockKeyhole className="h-4 w-4 text-[#8a5b24]" />
      ) : (
        <Heart className={`h-5 w-5 ${isFavorite ? "fill-[#c2410c] text-[#c2410c]" : ""}`} />
      )}
    </button>
  );
}
