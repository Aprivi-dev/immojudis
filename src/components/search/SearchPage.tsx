"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import X from "lucide-react/dist/esm/icons/x.js";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { useSaleComparison } from "@/hooks/use-sale-comparison";
import { useRouter, useSearchParams } from "next/navigation";
import { usePublicPathname } from "@/hooks/use-public-pathname";
import {
  createWatchedZone as createWatchedZoneRequest,
  fetchAccessPlan,
  fetchDpeExplorer,
  exportSalesCsv,
  fetchNotificationPreferences,
  fetchSalesAiReviewProjections,
  fetchSalesStatistics,
} from "@/lib/client-api";
import { createAlert, getSaleById } from "@/lib/queries";
import { applyPhotoMirrors, isPhotoMirrorEnabled, mirrorsFromSales } from "@/lib/photo-mirror";
import type { AuctionSale, SaleMediaMirror } from "@/lib/types";
import { trackProductEvent } from "@/lib/product-events";
import { OFFERS_PATH, loginPathWithRedirect, pathWithSearch } from "@/lib/navigation";
import { geocodeAddress, geocodeAdministrativeArea, type GeoPoint } from "@/lib/geo";
import { departmentSearchValues, resolveFrenchGeoSearch } from "@/lib/search/french-geo-search";
import type { AiReviewProjectionReadModel, AiReviewRequestStatus } from "@/lib/ai-review-guard";
import {
  DEFAULT_SEARCH_LIMIT,
  applyClientSearchFilters,
  countActiveSearchFilters,
  hasCoordinates,
  sortClientSearchResults,
  visibleSearchSort,
} from "@/lib/search/search-filters";
import {
  effectiveResultsView,
  keepCurrentResultsView,
  withResultsView,
  type ResultsView,
} from "@/lib/search/results-view";
import { areMapViewportsClose } from "@/lib/search/map-viewport-results";
import { isAnalysisOfferOpen } from "@/lib/search/analysis-offer-open";
import {
  ANONYMOUS_PREVIEW_SCOPE,
  catalogPlaceholder,
  salesSearchCountQueryKey,
  salesSearchQueryKey,
} from "@/lib/search/catalog-placeholder";
import {
  canonicalSalesQuery,
  mergeSalesSearch,
  salesSearchToUrlRecord,
  type SalesSearchParams,
  type SalesSearchUrlRecord,
} from "@/lib/search/search-url-state";
import { isOutOfRangeSearchError } from "@/lib/search/search-errors";
import {
  fetchSearchCount,
  fetchSearchMapResults,
  fetchSearchPhotoMirrors,
  fetchSearchResults,
} from "@/lib/search/search-service";
import type { MapViewportChange } from "./MapPanel";
import { FiltersLoadingFallback } from "./FiltersLoadingFallback";
import { SALES_PAGINATION_ID, SearchPagination } from "./SearchPagination";
import { scrollToSaleCard } from "./scroll-to-sale-card";
import { DESKTOP_MAP_ZONE_ID, DesktopMapZone } from "./DesktopMapZone";
import { loadMapPanelModule, preloadMapModules } from "./preload-map";
import { useFirstGestureStart } from "./use-first-gesture-start";
import { WHOLE_FRANCE_PATCH, activeFilterChips, hasGeographicFilter } from "./active-filter-chips";
import { Footer, MapPanelSkeleton, MobileMapToggle } from "./SearchFilters";
import {
  ResultsSummary,
  ResultsViewToggle,
  SearchHeader,
  SortByDateShortcut,
  SortDropdown,
  type SaveSearchOptions,
} from "./SearchHeader";
import { RankingExplanation } from "./RankingExplanation";
import { enableAlertEmailRecap } from "./alert-email-consent";
import { SearchResultsList } from "./SearchResults";
import { SaleComparisonBar } from "./SaleComparisonBar";
import { SaleTypeFilter } from "./SaleTypeFilter";
import { SearchLawyerPlacement } from "./SearchLawyerPlacement";
import {
  SearchDraft,
  buildAlertName,
  buildSearchStatistics,
  downloadBlob,
  draftToSearch,
  emptySearchDraft,
  historyModeForDraftChange,
  searchStatisticsFromServer,
  searchToDraft,
  stableUrlRecord,
  type HistoryMode,
  useMediaQuery,
  useResultsView,
  watchedZoneInputFromSearch,
} from "./search-page-state";
import { userMessage } from "@/lib/user-messages";
import { queryKeys } from "@/lib/query-keys";

const LazyMapPanel = dynamic(() => loadMapPanelModule().then((mod) => mod.MapPanel), {
  ssr: false,
  loading: () => <MapPanelSkeleton />,
});

/** The map draws at most this many points: more would make clusters and popups sluggish. */
const MAP_POINT_LIMIT = 500;

/** Liens d'évitement : invisibles tant qu'ils n'ont pas le focus clavier. */
const SKIP_LINK_CLASSES =
  "sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[80] focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-bold focus:text-brand-navy focus:shadow-lg";

const NO_SALES: AuctionSale[] = [];
const NO_PHOTO_MIRRORS: ReadonlyMap<string, SaleMediaMirror> = new Map();

function SearchStatisticsLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Chargement des repères"
      className="border-b border-brand-navy/10 bg-white px-4 py-4 text-sm font-semibold text-ink-soft sm:px-5"
    >
      Chargement des repères…
    </div>
  );
}

const LazyMoreFiltersModal = dynamic(
  () => import("./AdvancedFiltersPanel").then((mod) => mod.MoreFiltersModal),
  { loading: () => <FiltersLoadingFallback /> },
);

const LazySearchStatisticsPanel = dynamic(
  () => import("./SearchStatisticsPanel").then((mod) => mod.SearchStatisticsPanel),
  { loading: () => <SearchStatisticsLoading /> },
);

/**
 * `serverSeeded` is true when the server already rendered (and dehydrated) the
 * anonymous first page for this exact search. The list then stays visible while
 * the session is being restored instead of being replaced by a skeleton.
 */
