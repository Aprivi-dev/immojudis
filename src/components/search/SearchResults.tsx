import { FloodExposedNote, PepiteInfoBadge } from "@/components/PepiteBadge";
import { SaleCountdown } from "@/components/SaleCountdown";
import type * as React from "react";
import { Fragment, memo, type ComponentProps, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/primitives";
import { getDisplaySurface } from "@/lib/surface";
import { SaleVisual } from "@/components/SaleVisual";
import { mayShowBuildingView } from "@/components/building-view";
import { ListingPhoto } from "@/components/ListingPhoto";
import { isPhotoMirrorUrl, photoMirrorForCard } from "@/lib/photo-mirror";
import { propertyImages, shouldRejectRenderedPropertyImage } from "@/lib/sale-media";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import Bell from "lucide-react/dist/esm/icons/bell.js";
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left.js";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import Heart from "lucide-react/dist/esm/icons/heart.js";
import Share2 from "lucide-react/dist/esm/icons/share-2.js";
import { toast } from "@/lib/toast";
import { useAuth } from "@/hooks/use-auth";
import { useFeeRegimes } from "@/components/FeeRegimesProvider";
import { useLaunchOffer } from "@/hooks/use-launch-offer";
import { useViewedSales } from "@/hooks/use-viewed-sales";
import { getSupabase } from "@/integrations/supabase/lazy";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { loginPathWithRedirect } from "@/lib/navigation";
import {
  FAVORITE_ADD_LABEL,
  FAVORITE_ANONYMOUS_TITLE,
  FAVORITE_VERIFYING_TITLE,
  FAVORITE_REMOVE_LABEL,
  announceFavoriteAdded,
} from "@/components/favorite-feedback";
import {
  addFavoriteSale as addFavoriteSaleRequest,
  fetchSaleUnlocksOverview,
  removeFavoriteSale as removeFavoriteSaleRequest,
} from "@/lib/client-api";
import { formatPrice, formatPricePerM2, occupancyLabel } from "@/lib/format";
import { pricePerM2 } from "@/lib/geo";
import { trackProductEvent } from "@/lib/product-events";
import { stateListingStatus } from "@/lib/property-characteristics";
import { departmentFromCode } from "@/lib/department-pages";
import { saleShortHeading, seoSurface } from "@/lib/seo";
import type { AuctionSale } from "@/lib/types";
import { MAX_COMPARED_SALES } from "@/lib/search/sale-comparison";
import type { ActiveFilterChip } from "./active-filter-chips";
import { ErrorState, NoResultsState } from "./SearchFilters";
import { LaunchOfferListBanner } from "./LaunchOfferListBanner";
import { LaunchOfferTrialEnd } from "./LaunchOfferTrialEnd";
import { SearchResultsSkeleton } from "./SearchResultsSkeleton";
import { SearchResultsTable } from "./SearchResultsTable";
import {
  departmentLabel,
  LISTING_DETAIL_LINE,
  LISTING_LAUNCH_OFFER_LINE,
  listingAccessLine,
  listingDateLabel,
  listingLinkLabel,
  listingPriceText,
  listingShortDateLabel,
  PAST_SALE_LABEL,
  listingTitle,
  saleTypeBadgeLabel,
  stateSaleWithoutPrice,
} from "./listing-text";
import type { FollowedSaleDossier } from "./use-followed-sales";
import type { DescribedSaleChange } from "@/lib/sale-change-display";
import { useSaleDetailLink } from "./use-sale-detail-link";
import styles from "./SearchResults.module.css";
import { AiReviewField } from "@/components/sale-detail/AiReviewField";
import { Terme } from "@/components/ceiling/Terme";
import {
  AI_REVIEW_SURFACE_FIELD_KEYS,
  firstBlockedAiReviewField,
  getAiReviewFieldResult,
  type AiReviewProjectionReadModel,
  type AiReviewRequestStatus,
} from "@/lib/ai-review-guard";
import { userMessage } from "@/lib/user-messages";
import * as queryKeys from "@/lib/query-keys";
import { useFavoriteRemovalConfirmation } from "@/components/favorite-removal";
import type { RemovedFavoriteDossier } from "@/lib/favorites";
import type { ResultsView } from "@/lib/search/results-view";

/**
 * Vignette cartographique d'une carte de résultats (ratio 4:3, comme le cadre `aspect-[4/3]`).
 * `framingWidth` est la largeur de l'ancien visuel (512 px @2x) : le zoom est reculé en
 * conséquence pour que la zone visible reste identique avec moins de pixels. 320 × 240 (400 × 300
 * avant) : la vignette de la première carte est l'élément principal (LCP) de /sales sur mobile ; en
 * 1x elle compte 36 % de pixels en moins, en @2x (640 × 480 au lieu de 800 × 600) autant.
 */
const LIST_MAP_THUMBNAIL = { width: 320, height: 240, framingWidth: 512 } as const;

/**
 * Nombre de cartes dont l'image est chargée en priorité haute (`fetchpriority="high"`, hors
 * chargement différé). Une seule : sur mobile la deuxième carte est sous la ligne de flottaison,
 * et une seconde image prioritaire (33 Ko) ralentit celle de l'élément principal (LCP).
 */
export const EAGER_IMAGE_COUNT = 1;

/**
 * Cadre du visuel d'une carte : 4/3, ou 5/2 quand la vente n'a ni photo ni vue aérienne possible et
 * ne montrera que l'illustration de son type de bien (un dessin n'a pas besoin de 273 px de haut :
 * 14 cartes sur 24 n'ont pas de photo). Décidé sur les seules données de la vente, avant tout
 * chargement : la hauteur ne change donc pas quand l'image arrive ou échoue.
 */
export function listingMediaFrameClass(
  sale: Pick<AuctionSale, "media"> &
    Partial<Pick<AuctionSale, "latitude" | "longitude" | "location_precision">>,
): string {
  const illustrationOnly = propertyImages(sale.media).length === 0 && !mayShowBuildingView(sale);
  return illustrationOnly ? "aspect-[5/2]" : "aspect-[4/3]";
}

/**
 * Rang de la carte dont l'image est prioritaire (chargée tout de suite, `fetchPriority="high"`) :
 * la première qui a une photo, pas forcément la carte 0, qui peut n'avoir qu'une case neutre et
 * perdrait le seul rang prioritaire. Aucune photo dans la liste : la carte 0, comme avant.
 */
export function eagerImageIndex(sales: readonly Pick<AuctionSale, "media">[]): number {
  const withPhoto = sales.findIndex((sale) => propertyImages(sale.media).length > 0);
  return withPhoto === -1 ? 0 : withPhoto;
}

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
  activeFilters,
  onRemoveFilter,
  onResetFilters,
  onShowFrance,
  hideEmptyState = false,
  view = "cards",
  pepiteSaleIds,
  pepiteExposedSaleIds,
  pepiteEmpty,
  dossierBySaleId,
  lastChangeBySaleId,
}: {
  /** Abonné de l'offre Analyse : « Mon dossier » des ventes suivies (cartes et colonne du tableau). */
  dossierBySaleId?: ReadonlyMap<string, FollowedSaleDossier>;
  /** Abonné de l'offre Analyse : dernier changement de chaque vente suivie. */
  lastChangeBySaleId?: ReadonlyMap<string, DescribedSaleChange>;
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
  /** Critères actifs, affichés en puces retirables quand la recherche ne donne rien. */
  activeFilters?: ActiveFilterChip[];
  onRemoveFilter?: (filter: ActiveFilterChip) => void;
  onResetFilters?: () => void;
  onShowFrance?: () => void;
  /** Page au-delà de la dernière : c'est la pagination qui l'explique, pas les critères. */
  hideEmptyState?: boolean;
  /** « table » : un tableau des mêmes annonces (écran large) ; les cartes sinon. */
  view?: ResultsView;
  /** Pépites publiables (liste publique lue une fois par page) : pastille sur la carte et le tableau. */
  pepiteSaleIds?: ReadonlySet<string>;
  /** Parmi les pépites, celles dont le bien est dans le périmètre d'un PPRi (mention courte). */
  pepiteExposedSaleIds?: ReadonlySet<string>;
  /** Actions de l'état vide quand « Pépites seulement » est actif (voir `NoResultsState`). */
  pepiteEmpty?: ComponentProps<typeof NoResultsState>["pepite"];
}) {
  const { user, loading: authLoading } = useAuth();
  const saleIds = useMemo(() => sales.map(({ id }) => id), [sales]);
  const firstEagerIndex = useMemo(() => eagerImageIndex(sales), [sales]);
  const favoriteQueryIds = useMemo(() => [...saleIds].sort(), [saleIds]);
  const favoriteQuery = useQuery({
    queryKey: queryKeys.searchFavoriteStatus(user?.id ?? null, favoriteQueryIds),
    queryFn: async () => {
      const { data, error } = await (await getSupabase())
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
  // « 3 déblocages par mois » : un compte Découverte voit lesquelles de ces ventes il a débloquées.
  // Sans réponse (erreur, base sans le déblocage), aucune pastille : la carte reste celle d'avant.
  const unlocksQuery = useQuery({
    queryKey: queryKeys.saleUnlocksOverview(user?.id ?? null),
    queryFn: fetchSaleUnlocksOverview,
    enabled: Boolean(user && !authLoading && !isLoading && !locked && analysisLocked),
    staleTime: 60_000,
    retry: false,
  });
  const unlockedIds = useMemo(
    () => new Set((unlocksQuery.data?.sales ?? []).map(({ id }) => id)),
    [unlocksQuery.data],
  );
  const favoriteScope = user?.id ?? null;
  // Compte reconnu sur la liste publique conservée pendant la vérification de ses droits : les
  // cartes ne lui promettent pas un « compte gratuit » qu'il a déjà.
  const verifying = Boolean(user) && locked;

  return (
    <div className="pb-24 lg:pb-6">
      <LaunchOfferListBanner />
      <LaunchOfferTrialEnd />
      {error ? <ErrorState error={error} onRetry={onRetry} /> : null}

      {/* Les titres des cartes sont des h3 : sans h2 devant eux, la page saute du h1 au h3. */}
      {isLoading || sales.length > 0 ? <h2 className="sr-only">Résultats</h2> : null}

      {!isLoading && sales.length === 0 && !error && !hideEmptyState ? (
        <NoResultsState
          filters={activeFilters}
          onRemoveFilter={onRemoveFilter}
          onReset={onResetFilters}
          onShowFrance={onShowFrance}
          pepite={
            activeFilters?.some((filter) => filter.key === "pepite") ? pepiteEmpty : undefined
          }
        />
      ) : null}

      {view === "table" ? (
        <>
          <SearchResultsTable
            sales={sales}
            returnTo={returnTo}
            locked={locked}
            analysisLocked={analysisLocked}
            verifying={verifying}
            isLoading={isLoading}
            selectedSaleId={selectedSaleId}
            hoveredSaleId={hoveredSaleId}
            onHover={onHover}
            onSelect={onSelect}
            unlockedIds={unlockedIds}
            pepiteSaleIds={pepiteSaleIds}
            pepiteExposedSaleIds={pepiteExposedSaleIds}
            aiReviewBySaleId={aiReviewBySaleId}
            aiReviewStatus={aiReviewStatus}
            favoriteIds={favoriteIds}
            favoriteScope={favoriteScope}
            FavoriteButton={CompactFavoriteButton}
            dossierBySaleId={dossierBySaleId}
          />
        </>
      ) : (
        <div className="grid grid-cols-1 gap-4 min-[600px]:grid-cols-2">
          {isLoading
            ? Array.from({ length: 8 }).map((_, index) => <SearchResultsSkeleton key={index} />)
            : sales.map((sale, index) => (
                <Fragment key={sale.id}>
                  <ListingCard
                    sale={sale}
                    returnTo={returnTo}
                    eagerImage={
                      index >= firstEagerIndex && index < firstEagerIndex + EAGER_IMAGE_COUNT
                    }
                    locked={locked}
                    verifying={verifying}
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
                    unlocked={unlockedIds.has(sale.id)}
                    pepite={pepiteSaleIds?.has(sale.id.toLowerCase()) === true}
                    pepiteFloodExposed={
                      pepiteSaleIds?.has(sale.id.toLowerCase()) === true &&
                      pepiteExposedSaleIds?.has(sale.id.toLowerCase()) === true
                    }
                    // Une vente suivie : le cœur de la carte le dit, la ligne « Mon dossier » aussi.
                    // Retirée des favoris depuis la carte, elle n'a plus de dossier.
                    dossier={
                      favoriteIds.has(sale.id) || !favoriteQuery.isSuccess
                        ? (dossierBySaleId?.get(sale.id) ?? null)
                        : null
                    }
                    lastChange={lastChangeBySaleId?.get(sale.id) ?? null}
                  />
                </Fragment>
              ))}
        </div>
      )}
      {/* Encart sponsorisé en fin de liste, jamais entre deux annonces ; l'appelant ne le fournit
          que pour la première page. */}
      {!isLoading && sales.length >= 4 && sponsoredPlacement ? (
        <div className="mt-4">{sponsoredPlacement}</div>
      ) : null}
    </div>
  );
}
/** Assemble les éléments présents, séparés par « · » : aucun séparateur ne reste seul. */
function withSeparators(parts: React.ReactNode[]): React.ReactNode {
  const kept = parts.filter((part) => part != null && part !== false && part !== "");
  return kept.map((part, index) => (
    <Fragment key={index}>
      {index > 0 ? " · " : null}
      {part}
    </Fragment>
  ));
}

export const ListingCard = memo(function ListingCard({
  sale,
  returnTo,
  eagerImage = false,
  locked,
  verifying = false,
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
  unlocked = false,
  pepite = false,
  pepiteFloodExposed = false,
  dossier = null,
  lastChange = null,
  onFavoriteChange,
}: {
  sale: AuctionSale;
  returnTo: string;
  eagerImage?: boolean;
  /** Abonné de l'offre Analyse, vente suivie : « Mon dossier » (statut, plafond) sur la carte. */
  dossier?: FollowedSaleDossier | null;
  /** Abonné de l'offre Analyse, vente suivie : dernier changement détecté (30 jours). */
  lastChange?: DescribedSaleChange | null;
  locked: boolean;
  /** Compte reconnu, liste publique gardée le temps de la vérification : ligne d'accès neutre. */
  verifying?: boolean;
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
  /** Le compte a débloqué cette vente (« 3 déblocages par mois ») : pastille « Débloquée ». */
  unlocked?: boolean;
  /** La vente est une pépite publiable : pastille « Pépite » sur la photo, mot ajouté au nom du lien. */
  pepite?: boolean;
  /** Pépite dont le bien est dans le périmètre d'un PPRi : mention courte, sans montant. */
  pepiteFloodExposed?: boolean;
  /** Appelé après l'ajout ou le retrait réussi d'un favori depuis la carte. */
  onFavoriteChange?: (
    saleId: string,
    isFavorite: boolean,
    removed?: RemovedFavoriteDossier | null,
  ) => void;
}) {
  const displaySurface = getDisplaySurface(sale);
  const { isViewed } = useViewedSales();
  const detailLink = useSaleDetailLink(sale.id, returnTo);
  const { active: launchOffer, pending: launchPending } = useLaunchOffer();
  const openFeeRegimes = useFeeRegimes()?.open;
  // L'occupation n'est montrée qu'à qui y a droit (offre Analyse, vente débloquée comprise via la
  // liste connectée) : sinon la case du milieu dit les pièces.
  const premiumLocked = locked || analysisLocked;
  const viewed = !locked && isViewed(sale.id);
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
  const title = listingTitle(sale, { locked, aiReviewProjections, aiReviewStatus });
  // Cession de l'État en ligne sans échéance publiée : « Procédure à venir » plutôt que « Date à confirmer ».
  const stateListing = stateListingStatus(sale);
  // Titre court de la fiche (« Appartement de 39 m² à Beure ») : un champ en cours de vérification
  // n'y entre pas (docs/design/fondations.md, décision du 24/10/2026).
  const typeReview = getAiReviewFieldResult(
    aiReviewProjections,
    "property.property_type",
    aiReviewStatus,
  );
  // Prix au m² de la mise à prix : seulement avec une surface publiée, non estimée et qui n'est pas
  // celle d'un terrain (le prix d'un terrain au m² ne se compare pas à celui d'un logement).
  const startingPricePerM2 =
    !surfaceReviewField && !stateSaleWithoutPrice(sale) && displaySurface.kind === "recorded"
      ? pricePerM2(sale.starting_price_eur, displaySurface.value)
      : null;
  const headingSale = {
    ...sale,
    city: cityReview.blocked ? null : sale.city,
    app_surface_m2: surfaceReviewField ? null : sale.app_surface_m2,
  };
  // Type en cours de vérification : « Type de bien à confirmer » et sa source, puis la ville.
  const heading = typeReview.blocked ? (
    <>
      <AiReviewField
        fieldKey="property.property_type"
        projections={aiReviewProjections}
        reviewStatus={aiReviewStatus}
        fallback="Type de bien à confirmer"
        sourceName={sale.source_name}
        sourceUrl={sale.source_url}
        showSourceLink={false}
      >
        {saleShortHeading(headingSale)}
      </AiReviewField>
      {headingSale.city?.trim() ? ` à ${headingSale.city.trim()}` : null}
    </>
  ) : (
    saleShortHeading(headingSale)
  );
  const headingHasSurface = !surfaceReviewField && seoSurface(sale.app_surface_m2) != null;
  const department = departmentFromCode(sale.department);
  // Une ville en cours de vérification ne laisse pas non plus son département (comme sur la fiche).
  const departmentLine = cityReview.blocked
    ? null
    : department
      ? `${department.name} (${department.code})`
      : departmentLabel(sale.department);
  const roomsCount = roomsReview.blocked ? null : sale.rooms_count;
  const roomSummary =
    roomsCount != null
      ? `${roomsCount} pièce${roomsCount === 1 ? "" : "s"}`
      : !roomsReview.blocked && sale.bedrooms_count != null
        ? `${sale.bedrooms_count} ch.`
        : null;
  // Visiteur et offre Découverte : la case du milieu dit les pièces, la ligne du lieu les chambres.
  const bedroomSummary =
    roomsReview.blocked || sale.bedrooms_count == null
      ? null
      : `${sale.bedrooms_count} chambre${sale.bedrooms_count === 1 ? "" : "s"}`;
  const occupancyText = sale.occupancy_status ? occupancyLabel(sale.occupancy_status) : null;
  const occupancyTone =
    occupancyText === "Libre"
      ? "text-success"
      : occupancyText && (occupancyText.startsWith("Occupé") || occupancyText === "Loué")
        ? "text-warning"
        : "";
  const review = {
    projections: aiReviewProjections,
    reviewStatus: aiReviewStatus,
    sourceName: sale.source_name,
    sourceUrl: sale.source_url,
    showSourceLink: false,
  } as const;
  const surfaceFact = surfaceReviewField ? (
    <AiReviewField fieldKey={surfaceReviewField} fallback="À confirmer" {...review}>
      {displaySurface.value != null ? displaySurface.label : "n.c."}
    </AiReviewField>
  ) : displaySurface.value != null ? (
    displaySurface.label
  ) : (
    "n.c."
  );
  const roomsFact = roomsReview.blocked ? (
    <AiReviewField fieldKey="property.rooms_count" fallback="À confirmer" {...review}>
      {sale.rooms_count != null ? String(sale.rooms_count) : "n.c."}
    </AiReviewField>
  ) : sale.rooms_count != null ? (
    String(sale.rooms_count)
  ) : (
    "n.c."
  );
  const occupancyFact = occupancyText ? (
    <AiReviewField fieldKey="property.occupancy_status" {...review}>
      {occupancyText}
    </AiReviewField>
  ) : (
    "n.c."
  );
  const dateFact = (
    <AiReviewField fieldKey="sale.sale_date" {...review}>
      {stateListing ? stateListing.label : listingShortDateLabel(sale)}
    </AiReviewField>
  );
  // La ligne d'accès n'apparaît que lorsqu'elle dit quelque chose de propre à la vente : l'offre de
  // lancement est dite une fois au-dessus de la liste, et « Voir la fiche » répète le lien.
  const accessLine = listingAccessLine(sale, {
    locked,
    analysisLocked,
    unlocked,
    verifying,
    launchOffer,
    launchPending,
    openFeeRegimes,
  });
  const showAccessLine =
    accessLine !== LISTING_LAUNCH_OFFER_LINE && accessLine !== LISTING_DETAIL_LINE;

  return (
    <article
      onMouseEnter={() => onHover(sale.id)}
      onMouseLeave={() => onHover(null)}
      onFocusCapture={() => onHover(sale.id)}
      onBlurCapture={() => onHover(null)}
      // Carte blanche au filet, sans ombre ; survolée (ou survolée sur la carte), le filet passe au marine.
      className={`group relative flex flex-col overflow-hidden rounded-lg border bg-white transition-colors [contain-intrinsic-size:none_auto_30rem] [content-visibility:auto] ${active ? "border-brand-navy ring-1 ring-brand-navy" : "border-line-soft hover:border-brand-navy"}`}
    >
      <Link
        id={`sale-card-${sale.id}`}
        href={detailLink.href}
        {...detailLink.armProps}
        prefetch={false}
        onClick={() => onSelect(sale.id)}
        aria-label={listingLinkLabel(sale, title, {
          price: getAiReviewFieldResult(
            aiReviewProjections,
            "sale.starting_price_eur",
            aiReviewStatus,
          ).blocked,
          date: getAiReviewFieldResult(aiReviewProjections, "sale.sale_date", aiReviewStatus)
            .blocked,
          pepite,
          floodExposed: pepiteFloodExposed,
        })}
        className="absolute inset-0 z-10 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
      />
      <div
        className={`relative ${listingMediaFrameClass(sale)} overflow-hidden bg-surface-tint`}
        data-testid={`sale-media-frame-${sale.id}`}
      >
        <ListingImage
          sale={sale}
          locked={false}
          eager={eagerImage}
          title={title}
          returnTo={returnTo}
          onSelect={onSelect}
          placeLabel={headingSale.city}
        />
        <div className="absolute right-2 top-2 z-30">
          <CompactFavoriteButton
            key={`${sale.id}:${favoriteScope ?? "anonymous"}`}
            saleId={sale.id}
            // Discovery can save a limited number of favourites (PLAN_LIMITS.decouverte.favoriteSales).
            // Keep the favourite control available while the rest of the card stays analysis-gated.
            locked={locked}
            favoriteScope={favoriteScope}
            initialFavorite={initialFavorite}
            onChange={onFavoriteChange}
            onImage
          />
        </div>
        {(pepite || unlocked || viewed) && (
          <div className="absolute left-3 top-3 z-20 flex flex-wrap items-start gap-1">
            {pepite && <PepiteInfoBadge floodExposed={pepiteFloodExposed} />}
            {unlocked && (
              <Badge tone="gold" className="border-gold bg-gold font-bold text-brand-navy">
                Débloquée
              </Badge>
            )}
            {/* Deux pastilles au plus sur la photo (docs/design/fondations.md) : « Vu », la moins utile, cède la
                place quand « Pépite » et « Débloquée » s'appliquent ensemble. */}
            {viewed && !(pepite && unlocked) && (
              <Badge tone="neutral" className="bg-white/95 font-bold">
                Vu
              </Badge>
            )}
          </div>
        )}
      </div>
      {/* « Fiche technique » (maquette /sales validée) : type de vente et échéance, titre, lieu, mise à
          prix, puis trois cases (surface, pièces ou occupation, date de vente). Sur mobile, les faits
          tiennent sur une ligne et le lieu s'efface : la carte reste compacte. */}
      <div className="relative flex min-w-0 flex-1 flex-col gap-2.5 p-4 pb-3">
        {/* Deux pastilles au plus (docs/design/fondations.md) : le type de vente et l'échéance. Hauteur
            d'une pastille réservée : le compte à rebours ne s'écrit qu'après l'hydratation (il lit
            l'heure du navigateur) et ne doit rien faire descendre (CLS). */}
        <div
          className="flex min-h-[1.625rem] flex-wrap items-center gap-1.5 text-xs"
          data-testid="card-badges"
        >
          <Badge tone="neutral">{saleTypeBadgeLabel(sale)}</Badge>
          <SaleCountdown
            sale={sale}
            precisionUnknown={locked}
            variant="chip"
            omitPast={!stateListing && listingDateLabel(sale) === PAST_SALE_LABEL}
          />
        </div>
        <h3 className="font-sans text-lg font-semibold leading-snug text-brand-navy">{heading}</h3>
        {pepite && pepiteFloodExposed ? <FloodExposedNote className="-mt-1" /> : null}
        <p className="-mt-1 hidden text-sm leading-5 text-ink-soft sm:block">
          {withSeparators([
            cityReview.blocked || (!headingSale.city?.trim() && !departmentLine) ? (
              <span>Localisation à préciser</span>
            ) : null,
            departmentLine,
            headingHasSurface || displaySurface.value != null || surfaceReviewField
              ? null
              : "surface non communiquée",
            premiumLocked ? bedroomSummary : roomSummary,
          ])}
        </p>
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-2xl font-semibold leading-none tracking-[-0.01em] text-brand-navy tabular-nums">
            <AiReviewField fieldKey="sale.starting_price_eur" {...review}>
              {listingPriceText(sale)}
            </AiReviewField>
          </span>
          {stateSaleWithoutPrice(sale) ? null : (
            <span className="text-caption text-ink-soft">
              <Terme terme="mise-a-prix" placement="top">
                mise à prix
              </Terme>
            </span>
          )}
          {startingPricePerM2 != null ? (
            <span className="hidden text-caption text-ink-soft tabular-nums sm:inline">
              · {formatPricePerM2(startingPricePerM2)}
            </span>
          ) : null}
        </p>
        <dl className="mt-0.5 hidden grid-cols-3 border-y border-line-soft sm:grid">
          <div className="min-w-0 py-2.5 pr-2">
            <dt className="text-xs text-ink-soft">Surface</dt>
            <dd className="mt-0.5 truncate text-sm font-semibold text-brand-navy tabular-nums">
              {surfaceFact}
            </dd>
          </div>
          {premiumLocked ? (
            <div className="min-w-0 border-l border-line-soft py-2.5 pl-3 pr-2">
              <dt className="text-xs text-ink-soft">Pièces</dt>
              <dd className="mt-0.5 truncate text-sm font-semibold text-brand-navy tabular-nums">
                {roomsFact}
              </dd>
            </div>
          ) : (
            <div className="min-w-0 border-l border-line-soft py-2.5 pl-3 pr-2">
              <dt className="text-xs text-ink-soft">Occupation</dt>
              <dd
                className={`mt-0.5 truncate text-sm font-semibold ${occupancyTone || "text-brand-navy"}`}
              >
                {occupancyFact}
              </dd>
            </div>
          )}
          <div className="min-w-0 border-l border-line-soft py-2.5 pl-3">
            <dt className="text-xs text-ink-soft">Vente le</dt>
            <dd className="mt-0.5 truncate text-sm font-semibold text-brand-navy tabular-nums">
              {dateFact}
            </dd>
          </div>
        </dl>
        <p className="text-sm text-ink-strong tabular-nums sm:hidden" data-testid="card-facts-line">
          {withSeparators([
            displaySurface.value != null || surfaceReviewField ? surfaceFact : "Surface n.c.",
            premiumLocked ? (
              roomSummary
            ) : occupancyText ? (
              <span className={occupancyTone}>{occupancyFact}</span>
            ) : null,
            <Fragment key="date">
              {stateListing ? null : "vente le "}
              {dateFact}
            </Fragment>,
          ])}
        </p>
        {showAccessLine ? <p className="text-caption text-ink-soft">{accessLine}</p> : null}
        {lastChange ? (
          <p
            className="flex items-start gap-1.5 text-caption font-semibold text-warning"
            data-testid="card-last-change"
          >
            <Bell className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              {lastChange.label}
              {lastChange.detail ? (
                <span className="font-medium tabular-nums"> · {lastChange.detail}</span>
              ) : null}
            </span>
          </p>
        ) : null}
        {dossier ? (
          <p
            className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md border border-line-soft bg-surface-muted px-3 py-2 text-caption text-ink-strong"
            data-testid="card-dossier"
          >
            <span className="inline-flex items-center gap-1.5 font-semibold text-brand-navy">
              <span aria-hidden="true" className="size-2 rounded-full bg-gold" />
              {dossier.statusLabel ?? "Vente suivie"}
            </span>
            <span>
              Mon plafond :{" "}
              <b className="font-semibold text-brand-navy tabular-nums">
                {dossier.bidCeilingEur != null ? formatPrice(dossier.bidCeilingEur) : "à calculer"}
              </b>
            </span>
          </p>
        ) : null}
        <div className="mt-auto flex items-center justify-between gap-2">
          {/* Toute la carte mène à la fiche (lien qui la couvre, seul arrêt du clavier) : ce
              libellé n'en est que le repère visible. */}
          <span
            aria-hidden="true"
            className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-gold-text underline underline-offset-4 group-hover:text-brand-navy"
          >
            Voir la fiche
            <ArrowRight className="size-4" />
          </span>
          <div className="flex items-center gap-1.5">
            <span className="hidden sm:contents">
              <ShareButton sale={sale} title={title} />
            </span>
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
                className={`relative z-20 min-h-11 cursor-pointer rounded-md border px-4 text-sm font-semibold hover:bg-surface-tint focus-visible:outline-2 focus-visible:outline-gold-soft disabled:opacity-50 ${comparisonSelected ? "border-gold-soft bg-gold/10 text-brand-navy" : "border-brand-navy/55 text-brand-navy"}`}
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
  placeLabel = null,
}: {
  sale: AuctionSale;
  locked: boolean;
  eager?: boolean;
  title: string;
  returnTo?: string;
  onSelect?: (saleId: string) => void;
  /** Ville écrite dans la case neutre ; `null` quand elle est en cours de vérification. */
  placeLabel?: string | null;
}) {
  return (
    <ListingMediaCarousel
      sale={sale}
      locked={locked}
      eager={eager}
      title={title}
      returnTo={returnTo}
      onSelect={onSelect}
      placeLabel={placeLabel}
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
  placeLabel = null,
}: {
  sale: AuctionSale;
  locked: boolean;
  eager?: boolean;
  title: string;
  returnTo?: string;
  onSelect?: (saleId: string) => void;
  placeLabel?: string | null;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [failedPhotoUrls, setFailedPhotoUrls] = useState<Set<string>>(() => new Set());
  const gestureRef = useRef<PointerGesture | null>(null);
  const suppressLinkClickRef = useRef(false);
  const detailLink = useSaleDetailLink(sale.id, returnTo ?? "/sales");
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
          thumbnail
          mapWidth={LIST_MAP_THUMBNAIL.width}
          mapHeight={LIST_MAP_THUMBNAIL.height}
          mapFramingWidth={LIST_MAP_THUMBNAIL.framingWidth}
          // Sans photo : la vue satellite de l'adresse, sinon une case neutre avec la ville.
          sectorMap={false}
          placeLabel={placeLabel}
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
      role="group"
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => {
        gestureRef.current = null;
      }}
    >
      {/* Même destination que le lien qui couvre la carte : hors de l'ordre de tabulation et masqué
          aux lecteurs d'écran, il n'ajoute ni arrêt de Tab ni doublon au clavier. */}
      <Link
        href={detailLink.href}
        {...detailLink.armProps}
        prefetch={false}
        tabIndex={-1}
        aria-hidden="true"
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
          mirror={photoMirrorForCard(photo.mirror)}
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
            // La copie n'est retenue que si l'original a passé ce contrôle (voir photo-mirror.ts).
            if (
              !renderedSource.includes("/_next/image?") &&
              !isPhotoMirrorUrl(renderedSource) &&
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
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-extrabold shadow-sm ${toneClass}`}
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
      <span className="block text-xs font-bold text-ink-soft">{label}</span>
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
      className="relative z-20 grid h-11 w-11 cursor-pointer place-items-center rounded-md border border-line bg-white text-brand-navy transition-colors hover:border-brand-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
      aria-label="Partager cette vente"
    >
      <Share2 className="h-[18px] w-[18px]" aria-hidden />
    </button>
  );
}

export function CompactFavoriteButton({
  saleId,
  locked,
  favoriteScope,
  initialFavorite = false,
  onChange,
  onImage = false,
}: {
  saleId: string;
  locked: boolean;
  favoriteScope?: string | null;
  initialFavorite?: boolean;
  onChange?: (saleId: string, isFavorite: boolean, removed?: RemovedFavoriteDossier | null) => void;
  /** Posé sur la photo de la carte : pastille blanche lisible sur n'importe quelle image. */
  onImage?: boolean;
}) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [isFavorite, setIsFavorite] = useState(initialFavorite);
  const [busy, setBusy] = useState(false);
  const { confirmRemoval, dialog: removalDialog } = useFavoriteRemovalConfirmation();
  // `locked` pour un compte reconnu = liste publique gardée pendant la vérification de ses droits.
  const verifying = Boolean(user) && locked;

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
      router.push(loginPathWithRedirect(redirect, { reason: "favori" }));
      return;
    }
    if (locked) return;

    setBusy(true);
    const searchFavoriteQueryKey = queryKeys.searchFavoriteStatusForUser(user.id);
    let removed: RemovedFavoriteDossier | null = null;
    try {
      await queryClient.cancelQueries({ queryKey: searchFavoriteQueryKey });
      if (isFavorite) {
        // « Mon dossier » (statut, plafond) part avec la ligne : confirmation s'il n'est pas vide.
        if (!(await confirmRemoval(saleId))) return;
        removed = (await removeFavoriteSaleRequest({ saleId }))?.dossier ?? null;
        setIsFavorite(false);
      } else {
        const added = await addFavoriteSaleRequest({ data: { saleId } });
        trackProductEvent("favorite_added");
        setIsFavorite(true);
        void announceFavoriteAdded(queryClient, user.id, added?.plan?.limit ?? null);
      }
      queryClient.setQueriesData<string[] | undefined>(
        { queryKey: queryKeys.searchFavoriteStatusForUser(user.id) },
        (favoriteSaleIds) => {
          const nextFavoriteSaleIds = new Set(favoriteSaleIds ?? []);
          if (isFavorite) nextFavoriteSaleIds.delete(saleId);
          else nextFavoriteSaleIds.add(saleId);
          return [...nextFavoriteSaleIds];
        },
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.favorites(user.id) });
      onChange?.(saleId, !isFavorite, removed);
      await queryClient.invalidateQueries({ queryKey: searchFavoriteQueryKey });
    } catch (error) {
      void queryClient.invalidateQueries({ queryKey: searchFavoriteQueryKey });
      toast.error(userMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {removalDialog}
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        aria-pressed={locked ? undefined : isFavorite}
        aria-label={isFavorite && !locked ? FAVORITE_REMOVE_LABEL : FAVORITE_ADD_LABEL}
        // Compte reconnu sur la liste publique conservée : `aria-disabled` (le cœur reste focalisable et
        // annoncé) plutôt qu'un clic sans effet.
        aria-disabled={verifying ? true : undefined}
        title={verifying ? FAVORITE_VERIFYING_TITLE : locked ? FAVORITE_ANONYMOUS_TITLE : undefined}
        className={`relative z-20 grid h-11 w-11 cursor-pointer place-items-center rounded-full text-brand-navy transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft disabled:cursor-not-allowed disabled:opacity-60 aria-disabled:cursor-wait aria-disabled:opacity-60 ${onImage ? "bg-white/95 ring-1 ring-line-soft hover:bg-white" : "hover:bg-surface-tint"}`}
      >
        <Heart className={`h-5 w-5 ${isFavorite && !locked ? "fill-danger text-danger" : ""}`} />
      </button>
    </>
  );
}
