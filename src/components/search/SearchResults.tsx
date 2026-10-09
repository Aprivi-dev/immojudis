import { SaleProcedureBadge } from "@/components/SaleProcedureBadge";
import { SaleCountdown } from "@/components/SaleCountdown";
import type * as React from "react";
import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { getDisplaySurface } from "@/lib/surface";
import { SaleVisual } from "@/components/SaleVisual";
import { ListingPhoto } from "@/components/ListingPhoto";
import { saleDisplayTitle } from "@/lib/sale-title";
import { propertyImages, shouldRejectRenderedPropertyImage } from "@/lib/sale-media";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import CalendarDays from "lucide-react/dist/esm/icons/calendar-days.js";
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left.js";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
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
import { ErrorState, NoResultsState } from "./SearchFilters";
import { SearchResultsSkeleton } from "./SearchResultsSkeleton";
import styles from "./SearchResults.module.css";
import { AiReviewField } from "@/components/sale-detail/AiReviewField";
import {
  AI_REVIEW_SURFACE_FIELD_KEYS,
  firstBlockedAiReviewField,
  getAiReviewFieldResult,
  type AiReviewProjectionReadModel,
  type AiReviewRequestStatus,
} from "@/lib/ai-review-guard";
import { userMessage } from "@/lib/user-messages";
export function SearchResultsList({
  sales,
  sponsoredPlacement,
  returnTo,
  locked,
  analysisLocked,
  isLoading,
  error,
  onRetry,
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
  sponsoredPlacement?: React.ReactNode;
  returnTo: string;
  locked: boolean;
  analysisLocked: boolean;
  isLoading: boolean;
  error: Error | null;
  onRetry?: () => void;
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
      {error ? <ErrorState error={error} onRetry={onRetry} /> : null}

      {!isLoading && sales.length === 0 && !error ? <NoResultsState /> : null}

      <div className="grid grid-cols-1 gap-4 min-[600px]:grid-cols-2">
        {isLoading
          ? Array.from({ length: 8 }).map((_, index) => <SearchResultsSkeleton key={index} />)
          : sales.map((sale, index) => (
              <Fragment key={sale.id}>
                {index === 4 && sponsoredPlacement ? (
                  <div className="min-[600px]:col-span-2">{sponsoredPlacement}</div>
                ) : null}
                <ListingCard
                  sale={sale}
                  returnTo={returnTo}
                  eagerImage={index < 2}
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
              </Fragment>
            ))}
        {sales.length === 4 && sponsoredPlacement ? (
          <div className="min-[600px]:col-span-2">{sponsoredPlacement}</div>
        ) : null}
      </div>
    </div>
  );
}
export const ListingCard = memo(function ListingCard({
  sale,
  returnTo,
  eagerImage = false,
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
  onFavoriteChange,
}: {
  sale: AuctionSale;
  returnTo: string;
  eagerImage?: boolean;
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
  /** Appelé après l'ajout ou le retrait réussi d'un favori depuis la carte. */
  onFavoriteChange?: (saleId: string, isFavorite: boolean) => void;
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
  const roomSummary = roomsReview.blocked
    ? null
    : sale.rooms_count != null
      ? `${sale.rooms_count} pièce${sale.rooms_count === 1 ? "" : "s"}`
      : sale.bedrooms_count != null
        ? `${sale.bedrooms_count} ch.`
        : null;

  return (
    <article
      onMouseEnter={() => onHover(sale.id)}
      onMouseLeave={() => onHover(null)}
      onFocusCapture={() => onHover(sale.id)}
      onBlurCapture={() => onHover(null)}
      className={`group relative overflow-hidden rounded-xl border bg-white shadow-[0_1px_2px_rgba(19,34,56,0.05)] transition-[border-color,box-shadow] ${active ? "border-gold ring-1 ring-gold" : "border-line-soft hover:border-gold hover:shadow-[0_8px_24px_rgba(19,34,56,0.09)]"}`}
    >
      <Link
        id={`sale-card-${sale.id}`}
        to="/sales/$id"
        params={{ id: sale.id }}
        search={{ from: returnTo }}
        prefetch={false}
        onClick={() => onSelect(sale.id)}
        aria-label={`Voir ${title}`}
        className="absolute inset-0 z-10 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
      />
      <div className="relative aspect-[4/3] overflow-hidden bg-surface-tint">
        <ListingImage
          sale={sale}
          locked={false}
          eager={eagerImage}
          title={title}
          returnTo={returnTo}
          onSelect={onSelect}
        />
        {viewed && (
          <span className="absolute left-3 top-3 z-20 rounded-md bg-white/95 px-2 py-1 text-[11px] font-bold text-brand-navy shadow-sm">
            Vu
          </span>
        )}
      </div>
      <div className="relative min-w-0 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="font-display text-lg font-semibold leading-tight sm:text-xl">
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
            <p className="mt-1 text-sm leading-5 text-ink-soft">
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
              {roomSummary ? ` · ${roomSummary}` : ""}
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
            onChange={onFavoriteChange}
          />
        </div>
        <p className="mt-3 text-2xl font-bold leading-none text-gold-text sm:text-[1.7rem]">
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
        <p className="text-xs text-ink-soft">Mise à prix</p>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-soft">
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
            <span className="rounded bg-success-tint px-2 py-1">
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
        <div className="mt-3 flex flex-wrap items-center justify-between gap-1 border-t border-surface-tint pt-3">
          <span className="text-xs text-ink-soft">
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
                className="relative z-20 min-h-11 rounded px-2 text-xs font-medium hover:bg-surface-tint focus-visible:outline-2 focus-visible:outline-gold-soft disabled:opacity-50"
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
  eager = false,
  title,
  returnTo,
  onSelect,
}: {
  sale: AuctionSale;
  locked: boolean;
  eager?: boolean;
  title: string;
  returnTo?: string;
  onSelect?: (saleId: string) => void;
}) {
  return (
    <ListingMediaCarousel
      sale={sale}
      locked={locked}
      eager={eager}
      title={title}
      returnTo={returnTo}
      onSelect={onSelect}
    />
  );
}

type PointerGesture = {
  id: number;
  x: number;
  y: number;
};

/**
 * Keeps the card's primary navigation on the image while making the image
 * rail itself safe to operate. Arrow buttons and a horizontal swipe never
 * bubble to the full-card link, so changing the photo cannot open the detail.
 */
export function ListingMediaCarousel({
  sale,
  locked,
  eager = false,
  title,
  returnTo,
  onSelect,
}: {
  sale: AuctionSale;
  locked: boolean;
  eager?: boolean;
  title: string;
  returnTo?: string;
  onSelect?: (saleId: string) => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [failedPhotoUrls, setFailedPhotoUrls] = useState<Set<string>>(() => new Set());
  const gestureRef = useRef<PointerGesture | null>(null);
  const suppressLinkClickRef = useRef(false);
  const photos = useMemo(
    () => propertyImages(sale.media).filter(({ url }) => !failedPhotoUrls.has(url)),
    [failedPhotoUrls, sale.media],
  );
  const photo = photos[Math.min(activeIndex, Math.max(photos.length - 1, 0))];

  useEffect(() => {
    setActiveIndex(0);
    setFailedPhotoUrls(new Set());
  }, [sale.id]);

  useEffect(() => {
    if (photos.length > 0 && activeIndex >= photos.length) {
      setActiveIndex(photos.length - 1);
    }
  }, [activeIndex, photos.length]);

  const selectPhoto = (nextIndex: number) => {
    if (photos.length < 2) return;
    setActiveIndex((current) => {
      const safeCurrent = Math.min(current, photos.length - 1);
      return (safeCurrent + nextIndex + photos.length) % photos.length;
    });
  };

  const markPhotoFailed = (url: string) => {
    setFailedPhotoUrls((current) => {
      if (current.has(url)) return current;
      const next = new Set(current);
      next.add(url);
      return next;
    });
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    gestureRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture || gesture.id !== event.pointerId || photos.length < 2) return;

    const deltaX = event.clientX - gesture.x;
    const deltaY = event.clientY - gesture.y;
    if (Math.abs(deltaX) < 32 || Math.abs(deltaX) <= Math.abs(deltaY)) return;

    event.preventDefault();
    event.stopPropagation();
    suppressLinkClickRef.current = true;
    selectPhoto(deltaX < 0 ? 1 : -1);
  };

  const handleLinkClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!suppressLinkClickRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    suppressLinkClickRef.current = false;
    return;
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    if (photos.length < 2) return;
    event.preventDefault();
    event.stopPropagation();
    selectPhoto(event.key === "ArrowRight" ? 1 : -1);
  };

  const handleControlPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  if (!photo) {
    return (
      <div className={styles.fallbackVisual} data-testid={`sale-media-fallback-${sale.id}`}>
        <SaleVisual
          sale={sale}
          title={title}
          locked={locked}
          eager={eager}
          preferPhoto
          mapWidth={512}
          mapHeight={384}
        />
      </div>
    );
  }

  return (
    <div
      className={`${styles.carousel} relative z-20`}
      data-testid={`sale-media-carousel-${sale.id}`}
      aria-label={`Photos de ${title}`}
      aria-roledescription="carrousel"
      role="region"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => {
        gestureRef.current = null;
      }}
    >
      <Link
        to="/sales/$id"
        params={{ id: sale.id }}
        search={returnTo ? { from: returnTo } : undefined}
        prefetch={false}
        aria-label={`Voir ${title}`}
        onClick={(event) => {
          const wasSuppressed = suppressLinkClickRef.current;
          handleLinkClick(event);
          if (!wasSuppressed) onSelect?.(sale.id);
        }}
        className={styles.photoLink}
      >
        <ListingPhoto
          key={photo.url}
          src={photo.url}
          alt={title}
          className={styles.photo}
          loading={eager ? "eager" : "lazy"}
          fetchPriority={eager ? "high" : "auto"}
          sizes="(max-width: 599px) calc(100vw - 24px), (max-width: 1023px) calc(50vw - 28px), 28vw"
          decoding="async"
          referrerPolicy="strict-origin-when-cross-origin"
          onOriginalError={() => markPhotoFailed(photo.url)}
          onLoad={(event) => {
            const renderedSource = event.currentTarget.currentSrc || event.currentTarget.src;
            if (
              !renderedSource.includes("/_next/image?") &&
              shouldRejectRenderedPropertyImage(event.currentTarget)
            ) {
              markPhotoFailed(photo.url);
            }
          }}
        />
      </Link>

      {photos.length > 1 ? (
        <>
          <button
            type="button"
            aria-label="Photo précédente"
            className={`${styles.carouselButton} ${styles.carouselButtonPrevious}`}
            onPointerDown={handleControlPointerDown}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              selectPhoto(-1);
            }}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Photo suivante"
            className={`${styles.carouselButton} ${styles.carouselButtonNext}`}
            onPointerDown={handleControlPointerDown}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              selectPhoto(1);
            }}
          >
            <ChevronRight aria-hidden="true" />
          </button>
          <span className={styles.photoCount} aria-live="polite">
            {Math.min(activeIndex + 1, photos.length)} / {photos.length}
          </span>
          <div className={styles.photoDots} aria-hidden="true">
            {photos.map((item, index) => (
              <span
                key={item.url}
                className={`${styles.photoDot} ${index === activeIndex ? styles.photoDotActive : ""}`}
              />
            ))}
          </div>
        </>
      ) : null}
    </div>
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
      ? "bg-brand-navy text-white"
      : tone === "cream"
        ? "bg-surface text-gold-text"
        : "bg-brand-navy text-white";

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
    <span className="inline-flex min-w-0 items-center gap-1 rounded-md bg-surface-muted px-2 py-1">
      <Icon className="h-3.5 w-3.5 shrink-0 text-brand-navy" />
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
    <span className="min-w-0 border-r border-line-soft px-2 py-2 last:border-r-0">
      <span className="block text-[9px] font-bold uppercase tracking-[0.08em] text-ink-soft">
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
      className="relative z-20 grid h-8 w-8 cursor-pointer place-items-center rounded-full text-brand-navy transition-colors hover:bg-surface-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
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
  onChange,
}: {
  saleId: string;
  locked: boolean;
  favoriteScope?: string | null;
  initialFavorite?: boolean;
  onChange?: (saleId: string, isFavorite: boolean) => void;
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
      onChange?.(saleId, !isFavorite);
      await queryClient.invalidateQueries({ queryKey: searchFavoriteQueryKey });
    } catch (error) {
      void queryClient.invalidateQueries({ queryKey: searchFavoriteQueryKey });
      toast.error(userMessage(error));
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
      className="relative z-20 grid h-8 w-8 cursor-pointer place-items-center rounded-full text-brand-navy transition-colors hover:bg-surface-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:cursor-not-allowed disabled:opacity-60"
    >
      {locked ? (
        <LockKeyhole className="h-4 w-4 text-gold-text" />
      ) : (
        <Heart className={`h-5 w-5 ${isFavorite ? "fill-danger text-danger" : ""}`} />
      )}
    </button>
  );
}
