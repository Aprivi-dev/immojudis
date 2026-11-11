"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import List from "lucide-react/dist/esm/icons/list.js";
import { toast } from "@/lib/toast";
import { AuthConnectionBanner } from "@/components/AuthConnectionBanner";
import { useAuth } from "@/hooks/use-auth";
import { ACCOUNT_CHECK_PENDING_TEXT, useCreateAlert } from "@/hooks/use-create-alert";
import { useSaleComparison } from "@/hooks/use-sale-comparison";
import { useRouter, useSearchParams } from "next/navigation";
import { usePublicPathname } from "@/hooks/use-public-pathname";
import { exportSalesCsv, fetchAccessPlan } from "@/lib/client-api";
import { applyPhotoMirrors, isPhotoMirrorEnabled, mirrorsFromSales } from "@/lib/photo-mirror";
import type { AuctionSale, SaleMediaMirror } from "@/lib/types";
import { loginPathWithRedirect, pathWithSearch } from "@/lib/navigation";
import { geocodeAddress, geocodeAdministrativeArea, type GeoPoint } from "@/lib/geo";
import { departmentSearchValues, resolveFrenchGeoSearch } from "@/lib/search/french-geo-search";
import type { AiReviewRequestStatus } from "@/lib/ai-review-guard";
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
import {
  aroundAddressCenter,
  aroundAddressMachine,
  isLocatingAroundAddress,
} from "@/lib/search/around-address-machine";
import {
  ANONYMOUS_PREVIEW_SCOPE,
  catalogPlaceholder,
  salesSearchCountQueryKey,
  salesSearchQueryKey,
} from "@/lib/search/catalog-placeholder";
import {
  canonicalSalesQuery,
  mergeSalesSearch,
  salesSearchSignature,
  salesSearchToUrlRecord,
  type SalesSearchParams,
  type SalesSearchUrlRecord,
} from "@/lib/search/search-url-state";
import { parisToday, upcomingWeekScope } from "@/lib/search/sales-week";
import { isOutOfRangeSearchError } from "@/lib/search/search-errors";
import {
  fetchPepiteFloodExposedIds,
  fetchPepiteSaleIds,
  pepitesActive as hasPepites,
} from "@/lib/search/pepite-filter";
import {
  fetchSearchCount,
  fetchSearchMapResults,
  fetchSearchPhotoMirrors,
  fetchSearchResults,
} from "@/lib/search/search-service";
import type { MapViewportChange } from "./MapPanel";
import { FiltersLoadingFallback } from "./FiltersLoadingFallback";
import { SALES_PAGINATION_ID, SearchPagination, searchTotalPages } from "./SearchPagination";
import { scrollToSaleCard } from "./scroll-to-sale-card";
import { DESKTOP_MAP_ZONE_ID, DesktopMapZone } from "./DesktopMapZone";
import { LazyMapPanel } from "./LazyMapPanel";
import { preloadMapModules } from "./preload-map";
import { useRestoreSaleCard } from "./use-restore-sale-card";
import { useCompareFromAddress } from "./use-compare-from-address";
import { useFirstGestureStart } from "./use-first-gesture-start";
import { WHOLE_FRANCE_PATCH, activeFilterChips, hasGeographicFilter } from "./active-filter-chips";
import { Footer, MobileMapToggle } from "./SearchFilters";
import {
  CsvExportButton,
  FREE_ALERT_LIMIT,
  LayoutToggle,
  ResultsSummary,
  ResultsViewToggle,
  SalesSiteHeader,
  SaveSearchButton,
  SearchHeader,
  SortDropdown,
  type SaveSearchOptions,
} from "./SearchHeader";
import { ResultsHelp } from "./ResultsHelp";
import { SalesCatalogueHead } from "./SalesCatalogueHead";
import { SearchResultsList } from "./SearchResults";
import { FEW_RESULTS_ALERT_THRESHOLD, SectorAlertPrompt } from "./SectorAlertPrompt";
import { useSearchAccountData, useSearchStatisticsData } from "./use-search-account-data";
import { SaleComparisonBar } from "./SaleComparisonBar";
import { SearchLawyerPlacement } from "./SearchLawyerPlacement";
import type { FollowedCardData } from "./FollowedSalesSummary";
import {
  SearchDraft,
  downloadBlob,
  draftToSearch,
  emptySearchDraft,
  historyModeForDraftChange,
  searchToDraft,
  stableUrlRecord,
  type HistoryMode,
  useMediaQuery,
  useResultsView,
} from "./search-page-state";
import { trackProductEvent } from "@/lib/product-events";
import { userMessage } from "@/lib/user-messages";
import * as queryKeys from "@/lib/query-keys";
import { capMapPoints } from "@/lib/search/map-points";

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

