"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import X from "lucide-react/dist/esm/icons/x.js";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { useSaleComparison } from "@/hooks/use-sale-comparison";
import { useLocation, useNavigate } from "@/lib/router-compat";
import {
  createWatchedZone as createWatchedZoneRequest,
  fetchAccessPlan,
  fetchDpeExplorer,
  exportSalesCsv,
  fetchSalesAiReviewProjections,
  fetchSalesStatistics,
} from "@/lib/client-api";
import { createAlert, getSaleById } from "@/lib/queries";
import { OFFERS_PATH, loginPathWithRedirect } from "@/lib/navigation";
import { geocodeAddress, geocodeAdministrativeArea, type GeoPoint } from "@/lib/geo";
import { departmentSearchValues, resolveFrenchGeoSearch } from "@/lib/search/french-geo-search";
import type { AiReviewProjectionReadModel, AiReviewRequestStatus } from "@/lib/ai-review-guard";
import {
  DEFAULT_SEARCH_LIMIT,
  applyClientSearchFilters,
  countActiveSearchFilters,
  hasCoordinates,
  sortClientSearchResults,
} from "@/lib/search/search-filters";
import { areMapViewportsClose } from "@/lib/search/map-viewport-results";
import { catalogPlaceholder } from "@/lib/search/catalog-placeholder";
import {
  mergeSalesSearch,
  salesSearchToUrlRecord,
  type SalesSearchParams,
} from "@/lib/search/search-url-state";
import {
  fetchSearchCount,
  fetchSearchMapResults,
  fetchSearchResults,
} from "@/lib/search/search-service";
import type { MapViewportChange } from "./MapPanel";
import { FiltersLoadingFallback } from "./FiltersLoadingFallback";
import { SearchPagination } from "./SearchPagination";
import { Footer, MapPanelSkeleton, MobileMapToggle } from "./SearchFilters";
import { ResultsSummary, SearchHeader, SortDropdown } from "./SearchHeader";
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
  searchStatisticsFromServer,
  searchToDraft,
  stableUrlRecord,
  useMediaQuery,
  watchedZoneInputFromSearch,
} from "./search-page-state";
import { userMessage } from "@/lib/user-messages";

const LazyMapPanel = dynamic(() => import("./MapPanel").then((mod) => mod.MapPanel), {
  ssr: false,
  loading: () => <MapPanelSkeleton />,
});

function SearchStatisticsLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Chargement des repères"
      className="border-b border-[#132238]/10 bg-white px-4 py-4 text-sm font-semibold text-[#5b6878] sm:px-5"
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

