"use client";

import dynamic from "next/dynamic";
import type * as React from "react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ArrowUpDown from "lucide-react/dist/esm/icons/arrow-up-down.js";
import BarChart3 from "lucide-react/dist/esm/icons/bar-chart-3.js";
import BedDouble from "lucide-react/dist/esm/icons/bed-double.js";
import Bell from "lucide-react/dist/esm/icons/bell.js";
import Building2 from "lucide-react/dist/esm/icons/building-2.js";
import CalendarDays from "lucide-react/dist/esm/icons/calendar-days.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import Download from "lucide-react/dist/esm/icons/download.js";
import Heart from "lucide-react/dist/esm/icons/heart.js";
import Landmark from "lucide-react/dist/esm/icons/landmark.js";
import LayoutPanelLeft from "lucide-react/dist/esm/icons/layout-panel-left.js";
import ListFilter from "lucide-react/dist/esm/icons/list-filter.js";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import Map from "lucide-react/dist/esm/icons/map.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.js";
import Ruler from "lucide-react/dist/esm/icons/ruler.js";
import SearchIcon from "lucide-react/dist/esm/icons/search.js";
import Share2 from "lucide-react/dist/esm/icons/share-2.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { useViewedSales } from "@/hooks/use-viewed-sales";
import { supabase } from "@/integrations/supabase/client";
import { Link, useNavigate } from "@/lib/router-compat";
import {
  createWatchedZone as createWatchedZoneRequest,
  addFavoriteSale as addFavoriteSaleRequest,
  fetchDpeExplorer,
  exportSalesCsv,
  fetchFeatureEntitlements,
  fetchSalesStatistics,
  removeFavoriteSale as removeFavoriteSaleRequest,
} from "@/lib/client-api";
import { createAlert } from "@/lib/queries";
import { DPE_CLASSES, dpeColor, extractDpe, type DpeClass } from "@/lib/dpe";
import type { DpeExplorerResponse } from "@/lib/dpe-explorer";
import {
  formatDate,
  formatPrice,
  formatPricePerM2,
  occupancyLabel,
  propertyTypeLabel,
} from "@/lib/format";
import { geocodeAddress, pricePerM2, type GeoPoint } from "@/lib/geo";
import { mapboxStaticImageUrl } from "@/lib/mapbox";
import { firstPropertyImage, shouldRejectRenderedPropertyImage } from "@/lib/sale-media";
import { cleanSaleTitle, saleDisplayTitle } from "@/lib/sale-title";
import { getDisplaySurface, getSaleSurface } from "@/lib/surface";
import { isNew } from "@/lib/dates";
import type { AuctionSale } from "@/lib/types";
import type { WatchedZoneInput } from "@/lib/watched-zones";
import type { SalesStatisticsResponse } from "@/lib/sales-statistics";
import {
  DEFAULT_SEARCH_LIMIT,
  HOME_TYPE_OPTIONS,
  SORT_OPTIONS,
  STATUS_OPTIONS,
  applyClientSearchFilters,
  compactPrice,
  countActiveSearchFilters,
  hasClientOnlyFilters,
  hasCoordinates,
  sortClientSearchResults,
} from "@/lib/search/search-filters";
import {
  areMapViewportsClose,
  shouldMapListFollowViewport,
  visibleSalesForMapViewport,
} from "@/lib/search/map-viewport-results";
import {
  mergeSalesSearch,
  salesSearchToUrlRecord,
  type SalesSearchParams,
  type SalesSearchUrlRecord,
  type SearchSortKey,
} from "@/lib/search/search-url-state";
import {
  fetchSearchCount,
  fetchSearchMapResults,
  fetchSearchResults,
} from "@/lib/search/search-service";
import type { MapViewportChange } from "./MapPanel";

const LazyMapPanel = dynamic(() => import("./MapPanel").then((mod) => mod.MapPanel), {
  ssr: false,
  loading: () => <MapPanelSkeleton />,
});

type SearchDraft = {
  city: string;
  department: string;
  tribunal: string;
  query: string;
  minPrice: string;
  maxPrice: string;
  minBeds: string;
  minBaths: string;
  minSqft: string;
  maxSqft: string;
  homeTypes: string[];
  status: string[];
  keywords: string;
  occupancy: string;
  dpeClasses: string[];
  minScore: string;
  maxPricePerM2: string;
  minYield: string;
  minMarketDiscount: string;
  houseWithLand: boolean;
  aroundAddress: string;
  aroundRadius: string;
  yearBuilt: string;
  openHouse: boolean;
};