// « Mon démarrage » : chargée pour un compte connecté seulement (aucun octet de plus pour un visiteur).
const LazyMonDemarrage = dynamic(
  () => import("@/components/MonDemarrage").then((mod) => mod.MonDemarrage),
  {
    ssr: false,
  },
);

// « Votre suivi » : chargé pour un abonné de l'offre Analyse seulement.
const LazyFollowedSalesPanel = dynamic(
  () => import("./FollowedSalesSummary").then((mod) => mod.FollowedSalesPanel),
  { ssr: false },
);

const LazySearchStatisticsPanel = dynamic(
  () => import("./SearchStatisticsPanel").then((mod) => mod.SearchStatisticsPanel),
  { loading: () => <SearchStatisticsLoading /> },
);

/**
 * `serverSeeded` is true when the server already rendered (and dehydrated) the
 * anonymous first page for this exact search. The list then stays visible while
 * the session is being restored instead of being replaced by a skeleton.
 *
 * `serverToday` : jour de Paris du rendu serveur, pour « dont M cette semaine » du titre ; repris
 * à l'hydratation, puis remplacé par le jour du navigateur.
 */
export function SearchPage({
  search,
  serverSeeded = false,
  serverToday,
}: {
  search: SalesSearchParams;
  serverSeeded?: boolean;
  serverToday?: string;
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
  // Bornes inversées (`minPrice=500000&maxPrice=100000`) : échangées à l'arrivée sur la page seulement.
  // Pendant la saisie, l'adresse suit les champs tels qu'ils sont tapés (un minimum provisoirement
  // au-dessus du maximum) et le message de la fourchette le dit : on n'échange pas les champs sous les doigts.
  const canonicalChecked = useRef(false);
  useEffect(() => {
    const arrival = !canonicalChecked.current;
    canonicalChecked.current = true;
    const canonical = canonicalSalesQuery(new URLSearchParams(queryString), {
      swapInvertedRanges: arrival,
    });
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
  // Bouton qui a ouvert la fenêtre des filtres : le focus y revient à sa fermeture (Échap compris).
  const filtersTriggerRef = useRef<HTMLElement | null>(null);
  const changeFiltersOpen = useCallback((open: boolean, trigger?: HTMLElement) => {
    if (open && trigger) filtersTriggerRef.current = trigger;
    setFiltersOpen(open);
  }, []);
  const [mobileMapOpen, setMobileMapOpen] = useState(Boolean(search.map));
  // Fenêtre du comparateur : ouverte par la barre (bureau) ou par la pastille de la barre basse.
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [dpeExplorerOpen, setDpeExplorerOpen] = useState(false);
  const [statisticsOpen, setStatisticsOpen] = useState(false);
  // Fenêtre de création d'alerte ouverte au moins une fois (lecture de l'usage de l'alerte gratuite).
  const [alertDialogOpened, setAlertDialogOpened] = useState(false);
  const [draft, setDraft] = useState<SearchDraft>(() => searchToDraft(search));
  const latestSearchDraftRef = useRef<SearchDraft>(searchToDraft(search));
  const firstSearchDraftSync = useRef(true);
  const firstDraftSync = useRef(true);
  const mapTriggerRef = useRef<HTMLElement | null>(null);
  // Adresse d'une recherche « autour de » : le centre est rangé avec l'adresse qu'il localise
  // (`around-address-machine.ts`), il ne survit donc ni à son effacement ni à son remplacement.
  const [aroundAddress, dispatchAroundAddress] = useReducer(
    aroundAddressMachine.transition,
    aroundAddressMachine.initial,
  );
  // `useMemo` : le centre est un objet. Sans lui, le compilateur React ne sait pas qu'il reste le
  // même d'un rendu à l'autre et renonce à optimiser la page (règle `preserve-manual-memoization`).
  const center = useMemo(() => aroundAddressCenter(aroundAddress), [aroundAddress]);
  const geocoding = isLocatingAroundAddress(aroundAddress);
  const [locationCenter, setLocationCenter] = useState<(GeoPoint & { zoom?: number }) | null>(null);
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  // Sur bureau, la carte (mapbox-gl + points) ne se télécharge ni ne s'initialise qu'au premier
  // geste fait DANS sa zone (appui, molette, toucher) ou au bouton « Afficher la carte » (voir
  // `useFirstGestureStart`, `MapPreview`, `DesktopMapZone`) : ni le défilement de la liste, ni le
  // survol ne la démarrent, car chaque chargement est facturé. Son cadre est réservé dès que l'écran
  // est large. Sur mobile, elle suit l'ouverture de la fenêtre de carte (`?map=true`). Une adresse
  // qui arrive avec `?map=true` est une demande explicite (lien partagé) : sur bureau, la carte
  // démarre alors sans attendre un geste.
  const [desktopMapStarted, setDesktopMapStarted] = useState(() => Boolean(search.map));
  const mapVisible = isDesktop ? desktopMapStarted : mobileMapOpen;
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
    // Plusieurs départements : aucun centre unique, la carte garde le cadrage des résultats.
    if (scope.kind === "department" && scope.departments.length > 1) {
      setLocationCenter(null);
      return;
    }
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
    const address = search.aroundAddress || null;
    dispatchAroundAddress({ type: "ADDRESS_CHANGED", address });
    if (!address) return;

    let cancelled = false;
    // Un géocodeur en panne vaut « adresse introuvable » : la recherche continue sans centre.
    geocodeAddress(address)
      .catch(() => null)
      .then((point) => {
        if (!cancelled) dispatchAroundAddress({ type: "RESOLVED", address, point });
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
  const {
    data: entitlementsData,
    isLoading: entitlementsLoading,
    isPending: entitlementsPending,
  } = useQuery({
    queryKey: queryKeys.featureEntitlementsPlan(user?.id ?? "anonymous"),
    queryFn: fetchAccessPlan,
    enabled: Boolean(user) && !authLoading,
    staleTime: 5 * 60_000,
  });
  const hasAnalysisAccess = entitlementsData?.plan.hasAnalysisAccess === true;
  const isDiscovery = Boolean(user) && !hasAnalysisAccess;
  // Le tri par score d'investissement n'existe que dans l'offre Analyse.
  const investmentSortAllowed = !isPreview && !isDiscovery;
  // `isPending`, pas `isLoading` : au rendu où le compte vient d'être reconnu, la requête des droits
  // est activée mais pas encore partie (`isLoading` faux) ; le catalogue partait alors comme pour
  // un compte Découverte, avant de connaître les droits.
  const catalogReady = !authLoading && (isPreview || !entitlementsPending);
  const comparisonScope = catalogReady
    ? `${user?.id ?? "anonymous"}:${isPreview ? "preview" : isDiscovery ? "discovery" : "analysis"}`
    : null;
  const comparison = useSaleComparison(comparisonScope);
  // « Comparer » d'une fiche : `/sales?comparer=<id>` ajoute la vente à la comparaison.
  useCompareFromAddress({
    scope: comparisonScope,
    signedIn: !isPreview,
    discovery: isDiscovery,
    items: comparison.items,
    toggle: comparison.toggle,
  });
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

  // « dont M cette semaine » (titre) : la même recherche bornée aux sept prochains jours, comptée à
  // part (voir `upcomingWeekScope`). Le jour vient du serveur pour l'hydratation, puis du navigateur.
  const [today, setToday] = useState(() => serverToday ?? parisToday());
  useEffect(() => setToday(parisToday()), []);
  const week = useMemo(() => upcomingWeekScope(search, today), [search, today]);
  const weekSignature = week.kind === "count" ? salesSearchSignature(week.search) : "";
  const { data: connectedWeekCount } = useQuery({
    queryKey: salesSearchCountQueryKey(weekSignature, catalogScope),
    placeholderData: (previous, query) =>
      catalogPlaceholder(previous, query?.queryKey, catalogScope),
    queryFn: () =>
      week.kind === "count"
        ? fetchSearchCount({ search: week.search, preview: isPreview, discovery: isDiscovery })
        : 0,
    enabled: catalogReady && week.kind === "count",
    staleTime: 60_000,
    refetchInterval: isPreview ? false : 60_000,
    retry: false,
  });
  const weekCount =
    week.kind === "none"
      ? 0
      : week.kind === "unavailable"
        ? null
        : ((publicListShown
            ? queryClient.getQueryData<number>(
                salesSearchCountQueryKey(weekSignature, ANONYMOUS_PREVIEW_SCOPE),
              )
            : connectedWeekCount) ?? null);

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
    isPlaceholderData: isMapPlaceholder,
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

  // Pépites : la liste publique des identifiants, lue UNE fois (gardée 5 minutes), jamais une fois par carte.
  // Vide tant que le repère n'est pas ouvert (mode « on ») ou en cas de panne : ni pastille, ni filtre.
  const { data: pepiteSaleIds } = useQuery({
    queryKey: queryKeys.pepiteSaleIds(),
    queryFn: () => fetchPepiteSaleIds(),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const pepitesActive = hasPepites(pepiteSaleIds);
  // Parmi les pépites, celles dont le bien est dans le périmètre d'un PPRi (mention courte, sans montant) : la même
  // lecture que la liste ci-dessus (gardée avec elle), sans appel de plus.
  const { data: pepiteExposedSaleIds } = useQuery({
    queryKey: queryKeys.pepiteFloodExposedIds(),
    queryFn: () => fetchPepiteFloodExposedIds(),
    staleTime: 5 * 60_000,
    retry: false,
    enabled: pepitesActive,
  });
  // « Pépites seulement » et « sous la fourchette » sont déjà appliqués par la recherche (listes d'identifiants
  // croisées avec les lignes) : le second passage local ne les rejoue pas, il n'a pas ces listes et viderait l'écran.
  const localFilterSearch = useMemo(
    () =>
      search.pepite || search.belowRange
        ? { ...search, pepite: undefined, belowRange: undefined }
        : search,
    [search],
  );
  // Le second passage local ne filtre que les lignes provisoires d'une recherche précédente. Les lignes de la
  // recherche en cours sont déjà filtrées par elle, et la carte de résultat ou les points de carte n'ont pas
  // toutes les colonnes des critères (surface, code postal, descriptions) : les refiltrer les écarterait à tort.
  const localFilter = (sales: AuctionSale[], placeholder: boolean) =>
    sortClientSearchResults(
      placeholder ? applyClientSearchFilters(sales, localFilterSearch, center) : sales,
      localFilterSearch,
      center,
    );

  const filteredSales = useMemo(
    () => (listIsPublic ? rawSales : localFilter(rawSales, isPlaceholderData)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `localFilter` ne lit que ces valeurs.
    [center, isPlaceholderData, listIsPublic, localFilterSearch, rawSales],
  );

  const mappableSales = useMemo(
    () =>
      (!mapVisible
        ? []
        : listIsPublic
          ? rawSales
          : rawMapSales.length
            ? localFilter(rawMapSales, isMapPlaceholder)
            : localFilter(rawSales, isPlaceholderData)
      ).filter(hasCoordinates),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `localFilter` ne lit que ces valeurs.
    [
      center,
      isMapPlaceholder,
      isPlaceholderData,
      listIsPublic,
      localFilterSearch,
      mapVisible,
      rawMapSales,
      rawSales,
    ],
  );
  // Au plafond, les pépites passent avant les autres ventes : elles ne sont jamais coupées en premier.
  const mapSales = useMemo(
    () => capMapPoints(mappableSales, MAP_POINT_LIMIT, pepiteSaleIds),
    [mappableSales, pepiteSaleIds],
  );
  const mappablePointsTotal = mappableSales.length;

  const selectedMapSaleId =
    selectedSaleId && mapSales.some((sale) => sale.id === selectedSaleId) ? selectedSaleId : null;

  const mapListFollowsViewport = false;
  const displayedSales = filteredSales;
  const aiReviewSaleIds = useMemo(
    () => [...new Set([...displayedSales, ...mapSales].map((sale) => sale.id).filter(Boolean))],
    [displayedSales, mapSales],
  );
  // Lectures réservées aux comptes connectés : relecture IA, vente choisie sur la carte, alertes.
  const account = useSearchAccountData({
    userId: user?.id ?? null,
    authLoading,
    aiReviewSaleIds,
    aiReviewEnabled: !listIsPublic && !isDiscovery,
    accessScope: comparisonScope,
    discovery: isDiscovery,
    selectedMapSaleId,
    selectedMapSaleEnabled: catalogReady && mapVisible,
    savedAlertsEnabled: alertDialogOpened && entitlementsData?.plan.hasAnalysisAccess === false,
  });
  const aiReviewBySaleId = account.aiReviewBySaleId;
  const aiReviewStatus: AiReviewRequestStatus =
    !user || listIsPublic || isDiscovery || aiReviewSaleIds.length === 0
      ? "disabled"
      : account.aiReviewError
        ? "error"
        : account.aiReviewReady
          ? "ready"
          : "loading";
  // Abonné de l'offre Analyse : bandeau « Votre suivi », ligne « Mon dossier » des ventes suivies et
  // colonne « Mon plafond » du tableau (voir `useFollowedSales`, chargé avec le bandeau par
  // `FollowedSalesPanel`). Rien n'est chargé ni lu pour les autres.
  const isAnalysis = Boolean(user) && hasAnalysisAccess;
  const [followedCards, setFollowedCards] = useState<FollowedCardData | null>(null);
  const followedFor = isAnalysis && !authLoading ? (user?.id ?? null) : null;
  // Le suivi d'un compte ne passe jamais à un autre (déconnexion, changement de compte).
  useEffect(() => setFollowedCards(null), [followedFor]);
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
  // « Retour aux ventes » d'une fiche : la liste défile jusqu'à la carte consultée.
  useRestoreSaleCard(!isInitialLoading && rawSales.length > 0);
  const startDesktopMap = useCallback(() => setDesktopMapStarted(true), []);
  useFirstGestureStart({
    enabled: isDesktop && !desktopMapStarted,
    onStart: startDesktopMap,
    zoneId: DESKTOP_MAP_ZONE_ID,
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
  // Total connu et nul, première page, pas d'erreur : le premier écran ne montre que l'état vide et ses
  // actions (critères à retirer, élargir la zone), sans réglages de tri ni liens d'aide à lire avant.
  const noResults =
    !isInitialLoading &&
    !listBusy &&
    !isCountLoading &&
    !publicTotalMissing &&
    !error &&
    page === 1 &&
    displayCount === 0 &&
    filteredCount === 0;
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
  // Liste et carte côte à côte dans la largeur de la page (maquette : 1,6 pour 1).
  const splitClass = wideMap
    ? "lg:grid-cols-[minmax(360px,1fr)_minmax(0,1.6fr)]"
    : displayedView === "table"
      ? "lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)]"
      : "lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]";
  // Le total du titre : seulement un total connu, jamais la longueur de la page en attendant.
  const listCountLoading =
    isInitialLoading || publicTotalMissing || (isCountLoading && !publicListShown);
  const listHasError = Boolean(error) && !pageOutOfRange && rawSales.length === 0;
  const titleTotal = listCountLoading || listHasError ? null : (totalCount ?? null);
  const totalPages = searchTotalPages(totalCount, pageSize);
  const statisticsLocked =
    isPreview || entitlementsData?.plan.features.salesStatistics !== "included";
  const dpeLocked = isPreview || entitlementsData?.plan.features.dpeExplorer !== "included";
  const csvExportLocked =
    isPreview || entitlementsData?.plan.features.salesCsvExport !== "included";
  const { emailRecapEnabled, savedAlerts } = account;
  const freeAlertUsage = savedAlerts
    ? { used: savedAlerts.filter((alert) => alert.is_active).length, limit: FREE_ALERT_LIMIT }
    : null;
  const openAlertDialog = useCallback(() => setAlertDialogOpened(true), []);
  // « Repères sur cette recherche » : repères du serveur et explorateur DPE pour les comptes qui y ont droit.
  const statisticsData = useSearchStatisticsData({
    search,
    searchKeySignature,
    sales: displayedSales,
    statisticsOpen,
    statisticsLocked,
    dpeExplorerOpen,
    dpeLocked,
    signedIn: Boolean(user) && !authLoading,
    initialLoading: isInitialLoading,
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

  const keepOnlyPepite = useCallback(() => {
    setDraft({ ...emptySearchDraft(), pepite: true });
    replaceSearch(salesSearchToUrlRecord({ pepite: true, sort: search.sort }), "push");
  }, [replaceSearch, search.sort]);

  // Mesure : « Pépites seulement » passe de faux à vrai (clic sur le filtre, sur le bouton de la liste vide ou
  // lien partagé suivi ensuite). Une page ouverte déjà filtrée n'est pas comptée.
  const pepiteOnly = search.pepite === true;
  const previousPepiteOnlyRef = useRef(pepiteOnly);
  useEffect(() => {
    if (pepiteOnly && !previousPepiteOnlyRef.current) trackProductEvent("pepite_filter_used");
    previousPepiteOnlyRef.current = pepiteOnly;
  }, [pepiteOnly]);

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

  // La carte mobile se crée à la première ouverture, puis reste montée (masquée) quand on referme :
  // chaque chargement de carte Mapbox est facturé, et le style et les tuiles se retéléchargent en 4G.
  // Un portail la rend dans un élément qui passe du support masqué à la fenêtre ouverte, sans
  // jamais la démonter. Masquée par `visibility: hidden` (et non `display: none`) : sa taille est
  // celle de la fenêtre, donc aucun redimensionnement ni changement de zone ne se déclenche.
  const [mobileMapStarted, setMobileMapStarted] = useState(false);
  // `isDesktop` vaut `false` jusqu'au montage : sans ce garde-fou, une adresse `?map=true` ouverte
  // sur ordinateur démarrerait d'abord la carte du mobile (second chargement Mapbox facturé).
  const [viewportKnown, setViewportKnown] = useState(false);
  useEffect(() => setViewportKnown(true), []);
  if (mobileMapOpen && !isDesktop && viewportKnown && !mobileMapStarted) setMobileMapStarted(true);
  const keepMobileMapMounted = mobileMapStarted && !isDesktop;
  const [mobileMapHost] = useState<HTMLDivElement | null>(() => {
    if (typeof document === "undefined") return null;
    const host = document.createElement("div");
    host.className = "h-full";
    return host;
  });
  const mobileMapHolderRef = useRef<HTMLDivElement | null>(null);
  const holdMobileMap = useCallback(
    (holder: HTMLDivElement | null) => {
      mobileMapHolderRef.current = holder;
      if (holder && mobileMapHost && !mobileMapHost.parentNode) holder.appendChild(mobileMapHost);
    },
    [mobileMapHost],
  );
  const showMobileMap = useCallback(
    (slot: HTMLDivElement | null) => {
      // À la fermeture de la fenêtre, la carte retourne au support avant que la fenêtre disparaisse.
      if (mobileMapHost) (slot ?? mobileMapHolderRef.current)?.appendChild(mobileMapHost);
    },
    [mobileMapHost],
  );

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

      // Cadrage de départ de la carte (zone de l'adresse restaurée, ou France) : pas un déplacement de
      // la personne, l'adresse de la recherche n'est pas réécrite.
      if (viewport.initial) return;
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
    initialViewport: search.viewport ?? null,
    totalCount,
    mappablePointsTotal,
    hoveredSaleId,
    selectedSaleId,
    selectedSaleDetail:
      account.selectedMapSaleDetail?.id === selectedMapSaleId
        ? account.selectedMapSaleDetail
        : null,
    selectedSaleDetailLoading: Boolean(selectedMapSaleId && account.selectedMapSaleDetailLoading),
    isLoading: isInitialLoading || isMapLoading || isMapFetching,
    searchAsMove: !isPreview && Boolean(search.searchAsMove),
    preview: listIsPublic,
    showDpeLegend: !dpeLocked,
    aiReviewBySaleId,
    aiReviewStatus,
    pepiteSaleIds,
    pepiteExposedSaleIds,
    onHover: setHoveredSaleId,
    onSelect: handleMapSelect,
    onViewportChange: handleViewportChange,
    onSearchAsMoveChange: handleSearchAsMoveChange,
    // Sur mobile la carte recouvre la liste : « Voir la liste » la referme.
    onShowList: () => {
      if (!isDesktop) closeMobileMap();
    },
  };

  // `explainReservedFeature` : une seule règle pour « fonction réservée à Analyse » (alertes ici,
  // export CSV plus bas), écrite dans le crochet.
  const {
    createAlertFromSearch,
    saving: savingAlert,
    explainReservedFeature,
  } = useCreateAlert({
    returnTo: currentHref,
    center,
  });

  async function saveSearch(options?: SaveSearchOptions) {
    const result = await createAlertFromSearch(search, options);
    // Le décompte de l'alerte gratuite (« 1/1 utilisée ») doit refléter celle qui vient d'être créée.
    if (result.status === "created" && user) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.savedAlerts(user.id) });
    }
  }

  // Bouton d'alerte de la recherche (en-tête du catalogue, état vide) : mêmes droits partout.
  const alertButtonProps = {
    saving: savingAlert,
    signedIn: Boolean(user),
    dailyAllowed: hasAnalysisAccess,
    emailRecapEnabled,
    freeAlertUsage: hasAnalysisAccess ? null : freeAlertUsage,
    onOpen: openAlertDialog,
    onClick: saveSearch,
  };

  // Visiteur : les pastilles réservées aux comptes mènent à l'inscription, qui le ramène sur cette
  // recherche (critères saisis compris) avec le filtre qu'il vient de choisir.
  const signupLinkWith = (patch: Partial<SalesSearchParams>) =>
    loginPathWithRedirect(
      pathWithSearch(
        pathname,
        withResultsView(
          salesSearchToUrlRecord(mergeSalesSearch(draftToSearch(draft, search), patch)),
          resultsView,
        ),
      ),
      { mode: "investor" },
    );
  const signupLinks = isPreview
    ? {
        belowRange: signupLinkWith({ belowRange: true }),
        noPointsToVerify: signupLinkWith({ noPointsToVerify: true }),
      }
    : undefined;

  async function exportCsv() {
    if (authLoading) {
      toast.message(ACCOUNT_CHECK_PENDING_TEXT);
      return;
    }
    if (!user) {
      router.push(loginPathWithRedirect(currentHref, { reason: "export" }));
      return;
    }
    if (entitlementsLoading || !entitlementsData) {
      toast.message(ACCOUNT_CHECK_PENDING_TEXT);
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

  // Liens d'évitement et en-tête du site (bannière) avant l'élément `main`, qui commence au titre.
  return (
    <>
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
      <SalesSiteHeader refreshing={listBusy && !isInitialLoading} />

      <main
        id="contenu"
        className="min-h-screen bg-background text-brand-navy [--sales-header-height:8.5rem]"
      >
        <SearchHeader
          draft={draft}
          setDraft={setDraft}
          activeFiltersCount={activeFiltersCount}
          filtersOpen={filtersOpen}
          savingAlert={savingAlert}
          signedIn={Boolean(user)}
          dailyAlertsAllowed={hasAnalysisAccess}
          emailRecapEnabled={emailRecapEnabled}
          pepitesActive={pepitesActive}
          signupLinks={signupLinks}
          freeAlertUsage={freeAlertUsage}
          onAlertDialogOpen={openAlertDialog}
          isDesktop={isDesktop}
          onFiltersOpenChange={changeFiltersOpen}
          onReset={resetFilters}
          onSaveSearch={saveSearch}
          intro={
            <SalesCatalogueHead
              search={search}
              total={titleTotal}
              week={weekCount}
              // Le chapô pour qui n'a pas l'offre Analyse ; l'abonné voit son suivi à la place.
              lede={!isAnalysis}
              followed={
                followedFor ? (
                  <LazyFollowedSalesPanel
                    key={followedFor}
                    userId={followedFor}
                    today={today}
                    aiReviewBySaleId={aiReviewBySaleId}
                    aiReviewStatus={aiReviewStatus}
                    onCardData={setFollowedCards}
                  />
                ) : null
              }
              // Actions de la recherche, réservées au grand écran (sur mobile, l'alerte est à côté du
              // champ du lieu). Droits inchangés : export réservé à l'offre Analyse, alerte gratuite.
              actions={
                <>
                  <CsvExportButton
                    exporting={exportingCsv}
                    locked={csvExportLocked}
                    onClick={exportCsv}
                  />
                  <SaveSearchButton
                    label="Créer une alerte sur cette recherche"
                    {...alertButtonProps}
                  />
                </>
              }
            />
          }
        />

        <AuthConnectionBanner className="my-3" />
        {user ? <LazyMonDemarrage className="mx-auto my-3 max-w-[1260px]" /> : null}

        <div
          className={`mx-auto grid min-h-[calc(100svh_-_var(--sales-header-height))] max-w-[90rem] gap-6 px-4 lg:px-6 grid-cols-1 ${splitClass}`}
        >
          <section
            id="sales-results"
            tabIndex={-1}
            // La barre de filtres ne colle à l'écran qu'à partir de lg : en dessous, rien à dégager.
            className="min-w-0 scroll-mt-3 lg:order-1 lg:scroll-mt-[calc(var(--sales-header-height)+12px)]"
            aria-label="Résultats de recherche"
            aria-busy={listBusy}
          >
            {/* Barre de liste : « N annonces · page X sur Y », le tri, puis cartes ou tableau. Les liens
              d'aide sont au pied de la liste (`ResultsHelp`). Sans résultat, seul le compteur reste :
              l'état vide et ses actions montent au premier écran. */}
            {/* Mobile : compteur et tri sur une seule ligne, le tri se tronque plutôt que de passer dessous. */}
            <div className="flex min-h-[4.25rem] items-center justify-between gap-x-3 gap-y-2 border-t border-line py-3 sm:flex-wrap">
              <ResultsSummary
                displayCount={displayCount}
                isLoading={listCountLoading}
                hasError={listHasError}
                geocoding={geocoding}
                page={page}
                totalPages={totalPages}
                refreshing={listBusy && !isInitialLoading}
              />
              {noResults ? null : (
                <div className="flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-none sm:flex-wrap">
                  <span aria-hidden="true" className="hidden text-sm text-ink-soft sm:inline">
                    Trier
                  </span>
                  <SortDropdown
                    bare
                    preview={isPreview}
                    hasCenter={Boolean(center)}
                    investmentScore={investmentSortAllowed}
                    sort={visibleSearchSort(search.sort, {
                      allowInvestmentScore: investmentSortAllowed,
                    })}
                    onChange={(sort) => chooseSearch({ sort })}
                  />
                  <ResultsViewToggle view={resultsView} onChange={changeResultsView} />
                  <LayoutToggle wideMap={wideMap} onToggle={() => setWideMap((value) => !value)} />
                </div>
              )}
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
              dossierBySaleId={
                followedFor && !listIsPublic ? followedCards?.dossierBySaleId : undefined
              }
              lastChangeBySaleId={
                followedFor && !listIsPublic ? followedCards?.lastChangeBySaleId : undefined
              }
              activeFilters={activeFilters}
              onRemoveFilter={(filter) => chooseSearch(filter.clear)}
              onResetFilters={resetFilters}
              onShowFrance={
                hasGeographicFilter(search) ? () => chooseSearch(WHOLE_FRANCE_PATCH) : undefined
              }
              hideEmptyState={page > 1}
              view={displayedView}
              pepiteSaleIds={pepiteSaleIds}
              pepiteExposedSaleIds={pepiteExposedSaleIds}
              pepiteEmpty={{
                count: pepiteSaleIds?.size ?? 0,
                // Garde la seule pépite (et le tri) : les autres critères sont retirés.
                onKeepOnlyPepite: keepOnlyPepite,
                onAlert: () => void saveSearch(),
                alertSaving: savingAlert,
              }}
              // Sans résultat : l'alerte de la recherche est proposée dans l'état vide lui-même.
              emptyAlertAction={
                <SaveSearchButton
                  secondary
                  label="Me prévenir des prochaines ventes ici"
                  {...alertButtonProps}
                />
              }
              // Encart des avocats : en fin de liste, sur la première page seulement.
              sponsoredPlacement={
                page === 1 ? (
                  <SearchLawyerPlacement
                    geographicLabel={geographicLabel}
                    city={search.city}
                    department={search.department}
                    pepites={pepitesActive}
                  />
                ) : undefined
              }
            />

            {!isInitialLoading &&
            !error &&
            page === 1 &&
            activeFiltersCount > 0 &&
            // Aucun résultat : l'état vide porte déjà l'alerte (« Me prévenir des prochaines ventes ici »).
            displayCount > 0 &&
            displayCount < FEW_RESULTS_ALERT_THRESHOLD ? (
              <SectorAlertPrompt
                resultCount={displayCount}
                saving={savingAlert}
                signedIn={Boolean(user)}
                dailyAllowed={hasAnalysisAccess}
                emailRecapEnabled={emailRecapEnabled}
                freeAlertUsage={freeAlertUsage}
                onAlertDialogOpen={openAlertDialog}
                onSaveSearch={saveSearch}
              />
            ) : null}

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

            {noResults || isInitialLoading ? null : (
              <ResultsHelp investmentScore={investmentSortAllowed} pepites={pepitesActive} />
            )}

            <details
              className="mt-3 rounded-lg border border-line-soft bg-white"
              onToggle={(event) => setStatisticsOpen(event.currentTarget.open)}
            >
              <summary className="cursor-pointer px-4 py-2 text-sm font-medium">
                Repères sur cette recherche
              </summary>
              {statisticsOpen ? (
                <LazySearchStatisticsPanel
                  statistics={statisticsData.statistics}
                  locked={statisticsLocked}
                  signedIn={Boolean(user)}
                  dpeLocked={dpeLocked}
                  loading={entitlementsLoading || statisticsData.loading}
                  dpeExplorer={statisticsData.dpeExplorer}
                  dpeExplorerLoading={statisticsData.dpeExplorerLoading}
                  dpeExplorerError={statisticsData.dpeExplorerError}
                  dpeExplorerRequested={dpeExplorerOpen}
                  onLoadDpeExplorer={() => {
                    setDpeExplorerOpen(true);
                    if (dpeExplorerOpen) void statisticsData.refetchDpeExplorer();
                  }}
                />
              ) : null}
            </details>
            <Footer />
          </section>

          {/* Always rendered (hidden below lg): the two-column layout is decided by CSS
            alone, so nothing shifts when the media query resolves after hydration. */}
          <aside className="relative hidden pb-6 lg:order-2 lg:block">
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
            pepitesActive={pepitesActive}
            draft={draft}
            setDraft={setDraft}
            activeFiltersCount={activeFiltersCount}
            resultCount={filtersResultCount}
            onClose={() => setFiltersOpen(false)}
            onReset={resetFilters}
            returnFocusRef={filtersTriggerRef}
          />
        ) : null}

        <MobileMapToggle
          comparedCount={comparison.items.length}
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
                  <List className="h-4 w-4" aria-hidden="true" />
                  Liste
                </button>
                {/* Titre court : la phrase qui explique la limite est dans la légende de la carte. */}
                <span className="text-sm font-bold text-ink-strong">
                  {mappablePointsTotal > mapSales.length
                    ? `${mapSales.length.toLocaleString("fr-FR")} sur ${mappablePointsTotal.toLocaleString("fr-FR")} biens`
                    : `${mapSales.length.toLocaleString("fr-FR")} biens sur la carte`}
                </span>
              </div>
              <div ref={showMobileMap} className="h-full pt-14" />
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
        {keepMobileMapMounted && mobileMapHost ? (
          <>
            {createPortal(<LazyMapPanel {...mapPanelProps} />, mobileMapHost)}
            <div
              ref={holdMobileMap}
              className="pointer-events-none invisible fixed inset-x-0 bottom-0 top-14 -z-10"
            />
          </>
        ) : null}
      </main>
    </>
  );
}