export function SearchPage({ search }: { search: SalesSearchParams }) {
  const navigate = useNavigate({ from: "/sales" });
  const currentLocation = useLocation();
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
  const mapVisible = isDesktop || mobileMapOpen;
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
      navigate({ search: nextRecord, replace: true, shallow: true });
    }, 320);

    return () => window.clearTimeout(timeout);
  }, [draft, draftSignature, navigate]);

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
    queryKey: ["feature-entitlements", user?.id ?? "anonymous", "plan"],
    queryFn: fetchAccessPlan,
    enabled: Boolean(user) && !authLoading,
    staleTime: 5 * 60_000,
  });
  const isDiscovery = Boolean(user) && entitlementsData?.plan.hasAnalysisAccess !== true;
  const catalogReady = !authLoading && (isPreview || !entitlementsLoading);
  const comparisonScope = catalogReady
    ? `${user?.id ?? "anonymous"}:${isPreview ? "preview" : isDiscovery ? "discovery" : "analysis"}`
    : null;
  const comparison = useSaleComparison(comparisonScope);

  const {
    data: rawSales = [],
    error,
    isFetching,
    isLoading,
    refetch: refetchSales,
  } = useQuery({
    queryKey: ["sales-search", searchKeySignature, comparisonScope],
    placeholderData: (previous, query) =>
      catalogPlaceholder(previous, query?.queryKey, comparisonScope),
    queryFn: () => fetchSearchResults({ search, preview: isPreview, discovery: isDiscovery }),
    enabled: catalogReady,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const { data: totalCount, isLoading: isCountLoading } = useQuery({
    queryKey: ["sales-search-count", searchKeySignature, comparisonScope],
    placeholderData: (previous, query) =>
      catalogPlaceholder(previous, query?.queryKey, comparisonScope),
    queryFn: () => fetchSearchCount({ search, preview: isPreview, discovery: isDiscovery }),
    enabled: catalogReady,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const {
    data: rawMapSales = [],
    isLoading: isMapLoading,
    isFetching: isMapFetching,
  } = useQuery({
    queryKey: ["sales-search-map", mapSearchKeySignature, comparisonScope],
    placeholderData: (previous, query) =>
      catalogPlaceholder(previous, query?.queryKey, comparisonScope),
    queryFn: () => fetchSearchMapResults(search, { discovery: isDiscovery }),
    enabled: catalogReady && !isPreview && mapVisible,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const filteredSales = useMemo(
    () =>
      isPreview
        ? rawSales
        : sortClientSearchResults(
            applyClientSearchFilters(rawSales, search, center),
            search,
            center,
          ),
    [center, isPreview, rawSales, search],
  );

  const mapSales = useMemo(
    () =>
      (!mapVisible
        ? []
        : isPreview
          ? rawSales
          : sortClientSearchResults(
              applyClientSearchFilters(rawMapSales.length ? rawMapSales : rawSales, search, center),
              search,
              center,
            )
      )
        .filter(hasCoordinates)
        .slice(0, 500),
    [center, isPreview, mapVisible, rawMapSales, rawSales, search],
  );

  // The map projection is intentionally lightweight. Fetch the complete row
  // only after an authenticated user selects a sale that is actually present
  // in the current map result set. Hovering, preview mode, and a hidden map
  // never trigger this request.
  const selectedMapSaleId =
    selectedSaleId && mapSales.some((sale) => sale.id === selectedSaleId) ? selectedSaleId : null;
  const { data: selectedMapSaleDetail, isFetching: selectedMapSaleDetailLoading } = useQuery({
    queryKey: ["sales-map-detail", comparisonScope, selectedMapSaleId],
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
    queryKey: ["sales-ai-review", user?.id ?? "anonymous", aiReviewSaleIds],
    queryFn: () => fetchSalesAiReviewProjections(aiReviewSaleIds),
    // Discovery rows already use the public redacted view. The AI review
    // endpoint reads Analyse-only projections and must not blank valid public
    // city, price or date values for free users.
    enabled: Boolean(user && !authLoading && !isPreview && !isDiscovery && aiReviewSaleIds.length),
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
    !user || isPreview || isDiscovery || aiReviewSaleIds.length === 0
      ? "disabled"
      : aiReviewError
        ? "error"
        : aiReviewData
          ? "ready"
          : "loading";
  const hasLocalFilters = false;
  const isInitialLoading = authLoading || entitlementsLoading || isLoading;
  const activeFiltersCount = countActiveSearchFilters(search);
  const displayCount = totalCount ?? filteredSales.length;
  const filteredCount = displayedSales.length;
  const hasMore =
    totalCount != null && pageOffset + rawSales.length < totalCount && rawSales.length >= pageSize;
  const hasPrevious = page > 1;
  const splitClass = wideMap
    ? "lg:grid-cols-[minmax(360px,38%)_minmax(0,1fr)]"
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
  const { data: salesStatisticsData, isFetching: salesStatisticsLoading } = useQuery({
    queryKey: ["sales-statistics", searchKeySignature],
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
    queryKey: ["dpe-explorer", searchKeySignature],
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
    (patch: Partial<SalesSearchParams>) => {
      const next = mergeSalesSearch(searchRef.current, patch);
      navigate({ search: salesSearchToUrlRecord(next), replace: true, shallow: true });
    },
    [navigate],
  );

  const resetFilters = useCallback(() => {
    setDraft(emptySearchDraft());
    navigate({
      search: salesSearchToUrlRecord({ sort: search.sort }),
      replace: true,
      shallow: true,
    });
  }, [navigate, search.sort]);

  const previousPageRef = useRef(page);
  useEffect(() => {
    if (previousPageRef.current === page || isFetching || isInitialLoading) return;
    previousPageRef.current = page;
    const results = document.getElementById("sales-results");
    results?.scrollIntoView({ block: "start", behavior: "instant" });
    results?.focus({ preventScroll: true });
  }, [page, isFetching, isInitialLoading]);

  const loadNextPage = useCallback(() => {
    if (!hasMore || isFetching) return;
    updateSearch({ page: page + 1 });
  }, [hasMore, isFetching, page, updateSearch]);

  const loadPreviousPage = useCallback(() => {
    if (!hasPrevious || isFetching) return;
    updateSearch({ page: page - 1 });
  }, [hasPrevious, isFetching, page, updateSearch]);

  const handleMapSelect = useCallback((saleId: string) => {
    setSelectedSaleId(saleId);
    window.setTimeout(() => {
      document.getElementById(`sale-card-${saleId}`)?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
    }, 40);
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
    hoveredSaleId,
    selectedSaleId,
    selectedSaleDetail:
      selectedMapSaleDetail?.id === selectedMapSaleId ? selectedMapSaleDetail : null,
    selectedSaleDetailLoading: Boolean(selectedMapSaleId && selectedMapSaleDetailLoading),
    isLoading: isInitialLoading || isMapLoading || isMapFetching,
    searchAsMove: !isPreview && Boolean(search.searchAsMove),
    preview: isPreview,
    showDpeLegend: !dpeLocked,
    aiReviewBySaleId,
    aiReviewStatus,
    onHover: setHoveredSaleId,
    onSelect: handleMapSelect,
    onViewportChange: handleViewportChange,
    onSearchAsMoveChange: handleSearchAsMoveChange,
  };

  async function saveSearch() {
    if (!user) {
      // La première alerte est gratuite : on invite à se connecter puis on
      // ramène la personne sur sa recherche.
      navigate(loginPathWithRedirect(currentLocation.href));
      return;
    }
    if (entitlementsLoading || !entitlementsData) {
      toast.message("Vérification de votre compte en cours. Réessayez dans un instant.");
      return;
    }
    if (alertsLocked) {
      toast.message("Les alertes de cette recherche sont réservées à l'offre Analyse.");
      navigate(OFFERS_PATH);
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
      toast.success(
        watchedZoneResponse ? "Zone surveillée et alerte créées" : "Recherche enregistrée",
      );
    } catch (saveError) {
      toast.error(userMessage(saveError));
    } finally {
      setSavingAlert(false);
    }
  }

  async function exportCsv() {
    if (!user) {
      navigate(loginPathWithRedirect(currentLocation.href));
      return;
    }
    if (entitlementsLoading || !entitlementsData) {
      toast.message("Vérification de votre compte en cours. Réessayez dans un instant.");
      return;
    }
    if (csvExportLocked) {
      toast.message("L'export CSV est réservé à l'offre Analyse.");
      navigate(OFFERS_PATH);
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
    <main className="min-h-screen bg-[#f7f8fa] text-[#132238] [--sales-header-height:8rem] lg:[--sales-header-height:8rem]">
      <a
        href="#sales-results"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[80] focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-bold focus:text-[#132238] focus:shadow-lg"
      >
        Aller aux résultats
      </a>

      <SearchHeader
        draft={draft}
        setDraft={setDraft}
        activeFiltersCount={activeFiltersCount}
        isLoading={isInitialLoading}
        isFetching={isFetching}
        filtersOpen={filtersOpen}
        savingAlert={savingAlert}
        exportingCsv={exportingCsv}
        csvExportLocked={csvExportLocked}
        wideMap={wideMap}
        isDesktop={isDesktop}
        onFiltersOpenChange={setFiltersOpen}
        onReset={resetFilters}
        onSaveSearch={saveSearch}
        onExportCsv={exportCsv}
        onToggleLayout={() => setWideMap((value) => !value)}
      />

      <div
        className={`grid min-h-[calc(100svh_-_var(--sales-header-height))] ${
          isDesktop ? splitClass : "grid-cols-1"
        }`}
      >
        <section
          id="sales-results"
          tabIndex={-1}
          style={{ scrollMarginTop: "calc(var(--sales-header-height) + 12px)" }}
          className="min-w-0 bg-[#f7f8fa] lg:order-1 lg:border-r lg:border-[#dce3eb]"
          aria-label="Résultats de recherche"
          aria-busy={isFetching}
        >
          <div className="flex flex-wrap items-center justify-between gap-1 border-b border-[#e3e8ee] bg-white pr-4">
            <ResultsSummary
              search={search}
              displayCount={displayCount}
              hasLocalFilters={hasLocalFilters}
              isLoading={isInitialLoading || isCountLoading}
              hasError={Boolean(error) && rawSales.length === 0}
              geocoding={geocoding}
            />

            <div className="flex flex-wrap items-center gap-2 px-4 pb-2 sm:px-0">
              <SortDropdown
                preview={isPreview}
                hasCenter={Boolean(center)}
                sort={search.sort ?? "relevance"}
                onChange={(sort) => updateSearch({ sort })}
              />
            </div>
          </div>
          <div className="border-b border-[#e3e8ee] bg-white px-4 py-3 sm:px-5">
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
            returnTo={currentLocation.href}
            userId={user?.id ?? null}
            onRemove={comparison.remove}
            onClear={comparison.clear}
            onRestore={comparison.replace}
            hideWhenEmpty
          />

          {isFetching && !isInitialLoading ? (
            <p role="status" className="px-5 pt-3 text-xs font-medium text-[#526170]">
              Actualisation des annonces…
            </p>
          ) : null}
          <SearchResultsList
            sales={displayedSales}
            returnTo={currentLocation.href}
            locked={isPreview}
            analysisLocked={isDiscovery}
            isLoading={isInitialLoading}
            error={error}
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
            sponsoredPlacement={
              <SearchLawyerPlacement
                geographicLabel={geographicLabel}
                city={search.city}
                department={search.department}
              />
            }
          />

          <SearchPagination
            hasMore={hasMore}
            hasPrevious={hasPrevious}
            isFetching={isFetching}
            loadedCount={filteredCount}
            totalCount={mapListFollowsViewport ? displayCount : totalCount}
            mapListFollowsViewport={mapListFollowsViewport}
            page={page}
            pageSize={pageSize}
            onNext={loadNextPage}
            onPrevious={loadPreviousPage}
          />

          <details
            className="mx-4 mt-3 rounded-lg border border-[#dce3eb] bg-white sm:mx-5"
            onToggle={(event) => setStatisticsOpen(event.currentTarget.open)}
          >
            <summary className="cursor-pointer px-4 py-2 text-sm font-medium">
              Repères sur cette recherche
            </summary>
            {statisticsOpen ? (
              <LazySearchStatisticsPanel
                statistics={searchStatistics}
                locked={statisticsLocked}
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

        {isDesktop ? (
          <aside className="relative min-h-[calc(100svh_-_var(--sales-header-height))] bg-[#dfe7eb] lg:order-2">
            <div className="sticky top-[var(--sales-header-height)] h-[calc(100svh_-_var(--sales-header-height))]">
              <LazyMapPanel {...mapPanelProps} />
            </div>
          </aside>
        ) : null}
      </div>

      {filtersOpen ? (
        <LazyMoreFiltersModal
          open={filtersOpen}
          analysisLocked={isPreview || isDiscovery}
          preview={isPreview}
          draft={draft}
          setDraft={setDraft}
          activeFiltersCount={activeFiltersCount}
          onClose={() => setFiltersOpen(false)}
          onReset={resetFilters}
        />
      ) : null}

      <MobileMapToggle
        activeFiltersCount={activeFiltersCount}
        onOpenFilters={() => setFiltersOpen(true)}
        onOpenMap={() => updateSearch({ map: true })}
      />

      <DialogPrimitive.Root
        open={mobileMapOpen && !isDesktop}
        onOpenChange={(open) => {
          if (!open) updateSearch({ map: false });
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
            className="fixed inset-0 z-50 bg-[#e7f4ef] outline-none"
          >
            <DialogPrimitive.Title className="sr-only">Carte des annonces</DialogPrimitive.Title>
            <div className="absolute inset-x-0 top-0 z-10 flex h-14 items-center justify-between border-b border-[#132238]/10 bg-white/95 px-3 backdrop-blur">
              <button
                type="button"
                onClick={() => updateSearch({ map: false })}
                className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-md border border-[#d6e0dc] bg-white px-3 text-sm font-bold text-[#132238] shadow-sm"
              >
                <X className="h-4 w-4" />
                Liste
              </button>
              <span className="text-sm font-bold text-[#3d4b57]">
                {mapSales.length.toLocaleString("fr-FR")} biens sur la carte
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