export function SearchPage({ search }: { search: SalesSearchParams }) {
  const navigate = useNavigate({ from: "/sales" });
  const { user, loading: authLoading } = useAuth();
  const isPreview = !user;
  const reduceMotion = useReducedMotion();
  const searchRef = useRef(search);
  const viewportTimerRef = useRef<number | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const [hoveredSaleId, setHoveredSaleId] = useState<string | null>(null);
  const [selectedSaleId, setSelectedSaleId] = useState<string | null>(null);
  const [mapViewport, setMapViewport] = useState<MapViewportChange | null>(null);
  const deferredMapViewport = useDeferredValue(mapViewport);
  const [wideMap, setWideMap] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [mobileMapOpen, setMobileMapOpen] = useState(Boolean(search.map));
  const [savingAlert, setSavingAlert] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [dpeExplorerOpen, setDpeExplorerOpen] = useState(false);
  const [draft, setDraft] = useState<SearchDraft>(() => searchToDraft(search));
  const latestSearchDraftRef = useRef<SearchDraft>(searchToDraft(search));
  const firstSearchDraftSync = useRef(true);
  const firstDraftSync = useRef(true);
  const [center, setCenter] = useState<GeoPoint | null>(null);
  const [geocoding, setGeocoding] = useState(false);
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const page = search.page ?? 1;
  const pageSize = search.limit ?? DEFAULT_SEARCH_LIMIT;

  useEffect(() => {
    searchRef.current = search;
  }, [search]);

  useEffect(() => {
    setMobileMapOpen(Boolean(search.map));
  }, [search.map]);

  const draftSignature = useMemo(() => JSON.stringify(draft), [draft]);
  const searchDraftSignature = useMemo(() => JSON.stringify(searchToDraft(search)), [search]);

  useEffect(() => {
    latestSearchDraftRef.current = searchToDraft(search);
  }, [search]);

  useEffect(() => {
    if (firstSearchDraftSync.current) {
      firstSearchDraftSync.current = false;
      return;
    }

    setDraft(latestSearchDraftRef.current);
  }, [searchDraftSignature]);

  useEffect(() => {
    if (firstDraftSync.current) {
      firstDraftSync.current = false;
      return;
    }

    const timeout = window.setTimeout(() => {
      const nextSearch = draftToSearch(draft, searchRef.current);
      const currentRecord = salesSearchToUrlRecord(searchRef.current);
      const nextRecord = salesSearchToUrlRecord(nextSearch);
      if (stableUrlRecord(currentRecord) === stableUrlRecord(nextRecord)) return;
      navigate({ search: nextRecord, replace: true });
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
  const { data: entitlementsData, isLoading: entitlementsLoading } = useQuery({
    queryKey: ["feature-entitlements", user?.id ?? "anonymous"],
    queryFn: fetchFeatureEntitlements,
    enabled: Boolean(user) && !authLoading,
    staleTime: 5 * 60_000,
  });
  const isDiscovery = Boolean(user) && entitlementsData?.plan.hasAnalysisAccess !== true;
  const catalogReady = !authLoading && (isPreview || !entitlementsLoading);

  const {
    data: rawSales = [],
    error,
    isFetching,
    isLoading,
  } = useQuery({
    queryKey: ["sales-search", searchKeySignature, isPreview, isDiscovery],
    queryFn: () => fetchSearchResults({ search, preview: isPreview, discovery: isDiscovery }),
    enabled: catalogReady,
    staleTime: 60_000,
  });

  const { data: totalCount, isLoading: isCountLoading } = useQuery({
    queryKey: ["sales-search-count", searchKeySignature, isPreview, isDiscovery],
    queryFn: () => fetchSearchCount({ search, preview: isPreview, discovery: isDiscovery }),
    enabled: catalogReady,
    staleTime: 60_000,
  });

  const { data: rawMapSales = [], isLoading: isMapLoading } = useQuery({
    queryKey: ["sales-search-map", searchKeySignature, isDiscovery],
    queryFn: () => fetchSearchMapResults(search, { discovery: isDiscovery }),
    enabled: catalogReady && !isPreview,
    staleTime: 60_000,
  });

  const filteredSales = useMemo(
    () =>
      sortClientSearchResults(applyClientSearchFilters(rawSales, search, center), search, center),
    [center, rawSales, search],
  );

  const mapSales = useMemo(
    () =>
      sortClientSearchResults(
        applyClientSearchFilters(rawMapSales.length ? rawMapSales : rawSales, search, center),
        search,
        center,
      )
        .filter(hasCoordinates)
        .slice(0, 300),
    [center, rawMapSales, rawSales, search],
  );

  const mapViewportResults = useMemo(
    () => visibleSalesForMapViewport(mapSales, deferredMapViewport),
    [deferredMapViewport, mapSales],
  );

  const mapListFollowsViewport = shouldMapListFollowViewport({
    isDesktop,
    mobileMapOpen,
    viewport: deferredMapViewport,
    mapSalesCount: mapSales.length,
  });
  const displayedSales = mapListFollowsViewport ? mapViewportResults.sales : filteredSales;
  const hasLocalFilters = hasClientOnlyFilters(search);
  const isInitialLoading = authLoading || entitlementsLoading || isLoading;
  const activeFiltersCount = countActiveSearchFilters(search);
  const searchDisplayCount = hasLocalFilters
    ? filteredSales.length
    : (totalCount ?? filteredSales.length);
  const displayCount = mapListFollowsViewport ? mapViewportResults.total : searchDisplayCount;
  const loadedCount = mapListFollowsViewport ? mapSales.length : rawSales.length;
  const filteredCount = displayedSales.length;
  const hasMore =
    !mapListFollowsViewport &&
    !hasLocalFilters &&
    totalCount != null &&
    rawSales.length < totalCount &&
    rawSales.length >= page * pageSize;
  const splitClass = wideMap
    ? "lg:grid-cols-[minmax(0,1.7fr)_minmax(390px,30vw)]"
    : "lg:grid-cols-[minmax(0,1.25fr)_minmax(430px,36vw)]";
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
    isPreview || entitlementsData?.plan.features.watchedZones !== "included";
  const alertsLocked = isPreview || entitlementsData?.plan.features.smartAlerts !== "included";
  const { data: salesStatisticsData, isFetching: salesStatisticsLoading } = useQuery({
    queryKey: ["sales-statistics", searchKeySignature],
    queryFn: () => fetchSalesStatistics({ search }),
    enabled: !statisticsLocked && !authLoading && Boolean(user),
    retry: false,
    staleTime: 2 * 60_000,
  });
  const searchStatistics = useMemo(
    () =>
      salesStatisticsData && !mapListFollowsViewport
        ? searchStatisticsFromServer(salesStatisticsData.summary)
        : localSearchStatistics,
    [localSearchStatistics, mapListFollowsViewport, salesStatisticsData],
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
      navigate({ search: salesSearchToUrlRecord(next), replace: true });
    },
    [navigate],
  );

  const resetFilters = useCallback(() => {
    setDraft(emptySearchDraft());
    navigate({
      search: salesSearchToUrlRecord({ sort: search.sort }),
      replace: true,
    });
  }, [navigate, search.sort]);

  const loadMore = useCallback(() => {
    if (!hasMore || isFetching) return;
    updateSearch({ page: page + 1 });
  }, [hasMore, isFetching, page, updateSearch]);

  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node || !hasMore || isFetching || isInitialLoading) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) loadMore();
      },
      { rootMargin: "680px 0px" },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, isFetching, isInitialLoading, loadMore]);

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

      if (!searchRef.current.searchAsMove) return;
      if (viewportTimerRef.current != null) window.clearTimeout(viewportTimerRef.current);
      viewportTimerRef.current = window.setTimeout(() => {
        updateSearch({ viewport: viewport.bounds });
      }, 520);
    },
    [updateSearch],
  );

  async function saveSearch() {
    if (!user) {
      toast.error("Connectez-vous pour enregistrer une recherche");
      return;
    }
    if (alertsLocked) {
      toast.message("Alertes réservées au plan Analyse");
      navigate({ to: "/accompagnement" });
      return;
    }
    if (activeFiltersCount === 0) {
      toast.error("Ajoutez au moins un filtre avant d'enregistrer");
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
      toast.error(saveError instanceof Error ? saveError.message : "Erreur");
    } finally {
      setSavingAlert(false);
    }
  }

  async function exportCsv() {
    if (!user) {
      toast.error("Connectez-vous pour exporter les ventes");
      return;
    }
    if (csvExportLocked) {
      toast.error("Export CSV réservé au plan Analyse");
      return;
    }

    setExportingCsv(true);
    try {
      const { blob, filename } = await exportSalesCsv({ search });
      downloadBlob(blob, filename);
      toast.success("Export CSV prêt");
    } catch (exportError) {
      toast.error(exportError instanceof Error ? exportError.message : "Export impossible");
    } finally {
      setExportingCsv(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#edf3f7] text-[#132238] [--sales-header-height:11rem] lg:[--sales-header-height:8.375rem]">
      <a
        href="#sales-results"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[80] focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-bold focus:text-[#132238] focus:shadow-lg"
      >
        Aller aux résultats
      </a>

      <SearchHeader
        search={search}
        draft={draft}
        setDraft={setDraft}
        displayCount={displayCount}
        loadedCount={loadedCount}
        filteredCount={filteredCount}
        activeFiltersCount={activeFiltersCount}
        mapListFollowsViewport={mapListFollowsViewport}
        isLoading={isInitialLoading}
        isCountLoading={isCountLoading}
        isFetching={isFetching}
        geocoding={geocoding}
        filtersOpen={filtersOpen}
        savingAlert={savingAlert}
        alertsLocked={alertsLocked}
        exportingCsv={exportingCsv}
        csvExportLocked={csvExportLocked}
        wideMap={wideMap}
        onFiltersOpenChange={setFiltersOpen}
        onReset={resetFilters}
        onSaveSearch={saveSearch}
        onExportCsv={exportCsv}
        onSortChange={(sort) => updateSearch({ sort: sort === "relevance" ? undefined : sort })}
        onToggleLayout={() => setWideMap((value) => !value)}
      />

      <div
        className={`grid min-h-[calc(100svh_-_var(--sales-header-height))] ${
          isDesktop ? splitClass : "grid-cols-1"
        }`}
      >
        <section
          id="sales-results"
          className="min-w-0 border-t border-[#132238]/10 bg-[#f8fbfd] lg:order-2 lg:border-l"
          aria-label="Résultats de recherche"
        >
          <ResultsSummary
            search={search}
            displayCount={displayCount}
            loadedCount={loadedCount}
            filteredCount={filteredCount}
            hasLocalFilters={hasLocalFilters}
            mapListFollowsViewport={mapListFollowsViewport}
            mapViewport={deferredMapViewport}
            isLoading={isInitialLoading || isCountLoading}
            geocoding={geocoding}
          />

          <SearchStatisticsPanel
            statistics={searchStatistics}
            locked={statisticsLocked}
            dpeLocked={dpeLocked}
            loading={entitlementsLoading || statisticsLoading}
            dpeExplorer={dpeExplorerData}
            dpeExplorerLoading={dpeExplorerLoading}
            dpeExplorerError={dpeExplorerError instanceof Error ? dpeExplorerError.message : null}
            dpeExplorerRequested={dpeExplorerOpen}
            onLoadDpeExplorer={() => {
              setDpeExplorerOpen(true);
              if (dpeExplorerOpen) void refetchDpeExplorer();
            }}
          />

          <SearchResultsList
            sales={displayedSales}
            locked={isPreview}
            analysisLocked={isDiscovery}
            isLoading={isInitialLoading}
            error={error}
            selectedSaleId={selectedSaleId}
            hoveredSaleId={hoveredSaleId}
            reduceMotion={Boolean(reduceMotion)}
            onHover={setHoveredSaleId}
            onSelect={setSelectedSaleId}
          />

          <div ref={loadMoreRef} className="h-1" aria-hidden />

          <PaginationControls
            hasMore={hasMore}
            isFetching={isFetching}
            loadedCount={filteredCount}
            totalCount={mapListFollowsViewport ? displayCount : totalCount}
            mapListFollowsViewport={mapListFollowsViewport}
            onLoadMore={loadMore}
          />

          <Footer />
        </section>

        {isDesktop ? (
          <aside className="relative min-h-[calc(100svh_-_var(--sales-header-height))] bg-[#dfe7eb] lg:order-1">
            <div className="sticky top-[var(--sales-header-height)] h-[calc(100svh_-_var(--sales-header-height))]">
              <LazyMapPanel
                sales={mapSales}
                hoveredSaleId={hoveredSaleId}
                selectedSaleId={selectedSaleId}
                isLoading={isInitialLoading || isMapLoading}
                searchAsMove={Boolean(search.searchAsMove)}
                onHover={setHoveredSaleId}
                onSelect={handleMapSelect}
                onViewportChange={handleViewportChange}
                onSearchAsMoveChange={(enabled) =>
                  updateSearch({
                    searchAsMove: enabled,
                    viewport: enabled ? mapViewport?.bounds : undefined,
                  })
                }
              />
            </div>
          </aside>
        ) : null}
      </div>

      <MoreFiltersModal
        open={filtersOpen}
        draft={draft}
        setDraft={setDraft}
        activeFiltersCount={activeFiltersCount}
        onClose={() => setFiltersOpen(false)}
        onReset={resetFilters}
      />

      <MobileMapToggle
        activeFiltersCount={activeFiltersCount}
        onOpenFilters={() => setFiltersOpen(true)}
        onOpenMap={() => updateSearch({ map: true })}
      />

      <AnimatePresence>
        {mobileMapOpen ? (
          <motion.div
            className="fixed inset-0 z-50 bg-[#e7f4ef] lg:hidden"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0 }}
          >
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
              <LazyMapPanel
                sales={mapSales}
                hoveredSaleId={hoveredSaleId}
                selectedSaleId={selectedSaleId}
                isLoading={isInitialLoading || isMapLoading}
                searchAsMove={Boolean(search.searchAsMove)}
                onHover={setHoveredSaleId}
                onSelect={handleMapSelect}
                onViewportChange={handleViewportChange}
                onSearchAsMoveChange={(enabled) =>
                  updateSearch({
                    searchAsMove: enabled,
                    viewport: enabled ? mapViewport?.bounds : undefined,
                  })
                }
              />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </main>
  );
}

function SearchHeader({
  search,
  draft,
  setDraft,
  displayCount,
  loadedCount,
  filteredCount,
  activeFiltersCount,
  mapListFollowsViewport,
  isLoading,
  isCountLoading,
  isFetching,
  geocoding,
  filtersOpen,
  savingAlert,
  alertsLocked,
  exportingCsv,
  csvExportLocked,
  wideMap,
  onFiltersOpenChange,
  onReset,
  onSaveSearch,
  onExportCsv,
  onSortChange,
  onToggleLayout,
}: {
  search: SalesSearchParams;
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
  displayCount: number;
  loadedCount: number;
  filteredCount: number;
  activeFiltersCount: number;
  mapListFollowsViewport: boolean;
  isLoading: boolean;
  isCountLoading: boolean;
  isFetching: boolean;
  geocoding: boolean;
  filtersOpen: boolean;
  savingAlert: boolean;
  alertsLocked: boolean;
  exportingCsv: boolean;
  csvExportLocked: boolean;
  wideMap: boolean;
  onFiltersOpenChange: (open: boolean) => void;
  onReset: () => void;
  onSaveSearch: () => void;
  onExportCsv: () => void;
  onSortChange: (sort: SearchSortKey) => void;
  onToggleLayout: () => void;
}) {
  return (
    <header className="top-0 z-40 border-b border-[#132238]/10 bg-[#fbfdff] shadow-[0_10px_30px_rgba(19,34,56,0.12)] lg:sticky">
      <div className="bg-[#071a31] text-white">
        <div className="px-3 py-3 sm:px-5 lg:px-6">
          <div className="grid gap-3 lg:grid-cols-[max-content_minmax(20rem,1fr)_auto] lg:items-center">
            <div className="flex min-w-0 items-center gap-4">
              <div className="font-display text-[2rem] font-semibold leading-none tracking-normal text-white sm:text-[2.25rem]">
                Immo<span className="text-[#c98d45]">judis</span>
              </div>
              <div className="hidden h-8 w-px bg-white/20 sm:block" aria-hidden />
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold text-white">Ventes judiciaires</h1>
                <p className="mt-0.5 hidden text-xs font-medium text-white/62 sm:block">
                  Carte, audiences et dossiers vérifiés
                </p>
              </div>
            </div>

            <SearchInput
              value={draft.query}
              onChange={(value) => setDraft((current) => ({ ...current, query: value }))}
            />

            <div className="flex shrink-0 items-center gap-2 overflow-x-auto pb-1 [scrollbar-width:none] lg:pb-0 [&::-webkit-scrollbar]:hidden">
              <SaveSearchButton saving={savingAlert} locked={alertsLocked} onClick={onSaveSearch} />
              <CsvExportButton
                exporting={exportingCsv}
                locked={csvExportLocked}
                onClick={onExportCsv}
              />
              <LayoutToggle wideMap={wideMap} onToggle={onToggleLayout} />
            </div>
          </div>
        </div>
      </div>

      <div className="border-t border-[#132238]/10 bg-white/96 px-3 py-2.5 backdrop-blur-xl sm:px-5 lg:px-6">
        <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
          <FilterBar
            draft={draft}
            setDraft={setDraft}
            activeFiltersCount={activeFiltersCount}
            filtersOpen={filtersOpen}
            onFiltersOpenChange={onFiltersOpenChange}
            onReset={onReset}
          />

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <SortDropdown sort={search.sort ?? "relevance"} onChange={onSortChange} />
            <div className="flex flex-wrap items-center gap-1.5 text-xs font-bold text-[#55626f]">
              <HeaderStatusPill>
                {isLoading || isCountLoading ? "Chargement" : displayCount.toLocaleString("fr-FR")}{" "}
                {mapListFollowsViewport ? "dans la carte" : "ventes"}
              </HeaderStatusPill>
              <HeaderStatusPill>
                {loadedCount.toLocaleString("fr-FR")}{" "}
                {mapListFollowsViewport ? "points carte" : "chargées"}
              </HeaderStatusPill>
              {filteredCount !== loadedCount ? (
                <HeaderStatusPill>
                  {filteredCount.toLocaleString("fr-FR")} affichées
                </HeaderStatusPill>
              ) : null}
              {isFetching && !isLoading ? (
                <HeaderStatusPill tone="teal">
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  Mise à jour
                </HeaderStatusPill>
              ) : null}
              {geocoding ? (
                <HeaderStatusPill tone="teal">
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  Géocodage
                </HeaderStatusPill>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

function HeaderStatusPill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "teal";
}) {
  return (
    <span
      className={`inline-flex min-h-7 items-center gap-1.5 rounded-md border px-2.5 ${
        tone === "teal"
          ? "border-[#b8ddd5] bg-[#eefaf3] text-[#0f766e]"
          : "border-[#d9e4ec] bg-white text-[#55626f]"
      }`}
    >
      {children}
    </span>
  );
}

function SearchInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="relative min-w-0 flex-1">
      <span className="sr-only">Rechercher par adresse, mot-clé ou référence</span>
      <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#667482]" />
      <Input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Ville, adresse, tribunal..."
        className="h-11 rounded-md border-white/25 bg-white pl-10 pr-3 text-[15px] font-semibold text-[#132238] shadow-[0_10px_24px_rgba(0,0,0,0.18)] focus-visible:ring-[#c98d45]"
      />
    </label>
  );
}

function FilterBar({
  draft,
  setDraft,
  activeFiltersCount,
  filtersOpen,
  onFiltersOpenChange,
  onReset,
}: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
  activeFiltersCount: number;
  filtersOpen: boolean;
  onFiltersOpenChange: (open: boolean) => void;
  onReset: () => void;
}) {
  return (
    <div
      className="flex min-w-0 gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      aria-label="Filtres de recherche"
    >
      <InlineTextFilter
        label="Ville"
        icon={MapPin}
        value={draft.city}
        placeholder="Bordeaux"
        onChange={(value) => setDraft((current) => ({ ...current, city: value }))}
      />
      <InlineTextFilter
        label="Tribunal"
        icon={Landmark}
        value={draft.tribunal}
        placeholder="TJ Bordeaux"
        onChange={(value) => setDraft((current) => ({ ...current, tribunal: value }))}
      />
      <PriceFilter draft={draft} setDraft={setDraft} />
      <BedsBathsFilter draft={draft} setDraft={setDraft} />
      <HomeTypeFilter draft={draft} setDraft={setDraft} />
      <button
        type="button"
        onClick={() => onFiltersOpenChange(!filtersOpen)}
        aria-label="Filtres avancés"
        aria-expanded={filtersOpen}
        title="Filtres avancés"
        className="inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-md border border-[#cbd5df] bg-white px-3 text-sm font-bold text-[#132238] shadow-sm transition-colors hover:border-[#0f766e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e]"
      >
        <SlidersHorizontal className="h-4 w-4" />
        Plus
        {activeFiltersCount > 0 ? (
          <span className="rounded-full bg-[#0f766e] px-1.5 py-0.5 text-[10px] text-white">
            {activeFiltersCount}
          </span>
        ) : null}
      </button>
      {activeFiltersCount > 0 ? (
        <button
          type="button"
          onClick={onReset}
          className="inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-md border border-[#ead8c5] bg-[#fffaf2] px-3 text-sm font-bold text-[#8a5b24] transition-colors hover:border-[#c98d45] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c98d45]"
        >
          <RotateCcw className="h-4 w-4" />
          Réinitialiser
        </button>
      ) : null}
    </div>
  );
}

function InlineTextFilter({
  label,
  icon: Icon,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="relative inline-flex h-10 min-w-[10.5rem] shrink-0 items-center rounded-md border border-[#cbd5df] bg-white shadow-sm focus-within:ring-2 focus-within:ring-[#0f766e]">
      <Icon className="ml-3 h-4 w-4 text-[#667482]" />
      <span className="sr-only">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-full min-w-0 flex-1 bg-transparent px-2 text-sm font-bold text-[#132238] outline-none placeholder:text-[#667482]"
      />
    </label>
  );
}

function PriceFilter({
  draft,
  setDraft,
}: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
}) {
  return (
    <div className="inline-flex h-10 shrink-0 items-center overflow-hidden rounded-md border border-[#cbd5df] bg-white shadow-sm">
      <span className="px-3 text-sm font-bold text-[#132238]">Prix</span>
      <input
        aria-label="Prix minimum"
        inputMode="numeric"
        value={draft.minPrice}
        onChange={(event) => setDraft((current) => ({ ...current, minPrice: event.target.value }))}
        placeholder="min"
        className="h-full w-20 border-l border-[#d6e0dc] bg-transparent px-2 text-sm font-semibold outline-none"
      />
      <input
        aria-label="Prix maximum"
        inputMode="numeric"
        value={draft.maxPrice}
        onChange={(event) => setDraft((current) => ({ ...current, maxPrice: event.target.value }))}
        placeholder="max"
        className="h-full w-20 border-l border-[#d6e0dc] bg-transparent px-2 text-sm font-semibold outline-none"
      />
    </div>
  );
}

function BedsBathsFilter({
  draft,
  setDraft,
}: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
}) {
  return (
    <div className="inline-flex h-10 shrink-0 items-center overflow-hidden rounded-md border border-[#cbd5df] bg-white shadow-sm">
      <span className="px-3 text-sm font-bold text-[#132238]">Pièces</span>
      <input
        aria-label="Nombre minimum de chambres"
        inputMode="numeric"
        value={draft.minBeds}
        onChange={(event) => setDraft((current) => ({ ...current, minBeds: event.target.value }))}
        placeholder="ch."
        className="h-full w-16 border-l border-[#d6e0dc] bg-transparent px-2 text-sm font-semibold outline-none"
      />
      <input
        aria-label="Nombre minimum de salles de bain"
        inputMode="numeric"
        value={draft.minBaths}
        onChange={(event) => setDraft((current) => ({ ...current, minBaths: event.target.value }))}
        placeholder="sdb"
        className="h-full w-16 border-l border-[#d6e0dc] bg-transparent px-2 text-sm font-semibold outline-none"
      />
    </div>
  );
}