export function SearchPage({
  search,
  serverSeeded = false,
}: {
  search: SalesSearchParams;
  serverSeeded?: boolean;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const pathname = usePublicPathname();
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const currentHref = queryString ? `${pathname}?${queryString}` : pathname;
  // Cartes ou tableau : lu dans l'adresse (`?view=table`), hors des filtres de la recherche.
  const resultsView = useResultsView();
  // The filters live in the URL: updating them rewrites the query string in place, without a
  // server round trip. Next.js keeps `useSearchParams` in sync with `history.replaceState`.
  // L'affichage (`view`) n'est pas un filtre : il est relu dans l'adresse courante et conservé.
  // `mode` : « push » ajoute une entrée à l'historique du navigateur (ouverture de la carte,
  // changement de page, filtre validé), pour que « Retour » la défasse au lieu de quitter le site ;
  // « replace » remplace l'adresse (saisie en cours : une frappe n'empile rien).
  const replaceSearch = useCallback(
    (record: SalesSearchUrlRecord, mode: HistoryMode = "replace") => {
      const url = pathWithSearch(pathname, keepCurrentResultsView(record));
      if (mode === "push") window.history.pushState(null, "", url);
      else window.history.replaceState(null, "", url);
    },
    [pathname],
  );
  // Une adresse qui porte une valeur ignorée (`minPrice=-5`, `maxPrice=1e30`, `page=1`) est
  // ramenée à ce que la recherche retient réellement : l'adresse partagée dit la même chose que
  // la liste affichée.
  useEffect(() => {
    const canonical = canonicalSalesQuery(new URLSearchParams(queryString));
    if (!canonical) return;
    const next = canonical.toString();
    window.history.replaceState(
      null,
      "",
      `${pathname}${next ? `?${next}` : ""}${window.location.hash}`,
    );
  }, [pathname, queryString]);
  const { user, loading: authLoading } = useAuth();
  const isPreview = !user;
  const searchRef = useRef(search);
  const viewportTimerRef = useRef<number | null>(null);
  const [hoveredSaleId, setHoveredSaleId] = useState<string | null>(null);
  const [selectedSaleId, setSelectedSaleId] = useState<string | null>(null);
  const [mapViewport, setMapViewport] = useState<MapViewportChange | null>(null);
  const [wideMap, setWideMap] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [mobileMapOpen, setMobileMapOpen] = useState(Boolean(search.map));
  // Fenêtre du comparateur : ouverte par la barre (bureau) ou par la pastille de la barre basse.
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [savingAlert, setSavingAlert] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [dpeExplorerOpen, setDpeExplorerOpen] = useState(false);
  const [statisticsOpen, setStatisticsOpen] = useState(false);
  const [draft, setDraft] = useState<SearchDraft>(() => searchToDraft(search));
  const latestSearchDraftRef = useRef<SearchDraft>(searchToDraft(search));
  const firstSearchDraftSync = useRef(true);
  const firstDraftSync = useRef(true);
  const mapTriggerRef = useRef<HTMLElement | null>(null);
  const [center, setCenter] = useState<GeoPoint | null>(null);
  const [geocoding, setGeocoding] = useState(false);
  const [locationCenter, setLocationCenter] = useState<(GeoPoint & { zoom?: number }) | null>(null);
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  // Sur bureau, la carte (mapbox-gl + points) ne se télécharge ni ne s'initialise qu'au premier
  // geste (appui, molette, toucher), au survol continu de sa zone ou au bouton « Afficher la carte »
  // (voir `useFirstGestureStart`, `MapPreview`, `DesktopMapZone`) ; son cadre est réservé dès que
  // l'écran est large.
  const [desktopMapStarted, setDesktopMapStarted] = useState(false);
  const mapVisible = mobileMapOpen || (isDesktop && desktopMapStarted);
  // Le tableau n'existe que sur écran large : en dessous, toujours les cartes.
  const displayedView = effectiveResultsView(resultsView, isDesktop);
  const geographicLabel = search.city || search.department || search.query || "";
  useEffect(() => {
    let cancelled = false;
    if (!mapVisible || !geographicLabel) {
      setLocationCenter(null);
      return;
    }
    const scope = resolveFrenchGeoSearch(geographicLabel);
    const administrative = scope.kind === "department" || scope.kind === "region";
    const label =
      scope.kind === "department"
        ? (departmentSearchValues(scope.departments).find(
            (value) => !scope.departments.includes(value),
          ) ?? geographicLabel)
        : geographicLabel;
    const request = administrative ? geocodeAdministrativeArea(label) : geocodeAddress(label);
    request.then((point) => {
      if (!cancelled)
        setLocationCenter(
          point
            ? {
                ...point,
                zoom: scope.kind === "region" ? 6 : scope.kind === "department" ? 7.5 : 10,
              }
            : null,
        );
    });
    return () => {
      cancelled = true;
    };
  }, [geographicLabel, mapVisible]);
  const page = search.page ?? 1;
  const pageSize = search.limit ?? DEFAULT_SEARCH_LIMIT;
  const pageOffset = (page - 1) * pageSize;

  useEffect(() => {
    searchRef.current = search;
  }, [search]);

  useEffect(() => {
    setMobileMapOpen(Boolean(search.map));
  }, [search.map]);

  const draftSignature = useMemo(() => JSON.stringify(draft), [draft]);
  const ownDraftNavigations = useRef(new Set<string>());
  const searchDraftSignature = useMemo(() => JSON.stringify(searchToDraft(search)), [search]);

  useEffect(() => {
    latestSearchDraftRef.current = searchToDraft(search);
  }, [search]);

  useEffect(() => {
    if (firstSearchDraftSync.current) {
      firstSearchDraftSync.current = false;
      return;
    }

    if (ownDraftNavigations.current.delete(searchDraftSignature)) return;
    setDraft(latestSearchDraftRef.current);
  }, [searchDraftSignature]);

  useEffect(() => {
    if (firstDraftSync.current) {
      firstDraftSync.current = false;
      return;
    }

    const timeout = window.setTimeout(() => {
      const nextSearch = draftToSearch(draft, searchRef.current);
      if (
        draft.city !== (searchRef.current.city ?? "") ||
        draft.query !== (searchRef.current.query ?? "") ||
        draft.department !== (searchRef.current.department ?? "")
      ) {
        nextSearch.viewport = undefined;
        nextSearch.searchAsMove = false;
      }
      const currentRecord = salesSearchToUrlRecord(searchRef.current);
      const nextRecord = salesSearchToUrlRecord(nextSearch);
      if (stableUrlRecord(currentRecord) === stableUrlRecord(nextRecord)) return;
      ownDraftNavigations.current.add(JSON.stringify(searchToDraft(nextSearch)));
      // Un choix (type de vente, case, classe…) est une étape de l'historique, une saisie non.
      replaceSearch(nextRecord, historyModeForDraftChange(searchToDraft(searchRef.current), draft));
    }, 320);

    return () => window.clearTimeout(timeout);
  }, [draft, draftSignature, replaceSearch]);

  useEffect(() => {
    if (!search.aroundAddress) {
      setCenter(null);
      return;
    }

    let cancelled = false;
    setGeocoding(true);
    geocodeAddress(search.aroundAddress).then((point) => {
      if (cancelled) return;
      setCenter(point);
      setGeocoding(false);
    });

    return () => {
      cancelled = true;
    };
  }, [search.aroundAddress]);

  useEffect(
    () => () => {
      if (viewportTimerRef.current != null) window.clearTimeout(viewportTimerRef.current);
    },
    [],
  );

  const searchKey = useMemo(() => salesSearchToUrlRecord(search), [search]);
  const searchKeySignature = useMemo(() => stableUrlRecord(searchKey), [searchKey]);
  const mapSearchKeySignature = useMemo(
    () => stableUrlRecord(salesSearchToUrlRecord({ ...search, page: undefined, limit: undefined })),
    [search],
  );
  const { data: entitlementsData, isLoading: entitlementsLoading } = useQuery({
    queryKey: queryKeys.featureEntitlementsPlan(user?.id ?? "anonymous"),
    queryFn: fetchAccessPlan,
    enabled: Boolean(user) && !authLoading,
    staleTime: 5 * 60_000,
  });
  const isDiscovery = Boolean(user) && entitlementsData?.plan.hasAnalysisAccess !== true;
  // Le tri par score d'investissement n'existe que dans l'offre Analyse.
  const investmentSortAllowed = !isPreview && !isDiscovery;
  const catalogReady = !authLoading && (isPreview || !entitlementsLoading);
  const comparisonScope = catalogReady
    ? `${user?.id ?? "anonymous"}:${isPreview ? "preview" : isDiscovery ? "discovery" : "analysis"}`
    : null;
  const comparison = useSaleComparison(comparisonScope);
  // While the session is restored, a server-seeded page reads the rows the
  // server rendered for the signed-out catalogue (same keys as the dehydrated
  // queries). They are replaced by the signed-in rows as soon as auth settles.
  const serverSeededScope = authLoading && serverSeeded ? ANONYMOUS_PREVIEW_SCOPE : null;
  const catalogScope = comparisonScope ?? serverSeededScope;

  const {
    data: connectedSales,
    error,
    errorUpdateCount: connectedFailures,
    isFetching,
    isLoading,
    isPlaceholderData,
    refetch: refetchSales,
  } = useQuery({
    queryKey: salesSearchQueryKey(searchKeySignature, catalogScope),
    placeholderData: (previous, query) =>
      catalogPlaceholder(previous, query?.queryKey, catalogScope),
    // Les copies de photos arrivent à part (plus bas) : la liste n'attend pas leur appel.
    queryFn: () =>
      fetchSearchResults({
        search,
        preview: isPreview,
        discovery: isDiscovery,
        withMirrors: false,
      }),
    enabled: catalogReady,
    staleTime: 60_000,
    // Pas de rafraîchissement en tâche de fond pour le visiteur anonyme : la route d'aperçu garde
    // déjà la réponse 2 à 5 minutes dans le CDN, et une relecture toutes les 60 s désactivait
    // « Page suivante » le temps de la requête.
    refetchInterval: isPreview ? false : 60_000,
  });

  const { data: connectedTotalCount, isLoading: isCountLoading } = useQuery({
    queryKey: salesSearchCountQueryKey(searchKeySignature, catalogScope),
    placeholderData: (previous, query) =>
      catalogPlaceholder(previous, query?.queryKey, catalogScope),
    queryFn: () => fetchSearchCount({ search, preview: isPreview, discovery: isDiscovery }),
    enabled: catalogReady,
    staleTime: 60_000,
    refetchInterval: isPreview ? false : 60_000,
  });

  // Liste publique servie dans le HTML pour cette recherche (cache lu sans requête). Un compte
  // reconnu la garde à l'écran, en mode aperçu, pendant la vérification de ses droits et le
  // chargement de sa liste ; elle est remplacée dès que la liste connectée arrive. Rien de réservé
  // n'y figure (c'est l'aperçu de tout visiteur) et aucun droit n'est décidé ici : le serveur
  // choisit ce que la liste connectée contient.
  const publicSales = isPreview
    ? undefined
    : queryClient.getQueryData<AuctionSale[]>(
        salesSearchQueryKey(searchKeySignature, ANONYMOUS_PREVIEW_SCOPE),
      );
  // Un échec de la liste connectée est retenu jusqu'au succès (`errorUpdateCount` survit au nouvel
  // essai, alors que `error` repasse à `null` pendant « Réessayer ») : la liste publique verrouillée
  // ne revient pas pendant le nouvel essai, qui montre un chargement puis la liste ou l'erreur.
  const connectedFailed = Boolean(error) || connectedFailures > 0;
  const publicListShown =
    !isPreview && connectedSales === undefined && !connectedFailed && !!publicSales;
  const listIsPublic = isPreview || publicListShown;
  const publicTotalCount = publicListShown
    ? queryClient.getQueryData<number>(
        salesSearchCountQueryKey(searchKeySignature, ANONYMOUS_PREVIEW_SCOPE),
      )
    : undefined;
  const totalCount = publicListShown ? publicTotalCount : connectedTotalCount;

  // Copies de photos de la liste connectée : un appel dès que les ventes sont lues (leurs photos en
  // viennent), posé sur la liste à son arrivée. Les copies déjà connues du navigateur s'appliquent
  // tout de suite. Aperçu anonyme : la route apporte déjà les copies.
  const connectedList = connectedSales ?? NO_SALES;
  const connectedIds = useMemo(() => connectedList.map((sale) => sale.id), [connectedList]);
  const { data: photoMirrors } = useQuery({
    queryKey: queryKeys.salesPhotoMirrors(catalogScope, connectedIds),
    queryFn: () => fetchSearchPhotoMirrors(connectedList),
    placeholderData: (previous) => previous,
    enabled: catalogReady && !isPreview && connectedList.length > 0 && isPhotoMirrorEnabled(),
    staleTime: 5 * 60_000,
    retry: false,
  });
  // Copies que la liste publique du serveur porte déjà (`media[].mirror`) : table URL d'origine vers
  // copie, posée tout de suite sur la liste connectée (qui arrive sans copie) et mémorisée par
  // `remember` pour les rafraîchissements. Sans cela, les photos retomberaient sur la source avant
  // de remonter sur la copie (clignotement).
  const publicMirrors = useMemo(
    () => (publicSales ? mirrorsFromSales(publicSales) : NO_PHOTO_MIRRORS),
    [publicSales],
  );
  const knownMirrors = useMemo(
    () =>
      photoMirrors?.size || publicMirrors.size
        ? new Map([...publicMirrors, ...(photoMirrors ?? NO_PHOTO_MIRRORS)])
        : NO_PHOTO_MIRRORS,
    [photoMirrors, publicMirrors],
  );
  const rawSales = useMemo(
    () =>
      publicListShown
        ? publicSales!
        : isPreview
          ? connectedList
          : applyPhotoMirrors(connectedList, knownMirrors, { remember: true }),
    [connectedList, isPreview, knownMirrors, publicListShown, publicSales],
  );

  const {
    data: rawMapSales = [],
    isLoading: isMapLoading,
    isFetching: isMapFetching,
  } = useQuery({
    queryKey: queryKeys.salesSearchMap(mapSearchKeySignature, comparisonScope),
    placeholderData: (previous, query) =>
      catalogPlaceholder(previous, query?.queryKey, comparisonScope),
    queryFn: () => fetchSearchMapResults(search, { discovery: isDiscovery }),
    enabled: catalogReady && !isPreview && mapVisible,
    // Tous les points de la recherche (quelques milliers de lignes légères) : on les rafraîchit
    // moins souvent qu'un échantillon.
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  const filteredSales = useMemo(
    () =>
      listIsPublic
        ? rawSales
        : sortClientSearchResults(
            applyClientSearchFilters(rawSales, search, center),
            search,
            center,
          ),
    [center, listIsPublic, rawSales, search],
  );

  const mappableSales = useMemo(
    () =>
      (!mapVisible
        ? []
        : listIsPublic
          ? rawSales
          : sortClientSearchResults(
              applyClientSearchFilters(rawMapSales.length ? rawMapSales : rawSales, search, center),
              search,
              center,
            )
      ).filter(hasCoordinates),
    [center, listIsPublic, mapVisible, rawMapSales, rawSales, search],
  );
  const mapSales = useMemo(() => mappableSales.slice(0, MAP_POINT_LIMIT), [mappableSales]);
  const mappablePointsTotal = mappableSales.length;

  // The map projection is intentionally lightweight. Fetch the complete row
  // only after an authenticated user selects a sale that is actually present
  // in the current map result set. Hovering, preview mode, and a hidden map
  // never trigger this request.
  const selectedMapSaleId =
    selectedSaleId && mapSales.some((sale) => sale.id === selectedSaleId) ? selectedSaleId : null;
  const { data: selectedMapSaleDetail, isFetching: selectedMapSaleDetailLoading } = useQuery({
    queryKey: queryKeys.salesMapDetail(comparisonScope, selectedMapSaleId),
    queryFn: () => getSaleById(selectedMapSaleId!, { discovery: isDiscovery }),
    enabled: Boolean(catalogReady && user && mapVisible && selectedMapSaleId && comparisonScope),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const mapListFollowsViewport = false;
  const displayedSales = filteredSales;
  const aiReviewSaleIds = useMemo(
    () => [...new Set([...displayedSales, ...mapSales].map((sale) => sale.id).filter(Boolean))],
    [displayedSales, mapSales],
  );
  const { data: aiReviewData, isError: aiReviewError } = useQuery({
    queryKey: queryKeys.salesAiReview(user?.id ?? "anonymous", aiReviewSaleIds),
    queryFn: () => fetchSalesAiReviewProjections(aiReviewSaleIds),
    // Discovery rows already use the public redacted view. The AI review
    // endpoint reads Analyse-only projections and must not blank valid public
    // city, price or date values for free users.
    enabled: Boolean(
      user && !authLoading && !listIsPublic && !isDiscovery && aiReviewSaleIds.length,
    ),
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
  const aiReviewStatus: AiReviewRequestStatus =
    !user || listIsPublic || isDiscovery || aiReviewSaleIds.length === 0
      ? "disabled"
      : aiReviewError
        ? "error"
        : aiReviewData
          ? "ready"
          : "loading";
  const hasLocalFilters = false;
  const isInitialLoading =
    !publicListShown && ((authLoading && !serverSeeded) || entitlementsLoading || isLoading);
  // Relecture de fond d'une liste déjà affichée (minuteur du compte connecté) : elle ne désactive
  // rien et ne s'annonce pas. Premier chargement, changement de page ou de filtre, nouvel essai :
  // la liste est occupée.
  const backgroundRefresh =
    isFetching && !isLoading && !isPlaceholderData && connectedSales !== undefined;
  const listBusy = isFetching && !backgroundRefresh;
  // Page ou taille de page refusée par la route (400) : ce n'est pas une panne du catalogue.
  const outOfRange = isOutOfRangeSearchError(error);
  // Au-delà de la page 1, la pagination l'explique et propose la page 1 ; page 1 (taille de page
  // refusée), le message de l'erreur s'affiche dans la liste.
  const pageOutOfRange = outOfRange && page > 1;
  const startDesktopMap = useCallback(() => setDesktopMapStarted(true), []);
  useFirstGestureStart({
    enabled: isDesktop && !desktopMapStarted,
    onStart: startDesktopMap,
  });
  const activeFiltersCount = countActiveSearchFilters(search);
  const activeFilters = useMemo(() => activeFilterChips(search), [search]);
  // Liste publique sans compteur public : on n'invente pas un total avec la longueur de la page
  // (24 au lieu de 2 276) ; l'en-tête annonce « Recherche en cours… » (voir `publicTotalMissing`).
  const publicTotalMissing = publicListShown && publicTotalCount === undefined;
  const displayCount = totalCount ?? (publicListShown ? 0 : filteredSales.length);
  const filteredCount = displayedSales.length;
  const hasMore =
    totalCount != null && pageOffset + rawSales.length < totalCount && rawSales.length >= pageSize;
  const hasPrevious = page > 1;
  // La pagination s'affiche dès qu'il y a une page à parcourir ou des résultats (voir SearchPagination).
  const paginationVisible = hasMore || hasPrevious || filteredCount > 0;
  // Total annoncé par le bouton de la fenêtre des filtres (« Afficher 1 646 annonces ») : seulement
  // quand les critères saisis sont déjà ceux de la liste et que celle-ci est à jour. Sinon le
  // bouton garde son libellé neutre plutôt que d'annoncer le total d'une autre recherche.
  const draftMatchesSearch = useMemo(
    () =>
      stableUrlRecord(
        salesSearchToUrlRecord({
          ...draftToSearch(draft, search),
          page: undefined,
          limit: undefined,
        }),
      ) === mapSearchKeySignature,
    [draft, mapSearchKeySignature, search],
  );
  const filtersResultCount =
    draftMatchesSearch && !listBusy && !isInitialLoading && !isCountLoading && totalCount != null
      ? totalCount
      : null;
  // Un tableau a besoin de largeur : sans « Agrandir la carte », les résultats prennent plus de place.
  const splitClass = wideMap
    ? "lg:grid-cols-[minmax(360px,38%)_minmax(0,1fr)]"
    : displayedView === "table"
      ? "lg:grid-cols-[minmax(0,66%)_minmax(0,34%)]"
      : "lg:grid-cols-[minmax(0,52%)_minmax(0,48%)]";
  const localSearchStatistics = useMemo(
    () => buildSearchStatistics(displayedSales),
    [displayedSales],
  );
  const statisticsLocked =
    isPreview || entitlementsData?.plan.features.salesStatistics !== "included";
  const dpeLocked = isPreview || entitlementsData?.plan.features.dpeExplorer !== "included";
  const csvExportLocked =
    isPreview || entitlementsData?.plan.features.salesCsvExport !== "included";
  const watchedZonesLocked =
    !user || !entitlementsData || entitlementsData.plan.features.watchedZones === "locked";
  const alertsLocked =
    !user || !entitlementsData || entitlementsData.plan.features.smartAlerts === "locked";
  const { data: notificationPreferences } = useQuery({
    queryKey: queryKeys.notificationPreferences(user?.id ?? "anonymous"),
    queryFn: fetchNotificationPreferences,
    enabled: Boolean(user) && !authLoading,
    staleTime: 60_000,
    retry: false,
  });
  const emailRecapEnabled = notificationPreferences?.preferences.alertEmailEnabled === true;
  const { data: salesStatisticsData, isFetching: salesStatisticsLoading } = useQuery({
    queryKey: queryKeys.salesStatistics(searchKeySignature),
    queryFn: () => fetchSalesStatistics({ search }),
    enabled: statisticsOpen && !statisticsLocked && !authLoading && Boolean(user),
    retry: false,
    staleTime: 2 * 60_000,
  });
  const searchStatistics = useMemo(
    () =>
      salesStatisticsData
        ? searchStatisticsFromServer(salesStatisticsData.summary)
        : localSearchStatistics,
    [localSearchStatistics, salesStatisticsData],
  );
  const statisticsLoading =
    isInitialLoading || (!statisticsLocked && salesStatisticsLoading && !salesStatisticsData);
  const {
    data: dpeExplorerData,
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

  const updateSearch = useCallback(
    (patch: Partial<SalesSearchParams>, mode: HistoryMode = "replace") => {
      const next = mergeSalesSearch(searchRef.current, patch);
      replaceSearch(salesSearchToUrlRecord(next), mode);
    },
    [replaceSearch],
  );
  // Un choix de la personne (tri, critère retiré, page) est une étape de l'historique.
  const chooseSearch = useCallback(
    (patch: Partial<SalesSearchParams>) => updateSearch(patch, "push"),
    [updateSearch],
  );

  const resetFilters = useCallback(() => {
    setDraft(emptySearchDraft());
    replaceSearch(salesSearchToUrlRecord({ sort: search.sort }), "push");
  }, [replaceSearch, search.sort]);

  const previousPageRef = useRef(page);
  useEffect(() => {
    if (previousPageRef.current === page || listBusy || isInitialLoading) return;
    previousPageRef.current = page;
    const results = document.getElementById("sales-results");
    results?.scrollIntoView({ block: "start", behavior: "instant" });
    results?.focus({ preventScroll: true });
  }, [page, listBusy, isInitialLoading]);

  // Address of another page of the same search (`/sales?…&page=N`, page 1 without `page`): the
  // pagination renders real links with it. The canonical stays `/sales` (see sales/page.tsx).
  const pageHref = (targetPage: number): string | undefined =>
    targetPage < 1
      ? undefined
      : pathWithSearch(
          pathname,
          withResultsView(
            salesSearchToUrlRecord(mergeSalesSearch(search, { page: targetPage })),
            resultsView,
          ),
        );

  const changeResultsView = useCallback(
    (view: ResultsView) => {
      window.history.replaceState(
        null,
        "",
        pathWithSearch(pathname, withResultsView(salesSearchToUrlRecord(searchRef.current), view)),
      );
    },
    [pathname],
  );

  const loadNextPage = useCallback(() => {
    if (!hasMore || listBusy) return;
    chooseSearch({ page: page + 1 });
  }, [chooseSearch, hasMore, listBusy, page]);

  const loadPreviousPage = useCallback(() => {
    if (!hasPrevious || listBusy) return;
    chooseSearch({ page: page - 1 });
  }, [chooseSearch, hasPrevious, listBusy, page]);

  const goToPage = useCallback(
    (targetPage: number) => {
      if (listBusy) return;
      chooseSearch({ page: targetPage });
    },
    [chooseSearch, listBusy],
  );

  // Carte mobile : l'ouvrir ajoute une entrée à l'historique, « Retour » la referme. La refermer
  // par le bouton « Liste » défait cette entrée (au lieu d'en empiler une) quand c'est nous qui
  // l'avons ajoutée ; une adresse ouverte directement sur la carte se referme sans quitter la page.
  const mapOpenedByUsRef = useRef(false);
  const openMobileMap = useCallback(() => {
    mapOpenedByUsRef.current = true;
    updateSearch({ map: true }, "push");
  }, [updateSearch]);
  const closeMobileMap = useCallback(() => {
    if (mapOpenedByUsRef.current) {
      mapOpenedByUsRef.current = false;
      window.history.back();
      return;
    }
    updateSearch({ map: false });
  }, [updateSearch]);
  useEffect(() => {
    if (!search.map) mapOpenedByUsRef.current = false;
  }, [search.map]);

  const handleMapSelect = useCallback((saleId: string) => {
    setSelectedSaleId(saleId);
    window.setTimeout(() => scrollToSaleCard(saleId), 40);
  }, []);

  const handleViewportChange = useCallback(
    (viewport: MapViewportChange) => {
      setMapViewport((current) =>
        current && areMapViewportsClose(current, viewport) ? current : viewport,
      );

      if (isPreview || !searchRef.current.searchAsMove) return;
      if (viewportTimerRef.current != null) window.clearTimeout(viewportTimerRef.current);
      viewportTimerRef.current = window.setTimeout(() => {
        updateSearch({ viewport: viewport.bounds });
      }, 520);
    },
    [isPreview, updateSearch],
  );

  const handleSearchAsMoveChange = useCallback(
    (enabled: boolean) => {
      updateSearch({
        searchAsMove: enabled,
        viewport: enabled ? mapViewport?.bounds : undefined,
      });
    },
    [mapViewport, updateSearch],
  );

  const mapPanelProps = {
    sales: mapSales,
    geographicLabel,
    onSearchViewport: () => {
      if (!isPreview && mapViewport) updateSearch({ viewport: mapViewport.bounds });
    },
    locationCenter,
    totalCount,
    mappablePointsTotal,
    hoveredSaleId,
    selectedSaleId,
    selectedSaleDetail:
      selectedMapSaleDetail?.id === selectedMapSaleId ? selectedMapSaleDetail : null,
    selectedSaleDetailLoading: Boolean(selectedMapSaleId && selectedMapSaleDetailLoading),
    isLoading: isInitialLoading || isMapLoading || isMapFetching,
    searchAsMove: !isPreview && Boolean(search.searchAsMove),
    preview: listIsPublic,
    showDpeLegend: !dpeLocked,
    aiReviewBySaleId,
    aiReviewStatus,
    onHover: setHoveredSaleId,
    onSelect: handleMapSelect,
    onViewportChange: handleViewportChange,
    onSearchAsMoveChange: handleSearchAsMoveChange,
    // Sur mobile la carte recouvre la liste : « Voir la liste » la referme.
    onShowList: () => {
      if (!isDesktop) closeMobileMap();
    },
  };

  /**
   * A feature reserved to Analyse: send the person to the offers page only when the
   * subscription can really be bought, otherwise explain instead of leading to a dead end.
   */
  async function explainReservedFeature(reservedMessage: string) {
    if (await isAnalysisOfferOpen()) {
      toast.message(reservedMessage);
      router.push(OFFERS_PATH);
      return;
    }
    toast.message(`${reservedMessage} L'abonnement Analyse n'est pas encore ouvert.`);
  }

  async function saveSearch(options?: SaveSearchOptions) {
    // Session en cours de vérification : `user` est encore vide, sans que la personne soit
    // déconnectée. L'envoyer se connecter la ferait créer un compte qu'elle a déjà.
    if (authLoading) {
      toast.message("Vérification de votre compte en cours. Réessayez dans un instant.");
      return;
    }
    if (!user) {
      // La première alerte est gratuite : on invite à créer un compte puis on
      // ramène la personne sur sa recherche.
      router.push(loginPathWithRedirect(currentHref, { reason: "alerte" }));
      return;
    }
    if (entitlementsLoading || !entitlementsData) {
      toast.message("Vérification de votre compte en cours. Réessayez dans un instant.");
      return;
    }
    if (alertsLocked) {
      await explainReservedFeature(
        "Les alertes de cette recherche sont réservées à l'offre Analyse.",
      );
      return;
    }
    if (activeFiltersCount === 0) {
      toast.error("Ajoutez au moins un filtre avant d'enregistrer");
      return;
    }

    if (
      !entitlementsData?.plan.hasAnalysisAccess &&
      (search.query ||
        search.occupancy ||
        search.minScore != null ||
        search.minYield != null ||
        search.minMarketDiscount != null ||
        search.dpeClasses?.length ||
        search.houseWithLand)
    ) {
      toast.error(
        "L'alerte gratuite accepte les critères publics : zone, type de vente, type de bien, budget et surface.",
      );
      return;
    }
    setSavingAlert(true);
    try {
      const watchedZoneInput = watchedZonesLocked
        ? null
        : await watchedZoneInputFromSearch(search, center);
      const watchedZoneResponse = watchedZoneInput
        ? await createWatchedZoneRequest({ data: watchedZoneInput })
        : null;

      await createAlert(user.id, {
        name: buildAlertName(search),
        department: search.department || null,
        city: search.city || null,
        property_type: search.homeTypes?.length === 1 ? search.homeTypes[0] : null,
        max_price_eur: search.maxPrice ?? null,
        min_surface_m2: search.minSqft ?? null,
        occupancy_status: search.occupancy || null,
        min_investment_score: search.minScore ?? null,
        max_price_per_m2: search.maxPricePerM2 ?? null,
        min_yield_pct: search.minYield ?? null,
        min_market_discount_pct: search.minMarketDiscount ?? null,
        dpe_classes: search.dpeClasses ?? [],
        require_house_with_land: Boolean(search.houseWithLand),
        alert_frequency:
          options?.frequency ?? (entitlementsData?.plan.hasAnalysisAccess ? "daily" : "weekly"),
        watched_zone_id: watchedZoneResponse?.zone.id ?? null,
        advanced_criteria: {
          source: "sales_search",
          min_sale_date: search.minSaleDate ?? null,
          max_sale_date: search.maxSaleDate ?? null,
          sale_type: search.saleType ?? null,
          query: search.query ?? null,
          around_address: search.aroundAddress ?? null,
          around_radius_km: search.aroundRadius ?? null,
          watched_zone_id: watchedZoneResponse?.zone.id ?? null,
        },
      });
      const saved = watchedZoneResponse
        ? "Zone surveillée et alerte créées"
        : "Recherche enregistrée";
      let emailConsent = emailRecapEnabled;
      if (options?.emailRecap && !emailRecapEnabled) {
        // Le consentement est explicite (case non pré-cochée) et horodaté côté serveur.
        if (await enableAlertEmailRecap(queryClient, user.id)) {
          emailConsent = true;
          toast.success(`${saved}. Email récapitulatif activé.`);
        } else {
          toast.error(
            `${saved}, mais l'email récapitulatif n'a pas pu être activé. Réessayez depuis la cloche des notifications.`,
          );
        }
      } else {
        toast.success(saved);
      }
      trackProductEvent("alert_created", { email_consent: emailConsent });
    } catch (saveError) {
      toast.error(userMessage(saveError));
    } finally {
      setSavingAlert(false);
    }
  }

  async function exportCsv() {
    if (authLoading) {
      toast.message("Vérification de votre compte en cours. Réessayez dans un instant.");
      return;
    }
    if (!user) {
      router.push(loginPathWithRedirect(currentHref, { reason: "export" }));
      return;
    }
    if (entitlementsLoading || !entitlementsData) {
      toast.message("Vérification de votre compte en cours. Réessayez dans un instant.");
      return;
    }
    if (csvExportLocked) {
      await explainReservedFeature("L'export CSV est réservé à l'offre Analyse.");
      return;
    }

    setExportingCsv(true);
    try {
      const { blob, filename } = await exportSalesCsv({ search });
      downloadBlob(blob, filename);
      toast.success("Export CSV prêt");
    } catch (exportError) {
      toast.error(userMessage(exportError, "Export impossible"));
    } finally {
      setExportingCsv(false);
    }
  }

  return (
    <main
      id="contenu"
      className="min-h-screen bg-surface-muted text-brand-navy [--sales-header-height:8rem] lg:[--sales-header-height:8rem]"
    >
      <a href="#sales-results" className={SKIP_LINK_CLASSES}>
        Aller aux résultats
      </a>
      {paginationVisible ? (
        <a href={`#${SALES_PAGINATION_ID}`} className={SKIP_LINK_CLASSES}>
          Aller à la pagination
        </a>
      ) : null}
      {isDesktop ? (
        <a href={`#${DESKTOP_MAP_ZONE_ID}`} className={SKIP_LINK_CLASSES}>
          Aller à la carte
        </a>
      ) : null}

      <SearchHeader
        draft={draft}
        setDraft={setDraft}
        activeFiltersCount={activeFiltersCount}
        isLoading={isInitialLoading}
        isFetching={listBusy}
        filtersOpen={filtersOpen}
        savingAlert={savingAlert}
        exportingCsv={exportingCsv}
        csvExportLocked={csvExportLocked}
        signedIn={Boolean(user)}
        dailyAlertsAllowed={entitlementsData?.plan.hasAnalysisAccess === true}
        emailRecapEnabled={emailRecapEnabled}
        wideMap={wideMap}
        isDesktop={isDesktop}
        onFiltersOpenChange={setFiltersOpen}
        onReset={resetFilters}
        onSaveSearch={saveSearch}
        onExportCsv={exportCsv}
        onToggleLayout={() => setWideMap((value) => !value)}
      />

      <div
        className={`grid min-h-[calc(100svh_-_var(--sales-header-height))] grid-cols-1 ${splitClass}`}
      >
        <section
          id="sales-results"
          tabIndex={-1}
          // L'en-tête ne colle à l'écran qu'à partir de lg : en dessous, rien à dégager.
          className="min-w-0 scroll-mt-3 bg-surface-muted lg:order-1 lg:scroll-mt-[calc(var(--sales-header-height)+12px)] lg:border-r lg:border-line-soft"
          aria-label="Résultats de recherche"
          aria-busy={listBusy}
        >
          <div className="flex flex-wrap items-center justify-between gap-1 border-b border-line-soft bg-white pr-4">
            <ResultsSummary
              search={search}
              displayCount={displayCount}
              hasLocalFilters={hasLocalFilters}
              isLoading={
                isInitialLoading || publicTotalMissing || (isCountLoading && !publicListShown)
              }
              hasError={Boolean(error) && !pageOutOfRange && rawSales.length === 0}
              geocoding={geocoding}
              refreshing={listBusy && !isInitialLoading}
            />

            <div className="flex flex-wrap items-center gap-2 px-4 pb-2 sm:px-0">
              <SortDropdown
                preview={isPreview}
                hasCenter={Boolean(center)}
                investmentScore={investmentSortAllowed}
                sort={visibleSearchSort(search.sort, {
                  allowInvestmentScore: investmentSortAllowed,
                })}
                onChange={(sort) => chooseSearch({ sort })}
              />
              <SortByDateShortcut
                sort={visibleSearchSort(search.sort, {
                  allowInvestmentScore: investmentSortAllowed,
                })}
                onChange={(sort) => chooseSearch({ sort })}
              />
              <ResultsViewToggle view={resultsView} onChange={changeResultsView} />
            </div>
          </div>
          <RankingExplanation investmentScore={investmentSortAllowed} />
          <div className="border-b border-line-soft bg-white px-4 py-3 sm:px-5">
            <SaleTypeFilter
              compact
              value={draft.saleType}
              onChange={(saleType) =>
                setDraft((current) => ({
                  ...current,
                  saleType,
                  tribunal: !saleType || saleType === "tribunal" ? current.tribunal : "",
                }))
              }
            />
          </div>
          <SaleComparisonBar
            key={comparisonScope ?? "loading"}
            items={comparison.items}
            returnTo={currentHref}
            userId={user?.id ?? null}
            onRemove={comparison.remove}
            onClear={comparison.clear}
            onRestore={comparison.replace}
            open={comparisonOpen}
            onOpenChange={setComparisonOpen}
            hideWhenEmpty
          />

          <SearchResultsList
            sales={displayedSales}
            returnTo={currentHref}
            locked={listIsPublic}
            analysisLocked={isDiscovery && !publicListShown}
            isLoading={isInitialLoading}
            error={pageOutOfRange ? null : error}
            onRetry={() => void refetchSales()}
            selectedSaleId={selectedSaleId}
            hoveredSaleId={hoveredSaleId}
            onHover={setHoveredSaleId}
            onSelect={setSelectedSaleId}
            comparedSaleIds={comparison.items.map((item) => item.id)}
            comparisonDisabled={!catalogReady}
            onToggleComparison={comparison.toggle}
            aiReviewBySaleId={aiReviewBySaleId}
            aiReviewStatus={aiReviewStatus}
            activeFilters={activeFilters}
            onRemoveFilter={(filter) => chooseSearch(filter.clear)}
            onResetFilters={resetFilters}
            onShowFrance={
              hasGeographicFilter(search) ? () => chooseSearch(WHOLE_FRANCE_PATCH) : undefined
            }
            hideEmptyState={page > 1}
            view={displayedView}
            // Encart des avocats : en fin de liste, sur la première page seulement.
            sponsoredPlacement={
              page === 1 ? (
                <SearchLawyerPlacement
                  geographicLabel={geographicLabel}
                  city={search.city}
                  department={search.department}
                />
              ) : undefined
            }
          />

          <SearchPagination
            hasMore={hasMore}
            hasPrevious={hasPrevious}
            isFetching={listBusy}
            loadedCount={filteredCount}
            totalCount={mapListFollowsViewport ? displayCount : totalCount}
            mapListFollowsViewport={mapListFollowsViewport}
            page={page}
            pageSize={pageSize}
            onNext={loadNextPage}
            onPrevious={loadPreviousPage}
            nextHref={pageHref(page + 1)}
            previousHref={pageHref(page - 1)}
            pageHref={pageHref}
            onGoToPage={goToPage}
            onFirstPage={() => chooseSearch({ page: 1 })}
            firstHref={pageHref(1)}
            outOfRange={outOfRange}
          />

          <details
            className="mx-4 mt-3 rounded-lg border border-line-soft bg-white sm:mx-5"
            onToggle={(event) => setStatisticsOpen(event.currentTarget.open)}
          >
            <summary className="cursor-pointer px-4 py-2 text-sm font-medium">
              Repères sur cette recherche
            </summary>
            {statisticsOpen ? (
              <LazySearchStatisticsPanel
                statistics={searchStatistics}
                locked={statisticsLocked}
                signedIn={Boolean(user)}
                dpeLocked={dpeLocked}
                loading={entitlementsLoading || statisticsLoading}
                dpeExplorer={dpeExplorerData}
                dpeExplorerLoading={dpeExplorerLoading}
                dpeExplorerError={dpeExplorerError ? userMessage(dpeExplorerError) : null}
                dpeExplorerRequested={dpeExplorerOpen}
                onLoadDpeExplorer={() => {
                  setDpeExplorerOpen(true);
                  if (dpeExplorerOpen) void refetchDpeExplorer();
                }}
              />
            ) : null}
          </details>
          <Footer />
        </section>

        {/* Always rendered (hidden below lg): the two-column layout is decided by CSS
            alone, so nothing shifts when the media query resolves after hydration. */}
        <aside className="relative hidden min-h-[calc(100svh_-_var(--sales-header-height))] bg-line-soft lg:order-2 lg:block">
          {isDesktop ? (
            <DesktopMapZone started={desktopMapStarted} onStart={startDesktopMap}>
              <LazyMapPanel {...mapPanelProps} />
            </DesktopMapZone>
          ) : null}
        </aside>
      </div>

      {filtersOpen ? (
        <LazyMoreFiltersModal
          open={filtersOpen}
          analysisLocked={isPreview || isDiscovery}
          preview={isPreview}
          draft={draft}
          setDraft={setDraft}
          activeFiltersCount={activeFiltersCount}
          resultCount={filtersResultCount}
          onClose={() => setFiltersOpen(false)}
          onReset={resetFilters}
        />
      ) : null}

      <MobileMapToggle
        activeFiltersCount={activeFiltersCount}
        comparedCount={comparison.items.length}
        onOpenFilters={() => setFiltersOpen(true)}
        onOpenComparison={() => setComparisonOpen(true)}
        // Le module de la carte (et Mapbox GL) se télécharge dès l'appui, pendant que le doigt se
        // relève : la carte est prête, ou presque, au moment du clic.
        onPreloadMap={preloadMapModules}
        onOpenMap={openMobileMap}
      />

      <DialogPrimitive.Root
        open={mobileMapOpen && !isDesktop}
        onOpenChange={(open) => {
          if (!open) closeMobileMap();
        }}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Content
            aria-describedby={undefined}
            onOpenAutoFocus={() => {
              mapTriggerRef.current = document.activeElement as HTMLElement;
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              mapTriggerRef.current?.focus();
            }}
            className="fixed inset-0 z-50 bg-surface-tint outline-none"
          >
            <DialogPrimitive.Title className="sr-only">Carte des annonces</DialogPrimitive.Title>
            <div className="absolute inset-x-0 top-0 z-10 flex h-14 items-center justify-between border-b border-brand-navy/10 bg-white/95 px-3 backdrop-blur">
              <button
                type="button"
                onClick={closeMobileMap}
                className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-md border border-line-soft bg-white px-3 text-sm font-bold text-brand-navy shadow-sm"
              >
                <X className="h-4 w-4" />
                Liste
              </button>
              {/* Titre court : la phrase qui explique la limite est dans la légende de la carte. */}
              <span className="text-sm font-bold text-ink-strong">
                {mappablePointsTotal > mapSales.length
                  ? `${mapSales.length.toLocaleString("fr-FR")} sur ${mappablePointsTotal.toLocaleString("fr-FR")} biens`
                  : `${mapSales.length.toLocaleString("fr-FR")} biens sur la carte`}
              </span>
            </div>
            <div className="h-full pt-14">
              <LazyMapPanel {...mapPanelProps} />
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </main>
  );
}