function HomeTypeFilter({
  draft,
  setDraft,
}: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
}) {
  return (
    <label className="relative inline-flex h-10 shrink-0 items-center rounded-md border border-[#cbd5df] bg-white shadow-sm">
      <Building2 className="ml-3 h-4 w-4 text-[#667482]" />
      <span className="sr-only">Type de bien</span>
      <select
        value={draft.homeTypes[0] ?? "all"}
        onChange={(event) =>
          setDraft((current) => ({
            ...current,
            homeTypes: event.target.value === "all" ? [] : [event.target.value],
          }))
        }
        className="h-full cursor-pointer appearance-none bg-transparent py-0 pl-2 pr-9 text-sm font-bold text-[#132238] outline-none"
      >
        <option value="all">Tous biens</option>
        {HOME_TYPE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 h-4 w-4 text-[#667482]" />
    </label>
  );
}

function SortDropdown({
  sort,
  onChange,
}: {
  sort: SearchSortKey;
  onChange: (sort: SearchSortKey) => void;
}) {
  return (
    <label className="relative inline-flex h-10 shrink-0 items-center rounded-md border border-[#cbd5df] bg-white shadow-sm">
      <ArrowUpDown className="ml-3 h-4 w-4 text-[#667482]" />
      <span className="sr-only">Tri</span>
      <select
        value={sort}
        onChange={(event) => onChange(event.target.value as SearchSortKey)}
        className="h-full cursor-pointer appearance-none bg-transparent py-0 pl-2 pr-9 text-sm font-bold text-[#132238] outline-none"
      >
        {SORT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 h-4 w-4 text-[#667482]" />
    </label>
  );
}

function SaveSearchButton({
  saving,
  locked,
  onClick,
}: {
  saving: boolean;
  locked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={saving}
      className="inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-md bg-[#c98d45] px-3 text-sm font-extrabold text-[#132238] shadow-sm transition-colors hover:bg-[#d69d58] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c98d45] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {saving ? (
        <LoaderCircle className="h-4 w-4 animate-spin" />
      ) : locked ? (
        <LockKeyhole className="h-4 w-4" />
      ) : (
        <Bell className="h-4 w-4" />
      )}
      {locked ? "Alertes Analyse" : "Enregistrer"}
    </button>
  );
}

function CsvExportButton({
  exporting,
  locked,
  onClick,
}: {
  exporting: boolean;
  locked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={exporting}
      title={locked ? "Export CSV réservé au plan Analyse" : "Exporter les résultats en CSV"}
      className={`inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm font-extrabold shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e] disabled:cursor-not-allowed disabled:opacity-60 ${
        locked
          ? "border-[#d6e0dc] bg-white text-[#667482]"
          : "border-[#0f766e] bg-white text-[#0f766e] hover:bg-[#eefaf3]"
      }`}
    >
      {exporting ? (
        <LoaderCircle className="h-4 w-4 animate-spin" />
      ) : (
        <Download className="h-4 w-4" />
      )}
      CSV
    </button>
  );
}

function LayoutToggle({ wideMap, onToggle }: { wideMap: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="hidden h-10 shrink-0 cursor-pointer items-center gap-2 rounded-md border border-[#cbd5df] bg-white px-3 text-sm font-bold text-[#132238] shadow-sm transition-colors hover:border-[#0f766e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e] lg:inline-flex"
      aria-label={wideMap ? "Afficher plus de résultats" : "Afficher plus de carte"}
      title={wideMap ? "Afficher plus de résultats" : "Afficher plus de carte"}
    >
      <LayoutPanelLeft className="h-4 w-4" />
      Vue
    </button>
  );
}

function ResultsSummary({
  search,
  displayCount,
  loadedCount,
  filteredCount,
  hasLocalFilters,
  mapListFollowsViewport,
  mapViewport,
  isLoading,
  geocoding,
}: {
  search: SalesSearchParams;
  displayCount: number;
  loadedCount: number;
  filteredCount: number;
  hasLocalFilters: boolean;
  mapListFollowsViewport: boolean;
  mapViewport: MapViewportChange | null;
  isLoading: boolean;
  geocoding: boolean;
}) {
  const location = search.city || search.department || search.tribunal || search.query || "France";
  const sortLabel =
    SORT_OPTIONS.find((option) => option.value === (search.sort ?? "relevance"))?.label ??
    "Pertinence";

  return (
    <div className="border-b border-[#132238]/10 bg-[#fbfdff] px-4 py-3 backdrop-blur sm:px-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-extrabold leading-tight text-[#132238]">
            {isLoading
              ? "Recherche des dossiers"
              : `${displayCount.toLocaleString("fr-FR")} ventes trouvées`}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-bold text-[#667482]">
            <span>
              {mapListFollowsViewport
                ? "zone visible sur la carte"
                : hasLocalFilters
                  ? `${location} · filtres locaux actifs`
                  : `${location} · ventes immobilières judiciaires`}
            </span>
            <span aria-hidden>·</span>
            <span>tri {sortLabel.toLowerCase()}</span>
            <span aria-hidden>·</span>
            <span>
              {loadedCount.toLocaleString("fr-FR")}{" "}
              {mapListFollowsViewport ? "points carte" : "chargés"}
            </span>
            {filteredCount !== loadedCount ? (
              <>
                <span aria-hidden>·</span>
                <span>{filteredCount.toLocaleString("fr-FR")} affichés</span>
              </>
            ) : null}
            {mapListFollowsViewport && mapViewport ? (
              <>
                <span aria-hidden>·</span>
                <span>zoom {mapViewport.zoom}</span>
              </>
            ) : null}
          </div>
        </div>
        {search.viewport || mapListFollowsViewport || geocoding ? (
          <div className="flex flex-wrap gap-2 text-xs font-bold">
            {mapListFollowsViewport ? (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-[#cbded8] bg-[#eefaf3] px-2.5 py-1 text-[#0f766e]">
                <Map className="h-3.5 w-3.5" />
                liste liée à la carte
              </span>
            ) : null}
            {search.viewport ? (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-[#cbded8] bg-[#eefaf3] px-2.5 py-1 text-[#0f766e]">
                <Map className="h-3.5 w-3.5" />
                URL bbox active
              </span>
            ) : null}
            {geocoding ? (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-[#cbded8] bg-[#eefaf3] px-2.5 py-1 text-[#0f766e]">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                géocodage
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

type SearchStatistics = {
  medianPrice: number | null;
  medianPricePerM2: number | null;
  averageScore: number | null;
  upcomingSales: number;
  dpeCounts: Record<DpeClass, number>;
  dpeKnownCount: number;
};

function SearchStatisticsPanel({
  statistics,
  locked,
  dpeLocked,
  loading,
  dpeExplorer,
  dpeExplorerLoading,
  dpeExplorerError,
  dpeExplorerRequested,
  onLoadDpeExplorer,
}: {
  statistics: SearchStatistics;
  locked: boolean;
  dpeLocked: boolean;
  loading: boolean;
  dpeExplorer?: DpeExplorerResponse;
  dpeExplorerLoading: boolean;
  dpeExplorerError: string | null;
  dpeExplorerRequested: boolean;
  onLoadDpeExplorer: () => void;
}) {
  const items = [
    {
      label: "Prix médian",
      value: formatPrice(statistics.medianPrice),
      preview: "148 000 €",
      icon: <Building2 className="h-4 w-4" />,
    },
    {
      label: "Prix médian / m²",
      value: formatPricePerM2(statistics.medianPricePerM2),
      preview: "2 780 €/m²",
      icon: <Ruler className="h-4 w-4" />,
    },
    {
      label: "Score moyen",
      value: statistics.averageScore == null ? "—" : `${Math.round(statistics.averageScore)}/100`,
      preview: "76/100",
      icon: <ShieldCheck className="h-4 w-4" />,
    },
    {
      label: "DPE repérés",
      value: statistics.dpeKnownCount.toLocaleString("fr-FR"),
      preview: "38",
      icon: <CalendarDays className="h-4 w-4" />,
      locked: dpeLocked,
    },
  ];

  return (
    <div className="border-b border-[#132238]/10 bg-white px-4 py-3 sm:px-5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#132238]">
          <BarChart3 className="h-4 w-4" />
          Workbench
        </div>
        {locked ? (
          <span className="inline-flex items-center gap-1 rounded-md border border-[#ead8c5] bg-[#fffaf2] px-2 py-1 text-[10px] font-bold text-[#8a5b24]">
            <LockKeyhole className="h-3 w-3" />
            Analyse
          </span>
        ) : null}
      </div>
      <dl className="grid grid-cols-2 gap-2">
        {items.map((item) => (
          <div
            key={item.label}
            className="min-w-0 rounded-md border border-[#dce7ee] bg-[#f8fbfd] px-3 py-2"
          >
            <dt className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[#667482]">
              <span className="text-[#0f766e]">{item.icon}</span>
              {item.label}
            </dt>
            <dd
              aria-hidden={locked || item.locked ? "true" : undefined}
              className={`mt-0.5 text-sm font-extrabold tabular-nums text-[#132238] ${
                locked || item.locked ? "select-none blur-[3px]" : ""
              }`}
            >
              {loading ? "…" : locked || item.locked ? item.preview : item.value}
            </dd>
          </div>
        ))}
      </dl>
      {locked && !loading ? (
        <p className="mt-2 flex items-center gap-1.5 text-[10px] font-bold text-[#8a5b24]">
          <LockKeyhole className="h-3 w-3" aria-hidden />
          Valeurs de démonstration — données réelles réservées à Analyse
        </p>
      ) : null}
      {!dpeLocked && !loading ? (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {DPE_CLASSES.map((dpeClass) => {
              const color = dpeColor(dpeClass);
              return (
                <span
                  key={dpeClass}
                  className="inline-flex min-h-7 items-center gap-1 rounded-md border px-2 text-xs font-bold"
                  style={{
                    backgroundColor: color?.background,
                    borderColor: color?.border,
                    color: color?.foreground,
                  }}
                >
                  {dpeClass}
                  <span className="tabular-nums">{statistics.dpeCounts[dpeClass]}</span>
                </span>
              );
            })}
            <button
              type="button"
              onClick={onLoadDpeExplorer}
              disabled={dpeExplorerLoading}
              className="ml-auto inline-flex min-h-7 items-center rounded-md border border-[#cbded8] bg-white px-2.5 text-xs font-extrabold text-[#0f766e] hover:border-[#0f766e] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {dpeExplorerLoading
                ? "Chargement DPE..."
                : dpeExplorerRequested
                  ? "Actualiser DPE"
                  : "Explorer DPE"}
            </button>
          </div>
          {dpeExplorer ? (
            <div className="mt-3 rounded-md border border-[#dce7ee] bg-white p-3">
              <div className="grid gap-2 text-xs sm:grid-cols-3">
                <DpeExplorerMetric label="DPE trouvés" value={dpeExplorer.summary.total} />
                <DpeExplorerMetric
                  label="Classes connues"
                  value={dpeExplorer.summary.knownClassCount}
                />
                <DpeExplorerMetric label="Points carte" value={dpeExplorer.summary.mapPointCount} />
              </div>
              {dpeExplorer.items.length ? (
                <div className="mt-3 divide-y divide-[#132238]/10 border-t border-[#132238]/10">
                  {dpeExplorer.items.slice(0, 3).map((item) => (
                    <div key={item.id} className="grid gap-1 py-2 text-xs sm:grid-cols-[1fr_auto]">
                      <div className="min-w-0">
                        <Link
                          className="font-bold text-[#132238] hover:text-[#0f766e]"
                          to={`/sales/${item.id}`}
                        >
                          {cleanSaleTitle(item.title) ?? "Vente judiciaire"}
                        </Link>
                        <div className="mt-0.5 text-[#667482]">
                          {[item.city, item.department, propertyTypeLabel(item.propertyType)]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </div>
                      <span className="font-extrabold text-[#0f766e]">
                        {item.dpeLabel ?? "DPE repéré"}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-3 border-t border-[#132238]/10 pt-3 text-xs text-[#667482]">
                  Aucun DPE repéré avec ces filtres.
                </p>
              )}
            </div>
          ) : null}
          {dpeExplorerError ? (
            <p className="mt-2 text-xs font-bold text-red-700">{dpeExplorerError}</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function DpeExplorerMetric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#667482]">{label}</div>
      <div className="mt-1 text-sm font-extrabold tabular-nums text-[#132238]">
        {value.toLocaleString("fr-FR")}
      </div>
    </div>
  );
}

function SearchResultsList({
  sales,
  locked,
  analysisLocked,
  isLoading,
  error,
  selectedSaleId,
  hoveredSaleId,
  reduceMotion,
  onHover,
  onSelect,
}: {
  sales: AuctionSale[];
  locked: boolean;
  analysisLocked: boolean;
  isLoading: boolean;
  error: Error | null;
  selectedSaleId: string | null;
  hoveredSaleId: string | null;
  reduceMotion: boolean;
  onHover: (saleId: string | null) => void;
  onSelect: (saleId: string | null) => void;
}) {
  return (
    <div className="px-3 pb-24 pt-3 sm:px-5 lg:pb-6">
      {error ? <ErrorState error={error} /> : null}

      {!isLoading && sales.length === 0 && !error ? <NoResultsState /> : null}

      <div className="grid grid-cols-1 gap-3">
        {isLoading
          ? Array.from({ length: 8 }).map((_, index) => <ListingCardSkeleton key={index} />)
          : sales.map((sale, index) => (
              <ListingCard
                key={sale.id}
                sale={sale}
                locked={locked}
                analysisLocked={analysisLocked}
                active={selectedSaleId === sale.id || hoveredSaleId === sale.id}
                index={index}
                reduceMotion={reduceMotion}
                onHover={onHover}
                onSelect={onSelect}
              />
            ))}
      </div>
    </div>
  );
}

function ListingCard({
  sale,
  locked,
  analysisLocked,
  active,
  index,
  reduceMotion,
  onHover,
  onSelect,
}: {
  sale: AuctionSale;
  locked: boolean;
  analysisLocked: boolean;
  active: boolean;
  index: number;
  reduceMotion: boolean;
  onHover: (saleId: string | null) => void;
  onSelect: (saleId: string | null) => void;
}) {
  const displaySurface = getDisplaySurface(sale);
  const surface = getSaleSurface(sale).value;
  const { isViewed } = useViewedSales();
  const premiumLocked = locked || analysisLocked;
  const viewed = !locked && isViewed(sale.id);
  const fresh = !locked && isNew(sale.created_at);
  const title = locked ? "Détail réservé aux membres" : saleDisplayTitle(sale);
  const location = locked
    ? "Localisation réservée"
    : [sale.address, sale.city, sale.department ? `(${sale.department})` : null]
        .filter(Boolean)
        .join(", ");
  const beds = sale.bedrooms_count ?? sale.rooms_count;
  const baths = sale.bathrooms_count;
  const riskCount = premiumLocked ? 0 : (sale.risks?.length ?? 0);
  const ppm = premiumLocked ? null : pricePerM2(sale.starting_price_eur, surface);
  const dpe = premiumLocked ? null : extractDpe(sale);
  const dpeTheme = dpeColor(dpe?.class);
  const tribunalLabel = locked
    ? "Tribunal réservé"
    : sale.tribunal_city
      ? `TJ ${sale.tribunal_city}`
      : (sale.tribunal_name ?? sale.tribunal ?? "Tribunal à confirmer");
  const score = premiumLocked ? null : sale.investment_score;
  const scoreLabel = premiumLocked
    ? "78/100"
    : score == null
      ? "À auditer"
      : `${Math.round(score)}`;
  const riskLabel = premiumLocked
    ? "3 alertes"
    : riskCount > 1
      ? `${riskCount} alertes`
      : riskCount === 1
        ? "1 alerte"
        : "Faible";
  const riskTone =
    premiumLocked || riskCount > 1
      ? "text-[#8a5b00]"
      : riskCount === 1
        ? "text-[#9c642b]"
        : "text-[#0f766e]";

  return (
    <Link
      id={`sale-card-${sale.id}`}
      to="/sales/$id"
      params={{ id: sale.id }}
      onMouseEnter={() => onHover(sale.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(sale.id)}
      onBlur={() => onHover(null)}
      onClick={() => onSelect(sale.id)}
      className={`group block h-full rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e] ${
        viewed ? "opacity-75" : ""
      }`}
      aria-label={`Voir ${title}`}
    >
      <motion.article
        initial={reduceMotion ? false : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, delay: Math.min(index * 0.025, 0.18) }}
        className={`grid h-full overflow-hidden rounded-md border bg-white shadow-[0_2px_8px_rgba(19,34,56,0.08)] transition duration-200 sm:grid-cols-[9.5rem_1fr] xl:grid-cols-[10.5rem_1fr] ${
          active
            ? "border-[#c98d45] shadow-[0_0_0_2px_rgba(201,141,69,0.22),0_14px_36px_rgba(19,34,56,0.14)]"
            : "border-[#d8e0e7] hover:border-[#c98d45] hover:shadow-md"
        }`}
      >
        <div className="relative aspect-[1.35] overflow-hidden bg-[#edf2f5] sm:aspect-auto sm:min-h-[12.25rem]">
          <ListingImage sale={sale} locked={locked} title={title} />
          <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
            {locked ? (
              <ListingBadge tone="navy" icon={LockKeyhole}>
                Aperçu limité
              </ListingBadge>
            ) : analysisLocked ? (
              <ListingBadge tone="cream" icon={LockKeyhole}>
                Analyse verrouillée
              </ListingBadge>
            ) : fresh ? (
              <ListingBadge tone="teal">Nouveau</ListingBadge>
            ) : (
              <ListingBadge tone="navy">Judiciaire</ListingBadge>
            )}
            {!locked && sale.sale_date ? (
              <ListingBadge tone="cream">{formatDate(sale.sale_date)}</ListingBadge>
            ) : null}
          </div>
          {viewed ? (
            <span className="absolute right-3 top-3 rounded-md bg-white/95 px-2 py-1 text-[11px] font-bold text-[#55626f] shadow-sm">
              Vu
            </span>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-1 flex-col p-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#667482]">
                Mise à prix
              </div>
              <div className="mt-0.5 text-[22px] font-extrabold leading-tight text-[#132238]">
                {formatPrice(sale.starting_price_eur)}
              </div>
              <div className="mt-1 flex min-w-0 items-center gap-1.5 text-sm font-bold text-[#132238]">
                <MapPin className="h-4 w-4 shrink-0 text-[#0f766e]" />
                <span className="truncate">{location || "Adresse à confirmer"}</span>
              </div>
            </div>
            <div className="flex shrink-0 gap-1">
              <ShareButton sale={sale} />
              <CompactFavoriteButton saleId={sale.id} locked={premiumLocked} />
            </div>
          </div>

          <div className="mt-2 min-w-0">
            <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-[#3d4b57]">
              {title}
            </h3>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 text-xs font-bold text-[#3d4b57]">
            <Metric icon={Landmark} label={tribunalLabel} />
            <Metric
              icon={CalendarDays}
              label={locked ? "Audience réservée" : `Audience ${formatDate(sale.sale_date)}`}
            />
            <Metric
              icon={Ruler}
              label={displaySurface.value != null ? displaySurface.label : "Surface n.c."}
            />
            <Metric icon={BedDouble} label={beds != null ? `${beds} ch.` : "Ch. n.c."} />
          </div>

          <div
            className={`relative mt-3 grid grid-cols-3 overflow-hidden rounded-md border border-[#e2e8ee] bg-[#fbfdff] text-xs ${
              premiumLocked ? "select-none" : ""
            }`}
          >
            <ListingSignal
              label="Dossier"
              value={premiumLocked ? "8 pièces" : "Vérifié"}
              tone={premiumLocked ? "text-[#8a5b24] blur-[3px]" : "text-[#0f766e]"}
            />
            <ListingSignal
              label="Score"
              value={scoreLabel}
              tone={`text-[#0f766e] ${premiumLocked ? "blur-[3px]" : ""}`}
            />
            <ListingSignal
              label="Risque"
              value={riskLabel}
              tone={`${riskTone} ${premiumLocked ? "blur-[3px]" : ""}`}
            />
            {analysisLocked ? (
              <span className="pointer-events-none absolute inset-0 grid place-items-center bg-white/35 text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#132238]">
                Plan Analyse
              </span>
            ) : null}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs font-semibold text-[#667482]">
            {locked ? (
              <span>Analyse, pièces et localisation complète après connexion</span>
            ) : analysisLocked ? (
              <>
                <span className="rounded-md bg-[#f0f5f8] px-2 py-1">
                  {propertyTypeLabel(sale.property_type)}
                </span>
                <span className="rounded-md border border-dashed border-[#c98d45] bg-[#fffaf2] px-2 py-1 text-[#8a5b24] blur-[2px]">
                  Occupation analysée
                </span>
                <span className="rounded-md border border-dashed border-[#c98d45] bg-[#fffaf2] px-2 py-1 text-[#8a5b24] blur-[2px]">
                  Prix/m² calculé
                </span>
              </>
            ) : (
              <>
                <span className="rounded-md bg-[#f0f5f8] px-2 py-1">
                  {propertyTypeLabel(sale.property_type)}
                </span>
                <span className="rounded-md bg-[#f0f5f8] px-2 py-1">
                  {occupancyLabel(sale.occupancy_status)}
                </span>
                {ppm != null ? (
                  <span className="rounded-md bg-[#f0f5f8] px-2 py-1">
                    {Math.round(ppm).toLocaleString("fr-FR")} €/m²
                  </span>
                ) : null}
                {dpe?.class ? (
                  <span
                    className="rounded-md border px-2 py-1 font-extrabold"
                    style={{
                      backgroundColor: dpeTheme?.background,
                      borderColor: dpeTheme?.border,
                      color: dpeTheme?.foreground,
                    }}
                  >
                    DPE {dpe.class}
                  </span>
                ) : null}
              </>
            )}
          </div>

          <div className="mt-auto flex items-end justify-between gap-3 pt-3">
            <span className="line-clamp-1 text-[11px] font-bold text-[#8b949e]">
              {locked
                ? "Immojudis"
                : analysisLocked
                  ? "Sources et preuves réservées au plan Analyse"
                  : `Source ${sale.source_name || sale.primary_source || "publique"}${
                      sale.tribunal_city ? ` · ${sale.tribunal_city}` : ""
                    }`}
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[#f4f7f9] px-2 py-1 text-[11px] font-extrabold text-[#132238]">
              Voir le détail
            </span>
          </div>
        </div>
      </motion.article>
    </Link>
  );
}

function ListingImage({
  sale,
  locked,
  title,
}: {
  sale: AuctionSale;
  locked: boolean;
  title: string;
}) {
  const fallback = fallbackImageForSale(sale.id);
  const imageUrl = locked ? fallback : firstPropertyImage(sale.media);
  const mapUrl =
    !imageUrl && !locked && sale.latitude != null && sale.longitude != null
      ? mapboxStaticImageUrl({ lat: sale.latitude, lng: sale.longitude, zoom: 15 })
      : "";
  const src = imageUrl || mapUrl || fallback;

  return (
    <img
      src={src}
      alt={locked ? "" : title}
      loading="lazy"
      decoding="async"
      referrerPolicy="strict-origin-when-cross-origin"
      onError={(event) => {
        if (event.currentTarget.dataset.fallbackApplied === "true") return;
        event.currentTarget.dataset.fallbackApplied = "true";
        event.currentTarget.src = mapUrl || fallback;
      }}
      onLoad={(event) => {
        if (
          locked ||
          event.currentTarget.dataset.fallbackApplied === "true" ||
          !shouldRejectRenderedPropertyImage(event.currentTarget)
        ) {
          return;
        }
        event.currentTarget.dataset.fallbackApplied = "true";
        event.currentTarget.src = mapUrl || fallback;
      }}
      className={`h-full w-full object-cover transition duration-500 group-hover:scale-[1.025] ${
        locked ? "opacity-80" : ""
      }`}
    />
  );
}

function ListingBadge({
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

function Metric({
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

function ListingSignal({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <span className="min-w-0 border-r border-[#e2e8ee] px-2 py-2 last:border-r-0">
      <span className="block text-[9px] font-bold uppercase tracking-[0.08em] text-[#8b949e]">
        {label}
      </span>
      <span className={`mt-0.5 block truncate font-extrabold ${tone}`}>{value}</span>
    </span>
  );
}

function ShareButton({ sale }: { sale: AuctionSale }) {
  async function share(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();

    const url =
      typeof window !== "undefined"
        ? `${window.location.origin}/sales/${sale.id}`
        : `/sales/${sale.id}`;

    try {
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share({ title: saleDisplayTitle(sale, "Vente Immojudis"), url });
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
      className="grid h-8 w-8 cursor-pointer place-items-center rounded-full text-[#132238] transition-colors hover:bg-[#eef2f4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e]"
      aria-label="Partager cette vente"
    >
      <Share2 className="h-5 w-5" />
    </button>
  );
}

function CompactFavoriteButton({ saleId, locked }: { saleId: string; locked: boolean }) {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isFavorite, setIsFavorite] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user || locked) {
      setIsFavorite(false);
      return;
    }

    supabase
      .from("user_favorites")
      .select("sale_id")
      .eq("user_id", user.id)
      .eq("sale_id", saleId)
      .maybeSingle()
      .then(({ data }) => setIsFavorite(Boolean(data)));
  }, [locked, saleId, user]);

  async function toggle(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();

    if (loading) return;
    if (locked) {
      navigate({ to: "/accompagnement" });
      return;
    }
    if (!user) {
      const redirect =
        typeof window !== "undefined"
          ? `${window.location.pathname}${window.location.search}`
          : "/sales";
      navigate({ to: "/login", search: { redirect } });
      return;
    }

    setBusy(true);
    try {
      if (isFavorite) {
        await removeFavoriteSaleRequest({ saleId });
        setIsFavorite(false);
      } else {
        await addFavoriteSaleRequest({ data: { saleId } });
        setIsFavorite(true);
      }
      queryClient.invalidateQueries({ queryKey: ["favorites", user.id] });
    } catch (error) {
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
          ? "Favoris réservés au plan Analyse"
          : isFavorite
            ? "Ne plus suivre cette vente"
            : "Suivre cette vente"
      }
      className="grid h-8 w-8 cursor-pointer place-items-center rounded-full text-[#132238] transition-colors hover:bg-[#eef2f4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {locked ? (
        <LockKeyhole className="h-4 w-4 text-[#8a5b24]" />
      ) : (
        <Heart className={`h-5 w-5 ${isFavorite ? "fill-[#c2410c] text-[#c2410c]" : ""}`} />
      )}
    </button>
  );
}

function MoreFiltersModal({
  open,
  draft,
  setDraft,
  activeFiltersCount,
  onClose,
  onReset,
}: {
  open: boolean;
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
  activeFiltersCount: number;
  onClose: () => void;
  onReset: () => void;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-50 bg-[#132238]/55 p-0 backdrop-blur-sm sm:p-4"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduceMotion ? undefined : { opacity: 0 }}
        >
          <button
            type="button"
            className="absolute inset-0 cursor-default"
            aria-label="Fermer les filtres"
            onClick={onClose}
          />
          <MobileFilterDrawer
            draft={draft}
            setDraft={setDraft}
            activeFiltersCount={activeFiltersCount}
            onClose={onClose}
            onReset={onReset}
          />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function MobileFilterDrawer({
  draft,
  setDraft,
  activeFiltersCount,
  onClose,
  onReset,
}: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
  activeFiltersCount: number;
  onClose: () => void;
  onReset: () => void;
}) {
  return (
    <aside
      role="dialog"
      aria-modal="true"
      aria-labelledby="more-filters-title"
      className="relative ml-auto flex h-full w-full max-w-3xl flex-col overflow-hidden bg-white shadow-2xl sm:rounded-md"
    >
      <div className="flex h-16 shrink-0 items-center justify-between border-b border-[#132238]/10 px-4">
        <div>
          <h2 id="more-filters-title" className="text-base font-extrabold text-[#132238]">
            Filtres avancés
          </h2>
          <p className="text-xs font-semibold text-[#667482]">
            {activeFiltersCount.toLocaleString("fr-FR")} filtre actif
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="grid h-10 w-10 cursor-pointer place-items-center rounded-md border border-[#d6e0dc] bg-white transition-colors hover:bg-[#f4f7f9]"
          aria-label="Fermer"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <div className="grid gap-5 md:grid-cols-2">
          <AdvancedGroup title="Localisation">
            <FilterField label="Département">
              <Input
                value={draft.department}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, department: event.target.value }))
                }
                placeholder="33"
                className="h-10 bg-white"
              />
            </FilterField>
            <FilterField label="Autour de">
              <Input
                value={draft.aroundAddress}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    aroundAddress: event.target.value,
                    aroundRadius:
                      event.target.value && !current.aroundRadius ? "15" : current.aroundRadius,
                  }))
                }
                placeholder="Adresse, ville ou tribunal"
                className="h-10 bg-white"
              />
            </FilterField>
            <FilterField label="Rayon km">
              <Input
                inputMode="numeric"
                value={draft.aroundRadius}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, aroundRadius: event.target.value }))
                }
                placeholder="15"
                className="h-10 bg-white"
              />
            </FilterField>
          </AdvancedGroup>

          <AdvancedGroup title="Prix et surface">
            <FilterField label="Surface minimum">
              <Input
                inputMode="numeric"
                value={draft.minSqft}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, minSqft: event.target.value }))
                }
                placeholder="60"
                className="h-10 bg-white"
              />
            </FilterField>
            <FilterField label="Surface maximum">
              <Input
                inputMode="numeric"
                value={draft.maxSqft}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, maxSqft: event.target.value }))
                }
                placeholder="180"
                className="h-10 bg-white"
              />
            </FilterField>
            <FilterField label="Prix/m² max">
              <Input
                inputMode="numeric"
                value={draft.maxPricePerM2}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, maxPricePerM2: event.target.value }))
                }
                placeholder="3500"
                className="h-10 bg-white"
              />
            </FilterField>
          </AdvancedGroup>

          <AdvancedGroup title="Statut et analyse">
            <FilterField label="Occupation">
              <select
                value={draft.occupancy || "all"}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    occupancy: event.target.value === "all" ? "" : event.target.value,
                  }))
                }
                className="form-input h-10 w-full cursor-pointer bg-white text-sm"
              >
                <option value="all">Toutes</option>
                <option value="free">Libre</option>
                <option value="occupied">Occupé</option>
                <option value="rented">Loué</option>
              </select>
            </FilterField>
            <FilterField label="Score min">
              <Input
                inputMode="numeric"
                value={draft.minScore}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, minScore: event.target.value }))
                }
                placeholder="70"
                className="h-10 bg-white"
              />
            </FilterField>
            <FilterField label="Rendement min">
              <Input
                inputMode="numeric"
                value={draft.minYield}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, minYield: event.target.value }))
                }
                placeholder="5"
                className="h-10 bg-white"
              />
            </FilterField>
            <FilterField label="Décote min">
              <Input
                inputMode="numeric"
                value={draft.minMarketDiscount}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, minMarketDiscount: event.target.value }))
                }
                placeholder="30"
                className="h-10 bg-white"
              />
            </FilterField>
            <label className="flex cursor-pointer items-center gap-3 rounded-md border border-[#d6e0dc] bg-[#f8fbfd] px-3 py-2 text-sm font-bold text-[#132238]">
              <input
                type="checkbox"
                checked={draft.houseWithLand}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, houseWithLand: event.target.checked }))
                }
                className="h-4 w-4 accent-[#0f766e]"
              />
              Maison avec terrain
            </label>
            <div>
              <span className="mb-2 block text-[10px] font-bold uppercase tracking-[0.12em] text-[#667482]">
                DPE
              </span>
              <div className="flex flex-wrap gap-1.5">
                {DPE_CLASSES.map((dpeClass) => (
                  <DpeChipToggle
                    key={dpeClass}
                    dpeClass={dpeClass}
                    active={draft.dpeClasses.includes(dpeClass)}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        dpeClasses: toggleValue(current.dpeClasses, dpeClass),
                      }))
                    }
                  />
                ))}
              </div>
            </div>
          </AdvancedGroup>

          <AdvancedGroup title="Mots-clés et statut">
            <FilterField label="Mots-clés">
              <Input
                value={draft.keywords}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, keywords: event.target.value }))
                }
                placeholder="jardin, garage, occupé..."
                className="h-10 bg-white"
              />
            </FilterField>
            <FilterField label="Année de construction">
              <Input
                inputMode="numeric"
                value={draft.yearBuilt}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, yearBuilt: event.target.value }))
                }
                placeholder="1990"
                className="h-10 bg-white"
              />
            </FilterField>
            <label className="flex cursor-pointer items-center gap-3 rounded-md border border-[#d6e0dc] bg-[#f8fbfd] px-3 py-2 text-sm font-bold text-[#132238]">
              <input
                type="checkbox"
                checked={draft.openHouse}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, openHouse: event.target.checked }))
                }
                className="h-4 w-4 accent-[#0f766e]"
              />
              Visite disponible
            </label>
          </AdvancedGroup>
        </div>

        <AdvancedGroup title="Types de biens" className="mt-5">
          <div className="flex flex-wrap gap-2">
            {HOME_TYPE_OPTIONS.map((option) => (
              <ChipToggle
                key={option.value}
                active={draft.homeTypes.includes(option.value)}
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    homeTypes: toggleValue(current.homeTypes, option.value),
                  }))
                }
              >
                {option.label}
              </ChipToggle>
            ))}
          </div>
        </AdvancedGroup>

        <AdvancedGroup title="Statuts" className="mt-5">
          <div className="flex flex-wrap gap-2">
            {STATUS_OPTIONS.map((option) => (
              <ChipToggle
                key={option.value}
                active={draft.status.includes(option.value)}
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    status: toggleValue(current.status, option.value),
                  }))
                }
              >
                {option.label}
              </ChipToggle>
            ))}
          </div>
        </AdvancedGroup>
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-[#132238]/10 p-4 sm:flex-row sm:justify-between">
        <button
          type="button"
          onClick={onReset}
          className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-[#ead8c5] bg-[#fffaf2] px-4 text-sm font-bold text-[#8a5b24] transition-colors hover:border-[#c98d45]"
        >
          <RotateCcw className="h-4 w-4" />
          Réinitialiser
        </button>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-10 cursor-pointer items-center justify-center rounded-md bg-[#132238] px-4 text-sm font-bold text-white transition-colors hover:bg-[#1f3657]"
        >
          Afficher les résultats
        </button>
      </div>
    </aside>
  );
}

function AdvancedGroup({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={className}>
      <h3 className="mb-3 text-sm font-extrabold text-[#132238]">{title}</h3>
      <div className="grid gap-3">{children}</div>
    </section>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="space-y-1">
      <span className="block text-[10px] font-bold uppercase tracking-[0.12em] text-[#667482]">
        {label}
      </span>
      {children}
    </label>
  );
}

function ChipToggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex h-9 cursor-pointer items-center rounded-md border px-3 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e] ${
        active
          ? "border-[#0f766e] bg-[#0f766e] text-white"
          : "border-[#d6e0dc] bg-white text-[#132238] hover:border-[#0f766e]"
      }`}
    >
      {children}
    </button>
  );
}

function DpeChipToggle({
  active,
  dpeClass,
  onClick,
}: {
  active: boolean;
  dpeClass: DpeClass;
  onClick: () => void;
}) {
  const color = dpeColor(dpeClass);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="inline-flex h-9 min-w-9 cursor-pointer items-center justify-center rounded-md border px-2 text-sm font-extrabold transition-transform hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e]"
      style={{
        backgroundColor: active ? color?.background : "#ffffff",
        borderColor: color?.border,
        color: active ? color?.foreground : "#132238",
      }}
    >
      {dpeClass}
    </button>
  );
}

function MobileMapToggle({
  activeFiltersCount,
  onOpenFilters,
  onOpenMap,
}: {
  activeFiltersCount: number;
  onOpenFilters: () => void;
  onOpenMap: () => void;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-2 gap-2 border-t border-[#132238]/10 bg-white/95 p-2 shadow-[0_-14px_34px_rgba(19,34,56,0.12)] backdrop-blur lg:hidden">
      <button
        type="button"
        onClick={onOpenFilters}
        className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-md px-3 text-sm font-extrabold text-[#132238] transition-colors hover:bg-[#f4f7f9]"
      >
        <ListFilter className="h-4 w-4" />
        Filtres
        {activeFiltersCount > 0 ? (
          <span className="rounded-full bg-[#0f766e] px-1.5 py-0.5 text-[10px] text-white">
            {activeFiltersCount}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        onClick={onOpenMap}
        className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-md bg-[#132238] px-4 text-sm font-extrabold text-white transition-colors hover:bg-[#1f3657]"
      >
        <Map className="h-4 w-4" />
        Carte
      </button>
    </div>
  );
}

function PaginationControls({
  hasMore,
  isFetching,
  loadedCount,
  totalCount,
  mapListFollowsViewport,
  onLoadMore,
}: {
  hasMore: boolean;
  isFetching: boolean;
  loadedCount: number;
  totalCount: number | undefined;
  mapListFollowsViewport: boolean;
  onLoadMore: () => void;
}) {
  if (!hasMore && loadedCount === 0) return null;

  return (
    <div className="px-4 pb-10 pt-2 text-center sm:px-5">
      {hasMore ? (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={isFetching}
          className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-[#cbd5df] bg-white px-4 text-sm font-bold text-[#132238] transition-colors hover:border-[#0f766e] hover:text-[#0f766e] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isFetching ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
          {isFetching ? "Chargement..." : "Charger plus"}
        </button>
      ) : (
        <div className="text-xs font-bold uppercase tracking-[0.16em] text-[#8b949e]">
          {mapListFollowsViewport && totalCount != null && loadedCount < totalCount
            ? `${loadedCount.toLocaleString("fr-FR")} affichés / ${totalCount.toLocaleString(
                "fr-FR",
              )} dans la carte`
            : totalCount != null
              ? `${loadedCount.toLocaleString("fr-FR")} / ${totalCount.toLocaleString(
                  "fr-FR",
                )} dossiers`
              : "Tous les dossiers chargés"}
        </div>
      )}
    </div>
  );
}

function NoResultsState() {
  return (
    <div className="rounded-md border border-[#d8dee4] bg-white p-10 text-center shadow-sm">
      <SearchIcon className="mx-auto h-8 w-8 text-[#0f766e]" />
      <h2 className="mt-4 text-xl font-extrabold text-[#132238]">Aucun dossier trouvé</h2>
      <p className="mt-2 text-sm font-medium text-[#55626f]">
        Essayez une autre ville, un autre tribunal ou élargissez les critères.
      </p>
    </div>
  );
}

function ErrorState({ error }: { error: Error }) {
  return (
    <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700">
      {error.message || "Erreur de chargement des résultats"}
    </div>
  );
}

function ListingCardSkeleton() {
  return (
    <div className="grid overflow-hidden rounded-md border border-[#d8dee4] bg-white shadow-sm sm:grid-cols-[12.5rem_1fr]">
      <Skeleton className="aspect-[1.5] w-full rounded-none bg-[#eef2f4] sm:aspect-auto sm:min-h-[13rem]" />
      <div className="space-y-3 p-4">
        <div className="flex justify-between gap-3">
          <div className="flex-1 space-y-2">
            <Skeleton className="h-7 w-1/2 bg-[#eef2f4]" />
            <Skeleton className="h-4 w-3/4 bg-[#eef2f4]" />
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-8 w-8 rounded-full bg-[#eef2f4]" />
            <Skeleton className="h-8 w-8 rounded-full bg-[#eef2f4]" />
          </div>
        </div>
        <Skeleton className="h-4 w-full bg-[#eef2f4]" />
        <Skeleton className="h-4 w-4/5 bg-[#eef2f4]" />
        <Skeleton className="h-5 w-24 bg-[#eef2f4]" />
      </div>
    </div>
  );
}

function MapPanelSkeleton() {
  return (
    <div className="grid h-full min-h-[28rem] place-items-center bg-[#e7f4ef]">
      <div className="inline-flex items-center gap-2 rounded-md border border-[#cbded8] bg-white px-4 py-3 text-sm font-bold text-[#132238] shadow-lg">
        <LoaderCircle className="h-4 w-4 animate-spin text-[#0f766e]" />
        Chargement de la carte
      </div>
    </div>
  );
}

function Footer() {
  return (
    <footer className="border-t border-[#132238]/10 px-4 py-8 text-xs font-semibold text-[#667482] sm:px-5">
      Les informations doivent être vérifiées dans les pièces officielles avant toute décision
      d’enchère.
    </footer>
  );
}

function searchToDraft(search: SalesSearchParams): SearchDraft {
  return {
    city: search.city ?? "",
    department: search.department ?? "",
    tribunal: search.tribunal ?? "",
    query: search.query ?? "",
    minPrice: stringifyNumber(search.minPrice),
    maxPrice: stringifyNumber(search.maxPrice),
    minBeds: stringifyNumber(search.minBeds),
    minBaths: stringifyNumber(search.minBaths),
    minSqft: stringifyNumber(search.minSqft),
    maxSqft: stringifyNumber(search.maxSqft),
    homeTypes: search.homeTypes ?? [],
    status: search.status ?? [],
    keywords: search.keywords ?? "",
    occupancy: search.occupancy ?? "",
    dpeClasses: search.dpeClasses ?? [],
    minScore: stringifyNumber(search.minScore),
    maxPricePerM2: stringifyNumber(search.maxPricePerM2),
    minYield: stringifyNumber(search.minYield),
    minMarketDiscount: stringifyNumber(search.minMarketDiscount),
    houseWithLand: Boolean(search.houseWithLand),
    aroundAddress: search.aroundAddress ?? "",
    aroundRadius: stringifyNumber(search.aroundRadius),
    yearBuilt: stringifyNumber(search.yearBuilt),
    openHouse: Boolean(search.openHouse),
  };
}

function emptySearchDraft(): SearchDraft {
  return {
    city: "",
    department: "",
    tribunal: "",
    query: "",
    minPrice: "",
    maxPrice: "",
    minBeds: "",
    minBaths: "",
    minSqft: "",
    maxSqft: "",
    homeTypes: [],
    status: [],
    keywords: "",
    occupancy: "",
    dpeClasses: [],
    minScore: "",
    maxPricePerM2: "",
    minYield: "",
    minMarketDiscount: "",
    houseWithLand: false,
    aroundAddress: "",
    aroundRadius: "",
    yearBuilt: "",
    openHouse: false,
  };
}

function draftToSearch(draft: SearchDraft, current: SalesSearchParams): SalesSearchParams {
  return {
    sort: current.sort,
    viewport: current.viewport,
    limit: current.limit,
    map: current.map,
    searchAsMove: current.searchAsMove,
    city: cleanString(draft.city),
    department: cleanString(draft.department),
    tribunal: cleanString(draft.tribunal),
    query: cleanString(draft.query),
    minPrice: draftNumber(draft.minPrice),
    maxPrice: draftNumber(draft.maxPrice),
    minBeds: draftNumber(draft.minBeds),
    minBaths: draftNumber(draft.minBaths),
    minSqft: draftNumber(draft.minSqft),
    maxSqft: draftNumber(draft.maxSqft),
    homeTypes: draft.homeTypes.length ? draft.homeTypes : undefined,
    status: draft.status.length ? draft.status : undefined,
    keywords: cleanString(draft.keywords),
    occupancy: cleanString(draft.occupancy),
    dpeClasses: draft.dpeClasses.length ? draft.dpeClasses : undefined,
    minScore: draftNumber(draft.minScore),
    maxPricePerM2: draftNumber(draft.maxPricePerM2),
    minYield: draftNumber(draft.minYield),
    minMarketDiscount: draftNumber(draft.minMarketDiscount),
    houseWithLand: draft.houseWithLand || undefined,
    aroundAddress: cleanString(draft.aroundAddress),
    aroundRadius: draftNumber(draft.aroundRadius),
    yearBuilt: draftNumber(draft.yearBuilt),
    openHouse: draft.openHouse || undefined,
  };
}

function stringifyNumber(value: number | undefined) {
  return value == null ? "" : String(value);
}

function draftNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function cleanString(value: string) {
  return value.trim() || undefined;
}

function toggleValue(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function stableUrlRecord(record: SalesSearchUrlRecord) {
  return JSON.stringify(
    Object.entries(record)
      .filter(([, value]) => value != null && value !== "")
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

function downloadBlob(blob: Blob, filename: string) {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function buildSearchStatistics(sales: AuctionSale[]): SearchStatistics {
  const prices = sales
    .map((sale) => sale.starting_price_eur)
    .filter((value): value is number => value != null && Number.isFinite(value) && value > 0);
  const pricePerM2Values = sales
    .map((sale) => pricePerM2(sale.starting_price_eur, getSaleSurface(sale).value))
    .filter((value): value is number => value != null && Number.isFinite(value) && value > 0);
  const scores = sales
    .map((sale) => sale.investment_score)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const dpeCounts = DPE_CLASSES.reduce(
    (acc, dpeClass) => {
      acc[dpeClass] = 0;
      return acc;
    },
    {} as Record<DpeClass, number>,
  );
  let dpeKnownCount = 0;
  sales.forEach((sale) => {
    const dpe = extractDpe(sale).class;
    if (!dpe) return;
    dpeCounts[dpe] += 1;
    dpeKnownCount += 1;
  });
  const now = Date.now();

  return {
    medianPrice: median(prices),
    medianPricePerM2: median(pricePerM2Values),
    averageScore: scores.length
      ? scores.reduce((total, value) => total + value, 0) / scores.length
      : null,
    upcomingSales: sales.filter(
      (sale) => sale.sale_date && new Date(sale.sale_date).getTime() >= now,
    ).length,
    dpeCounts,
    dpeKnownCount,
  };
}

function searchStatisticsFromServer(summary: SalesStatisticsResponse["summary"]): SearchStatistics {
  return {
    medianPrice: summary.medianPriceEur,
    medianPricePerM2: summary.medianPricePerM2,
    averageScore: summary.averageInvestmentScore,
    upcomingSales: summary.upcomingSales,
    dpeCounts: summary.dpeCounts,
    dpeKnownCount: summary.dpeKnownCount,
  };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return Math.round(sorted[middle]);
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(query);
    setMatches(media.matches);

    const onChange = () => setMatches(media.matches);
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    }
    if (typeof media.addListener === "function") {
      media.addListener(onChange);
      return () => media.removeListener(onChange);
    }
    return undefined;
  }, [query]);

  return matches;
}

function buildAlertName(search: SalesSearchParams) {
  const segments = [
    search.city,
    search.tribunal,
    search.department ? `Dép. ${search.department}` : null,
    search.homeTypes?.length === 1 ? propertyTypeLabel(search.homeTypes[0]) : null,
    search.maxPrice ? `≤ ${compactPrice(search.maxPrice)}` : null,
    search.minYield ? `rendement ≥ ${search.minYield}%` : null,
    search.dpeClasses?.length ? `DPE ${search.dpeClasses.join("/")}` : null,
  ].filter(Boolean);

  return segments.length > 0 ? `Recherche ${segments.join(" · ")}` : "Recherche Immojudis";
}

async function watchedZoneInputFromSearch(
  search: SalesSearchParams,
  center: GeoPoint | null,
): Promise<WatchedZoneInput | null> {
  const alertDefaults = alertDefaultsFromSearch(search);

  if (search.aroundAddress) {
    const point = center ?? (await geocodeAddress(search.aroundAddress));
    if (point) {
      return {
        name: clampZoneName(`Rayon ${point.label ?? search.aroundAddress}`),
        zoneKind: "radius",
        department: search.department ?? null,
        city: search.city ?? null,
        centerLat: point.lat,
        centerLng: point.lng,
        radiusKm: search.aroundRadius ?? 10,
        alertDefaults,
        isActive: true,
      };
    }
  }

  if (search.city) {
    return {
      name: clampZoneName(
        search.department ? `${search.city} (${search.department})` : search.city,
      ),
      zoneKind: "city",
      department: search.department ?? null,
      city: search.city,
      alertDefaults,
      isActive: true,
    };
  }

  if (search.department) {
    return {
      name: `Département ${search.department}`,
      zoneKind: "department",
      department: search.department,
      alertDefaults,
      isActive: true,
    };
  }

  return null;
}

function alertDefaultsFromSearch(search: SalesSearchParams): WatchedZoneInput["alertDefaults"] {
  return {
    maxPriceEur: search.maxPrice ?? null,
    minSurfaceM2: search.minSqft ?? null,
    minInvestmentScore: search.minScore ?? null,
    maxPricePerM2: search.maxPricePerM2 ?? null,
    minYieldPct: search.minYield ?? null,
    minMarketDiscountPct: search.minMarketDiscount ?? null,
    dpeClasses: (search.dpeClasses ?? []).filter((value): value is DpeClass =>
      DPE_CLASSES.includes(value as DpeClass),
    ),
    requireHouseWithLand: Boolean(search.houseWithLand),
  };
}

function clampZoneName(value: string): string {
  return value.trim().slice(0, 120) || "Zone surveillée";
}

function fallbackImageForSale(id: string) {
  const images = [
    "/media/landing/auction-lyon.jpg",
    "/media/landing/auction-nantes.jpg",
    "/media/landing/auction-bordeaux.jpg",
    "/media/landing/auction-toulouse.jpg",
  ];
  const index = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % images.length;
  return images[index] ?? images[0];
}
