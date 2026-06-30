import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Bell from "lucide-react/dist/esm/icons/bell.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import Heart from "lucide-react/dist/esm/icons/heart.js";
import LayoutPanelTop from "lucide-react/dist/esm/icons/layout-panel-top.js";
import Layers from "lucide-react/dist/esm/icons/layers.js";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import Map from "lucide-react/dist/esm/icons/map.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import Minus from "lucide-react/dist/esm/icons/minus.js";
import Navigation from "lucide-react/dist/esm/icons/navigation.js";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import SearchIcon from "lucide-react/dist/esm/icons/search.js";
import Share2 from "lucide-react/dist/esm/icons/share-2.js";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { useViewedSales } from "@/hooks/use-viewed-sales";
import { supabase } from "@/integrations/supabase/client";
import {
  addFavorite,
  createAlert,
  getSales,
  getSalesCount,
  getSalesPreviewCount,
  getSalesWithCoords,
  removeFavorite,
} from "@/lib/queries";
import {
  asFiniteNumber,
  asSearchString,
  asSortKey,
  type AuctionSale,
  type SaleFilters,
  type SortKey,
} from "@/lib/types";
import { formatDate, formatPrice, occupancyLabel, propertyTypeLabel } from "@/lib/format";
import {
  estimateGrossYieldPct,
  geocodeAddress,
  haversineKm,
  pricePerM2,
  type GeoPoint,
} from "@/lib/geo";
import { getGoogleMapsApiKey, googleStaticMapUrl, loadGoogleMaps } from "@/lib/google-maps";
import { firstPropertyImage, shouldRejectRenderedPropertyImage } from "@/lib/sale-media";
import { getDisplaySurface, getSaleSurface } from "@/lib/surface";
import { isNew } from "@/lib/dates";

const PAGE_SIZE = 24;
const DEFAULT_MAP_CENTER = { lat: 46.7111, lng: 1.7191 };
const MAX_MAP_MARKERS = 300;

type SalesSearchParams = {
  department?: string;
  city?: string;
  type?: string;
  max_price?: number;
  min_surface?: number;
  occupancy?: string;
  min_score?: number;
  sort?: SortKey;
  max_price_per_m2?: number;
  min_yield?: number;
  around_address?: string;
  around_radius?: number;
};

type ToolbarState = {
  department: string;
  city: string;
  type: string;
  max_price: string;
  min_surface: string;
  occupancy: string;
  min_score: string;
  max_price_per_m2: string;
  min_yield: string;
  around_address: string;
  around_radius: string;
};

export const Route = createFileRoute("/sales/")({
  validateSearch: (search: Record<string, unknown>): SalesSearchParams => ({
    department: asSearchString(search.department),
    city: asSearchString(search.city),
    type: asSearchString(search.type),
    max_price: asFiniteNumber(search.max_price),
    min_surface: asFiniteNumber(search.min_surface),
    occupancy: asSearchString(search.occupancy),
    min_score: asFiniteNumber(search.min_score),
    sort: asSortKey(search.sort),
    max_price_per_m2: asFiniteNumber(search.max_price_per_m2),
    min_yield: asFiniteNumber(search.min_yield),
    around_address: asSearchString(search.around_address),
    around_radius: asFiniteNumber(search.around_radius),
  }),
  head: () => ({
    meta: [
      { title: "Annonces — Immojudis" },
      {
        name: "description",
        content: "Consultez toutes les ventes aux enchères immobilières disponibles.",
      },
    ],
  }),
  component: SalesPage,
});

function SalesPage() {
  const search = Route.useSearch();
  const { user, loading: authLoading } = useAuth();
  const isPreview = !user;
  const filters: SaleFilters = {
    department: search.department,
    city: search.city,
    property_type: search.type,
    max_price: search.max_price,
    min_surface: search.min_surface,
    occupancy_status: search.occupancy,
    min_score: search.min_score,
  };
  const sort = search.sort || "score_desc";
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const [hoveredSaleId, setHoveredSaleId] = useState<string | null>(null);
  const [selectedSaleId, setSelectedSaleId] = useState<string | null>(null);
  const [wideMap, setWideMap] = useState(false);

  const { data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage, error } =
    useInfiniteQuery({
      queryKey: ["sales", filters, sort, isPreview],
      queryFn: ({ pageParam = 0 }) =>
        getSales(filters, PAGE_SIZE, sort, pageParam, { preview: isPreview }),
      initialPageParam: 0,
      enabled: !authLoading,
      getNextPageParam: (lastPage, allPages) =>
        lastPage.length < PAGE_SIZE ? undefined : allPages.length * PAGE_SIZE,
      staleTime: 60_000,
    });

  const { data: totalCount, isLoading: isCountLoading } = useQuery({
    queryKey: ["sales-count", filters, isPreview],
    queryFn: () => (isPreview ? getSalesPreviewCount(filters) : getSalesCount(filters)),
    enabled: !authLoading,
    staleTime: 60_000,
  });

  const { data: mapData, isLoading: isMapLoading } = useQuery({
    queryKey: ["sales-map", filters, sort, isPreview],
    queryFn: () => getSalesWithCoords(filters, MAX_MAP_MARKERS, sort),
    enabled: !authLoading && !isPreview,
    staleTime: 60_000,
  });

  const sales = useMemo(() => data?.pages.flat() ?? [], [data]);
  const isInitialLoading = authLoading || isLoading;

  const [center, setCenter] = useState<GeoPoint | null>(null);
  const [geocoding, setGeocoding] = useState(false);

  useEffect(() => {
    if (!search.around_address) {
      setCenter(null);
      return;
    }

    let cancelled = false;
    setGeocoding(true);
    geocodeAddress(search.around_address).then((point) => {
      if (cancelled) return;
      setCenter(point);
      setGeocoding(false);
    });

    return () => {
      cancelled = true;
    };
  }, [search.around_address]);

  const hasLocalFilters =
    !isPreview && Boolean(search.max_price_per_m2 || search.min_yield || center);

  const applyClientFilters = useCallback(
    (items: AuctionSale[]) => {
      if (isPreview) return items;

      return items.filter((sale) => {
        const surface = getSaleSurface(sale).value;

        if (search.max_price_per_m2 != null) {
          const ppm = pricePerM2(sale.starting_price_eur, surface);
          if (ppm == null || ppm > search.max_price_per_m2) return false;
        }

        if (search.min_yield != null) {
          const yieldPct = estimateGrossYieldPct(sale.starting_price_eur, surface, sale.department);
          if (yieldPct == null || yieldPct < search.min_yield) return false;
        }

        if (center && search.around_radius != null) {
          if (sale.latitude == null || sale.longitude == null) return false;
          const distance = haversineKm(center, { lat: sale.latitude, lng: sale.longitude });
          if (distance > search.around_radius) return false;
        }

        return true;
      });
    },
    [center, isPreview, search.around_radius, search.max_price_per_m2, search.min_yield],
  );

  const filtered = useMemo(() => applyClientFilters(sales), [applyClientFilters, sales]);

  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node || !hasNextPage || isInitialLoading || isFetchingNextPage) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void fetchNextPage();
      },
      { rootMargin: "720px 0px" },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, isInitialLoading, filtered.length]);

  const handleMapSelect = useCallback((saleId: string) => {
    setSelectedSaleId(saleId);
    window.setTimeout(() => {
      document.getElementById(`sale-card-${saleId}`)?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
    }, 40);
  }, []);

  const titleLocation = search.city
    ? search.city
    : search.department
      ? `Département ${search.department}`
      : search.around_address
        ? search.around_address
        : "France";
  const loadedCount = sales.length;
  const filteredCount = filtered.length;
  const displayTotalCount =
    isPreview && totalCount === 0 && loadedCount > 0 ? loadedCount : totalCount;
  const primaryCount = hasLocalFilters ? filteredCount : (displayTotalCount ?? filteredCount);
  const primaryCountLabel = hasLocalFilters ? "dossiers affichés" : "dossiers disponibles";
  const isPrimaryCountLoading =
    isInitialLoading || (!hasLocalFilters && isCountLoading && totalCount == null);
  const mapSales = useMemo(
    () =>
      applyClientFilters(mapData ?? sales)
        .filter(hasCoordinates)
        .slice(0, MAX_MAP_MARKERS),
    [applyClientFilters, mapData, sales],
  );
  const splitClass = wideMap
    ? "lg:grid-cols-[minmax(420px,34vw)_1fr]"
    : "lg:grid-cols-[minmax(560px,42vw)_1fr]";

  return (
    <main className="min-h-screen bg-white text-[#1f2933]">
      <SalesToolbar
        search={search}
        loadedCount={loadedCount}
        filteredCount={filteredCount}
        totalCount={totalCount}
        hasLocalFilters={hasLocalFilters}
        isLoading={isInitialLoading}
        isCountLoading={isCountLoading}
        wideMap={wideMap}
        onToggleLayout={() => setWideMap((value) => !value)}
      />

      <div className={`grid min-h-[calc(100vh-57px)] ${splitClass}`}>
        <section className="min-w-0 border-r border-[#d8dee4] bg-white">
          <div className="sticky top-[57px] z-20 border-b border-[#d8dee4] bg-white/96 px-4 py-4 backdrop-blur sm:px-5 lg:top-0">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h1 className="font-sans text-[21px] font-bold leading-tight tracking-normal text-[#1f2933]">
                  {titleLocation} ventes immobilières judiciaires
                </h1>
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-[#55626f]">
                  <span>
                    {isPrimaryCountLoading ? "Chargement" : primaryCount.toLocaleString("fr-FR")}{" "}
                    {primaryCountLabel}
                  </span>
                  <span aria-hidden>·</span>
                  <span>{loadedCount.toLocaleString("fr-FR")} cartes chargées</span>
                  {geocoding ? (
                    <span className="inline-flex items-center gap-1 text-[#087f5b]">
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      géocodage
                    </span>
                  ) : null}
                </div>
              </div>

              <SortControl sort={sort} search={search} />
            </div>

            {center && search.around_radius != null ? (
              <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold text-[#3d4b57]">
                <span className="inline-flex items-center gap-1.5 rounded-md border border-[#d8e6dd] bg-[#eefaf3] px-2.5 py-1">
                  <MapPin className="h-3.5 w-3.5 text-[#087f5b]" />
                  {center.label} · rayon {search.around_radius} km
                </span>
                {hasLocalFilters ? (
                  <span className="inline-flex items-center gap-1.5 rounded-md border border-[#eadcc8] bg-[#fff8ec] px-2.5 py-1">
                    <SlidersHorizontal className="h-3.5 w-3.5 text-[#9c642b]" />
                    filtres d'analyse
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="px-4 pb-8 pt-4 sm:px-5">
            {error ? (
              <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-700">
                {error instanceof Error ? error.message : "Erreur de chargement"}
              </div>
            ) : null}

            {!isInitialLoading && filtered.length === 0 && !error ? (
              <EmptyResults />
            ) : (
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                {isInitialLoading
                  ? Array.from({ length: 8 }).map((_, index) => <ListingCardSkeleton key={index} />)
                  : filtered.map((sale) => (
                      <ListingCard
                        key={sale.id}
                        sale={sale}
                        locked={isPreview}
                        active={selectedSaleId === sale.id || hoveredSaleId === sale.id}
                        onHover={setHoveredSaleId}
                        onSelect={setSelectedSaleId}
                      />
                    ))}
              </div>
            )}

            <div ref={loadMoreRef} className="h-1" aria-hidden />

            {!isInitialLoading && (hasNextPage || isFetchingNextPage) ? (
              <div className="mt-8 flex justify-center">
                <button
                  type="button"
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                  className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-[#cbd5df] bg-white px-4 text-sm font-semibold text-[#1f2933] transition-colors hover:border-[#087f5b] hover:text-[#087f5b] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isFetchingNextPage ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
                  {isFetchingNextPage ? "Chargement..." : "Charger plus d'annonces"}
                </button>
              </div>
            ) : null}

            {!isInitialLoading && !hasNextPage && filtered.length > 0 ? (
              <div className="mt-8 text-center text-xs font-bold uppercase tracking-[0.16em] text-[#7b8794]">
                Tous les dossiers chargés
              </div>
            ) : null}
          </div>
        </section>

        <aside className="relative hidden min-h-[calc(100vh-57px)] bg-[#dceee5] lg:block">
          <SalesGoogleMap
            sales={mapSales}
            hoveredSaleId={hoveredSaleId}
            selectedSaleId={selectedSaleId}
            isLoading={isInitialLoading || isMapLoading}
            onHover={setHoveredSaleId}
            onSelect={handleMapSelect}
          />
        </aside>
      </div>
    </main>
  );
}

function SalesToolbar({
  search,
  loadedCount,
  filteredCount,
  totalCount,
  hasLocalFilters,
  isLoading,
  isCountLoading,
  wideMap,
  onToggleLayout,
}: {
  search: SalesSearchParams;
  loadedCount: number;
  filteredCount: number;
  totalCount: number | undefined;
  hasLocalFilters: boolean;
  isLoading: boolean;
  isCountLoading: boolean;
  wideMap: boolean;
  onToggleLayout: () => void;
}) {
  const navigate = useNavigate({ from: "/sales" });
  const { user } = useAuth();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [savingAlert, setSavingAlert] = useState(false);
  const [local, setLocal] = useState<ToolbarState>(() => searchToToolbarState(search));
  const firstRun = useRef(true);

  useEffect(() => {
    setLocal(searchToToolbarState(search));
  }, [search]);

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }

    const timeout = window.setTimeout(() => {
      const next = toolbarStateToSearch(local, search.sort);
      navigate({ search: next, replace: true });
    }, 320);

    return () => window.clearTimeout(timeout);
  }, [local, navigate, search.sort]);

  const activeCount = countActiveFilters(local);
  const count = hasLocalFilters ? filteredCount : (totalCount ?? filteredCount);
  const countLoading = isLoading || (!hasLocalFilters && isCountLoading && totalCount == null);
  const hasAlertFilters = Boolean(
    local.department ||
    local.city ||
    local.type ||
    local.max_price ||
    local.min_surface ||
    local.occupancy ||
    local.min_score,
  );

  async function saveSearch() {
    if (!user) {
      toast.error("Connectez-vous pour enregistrer une recherche");
      return;
    }
    if (!hasAlertFilters) {
      toast.error("Définissez au moins un filtre avant d'enregistrer");
      return;
    }

    setSavingAlert(true);
    try {
      await createAlert(user.id, {
        name: buildAlertName(local),
        department: local.department || null,
        city: local.city || null,
        property_type: local.type || null,
        max_price_eur: local.max_price ? Number(local.max_price) : null,
        min_surface_m2: local.min_surface ? Number(local.min_surface) : null,
        occupancy_status: local.occupancy || null,
        min_investment_score: local.min_score ? Number(local.min_score) : null,
      });
      toast.success("Recherche enregistrée");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Erreur");
    } finally {
      setSavingAlert(false);
    }
  }

  function resetFilters() {
    setLocal(emptyToolbarState());
    navigate({ search: search.sort ? { sort: search.sort } : {}, replace: true });
  }

  return (
    <header className="sticky top-0 z-40 border-b border-[#d8dee4] bg-white/96 px-3 py-2 backdrop-blur sm:px-4">
      <div className="flex min-h-10 items-center gap-2 overflow-x-auto">
        <ToolbarSelect
          label="Vente"
          value="judicial"
          onChange={() => undefined}
          options={[{ label: "Ventes judiciaires", value: "judicial" }]}
        />
        <ToolbarSelect
          label="Prix"
          value={local.max_price || "all"}
          onChange={(value) => setLocal({ ...local, max_price: value === "all" ? "" : value })}
          options={[
            { label: "Prix", value: "all" },
            { label: "≤ 100 k€", value: "100000" },
            { label: "≤ 200 k€", value: "200000" },
            { label: "≤ 500 k€", value: "500000" },
            { label: "≤ 1 M€", value: "1000000" },
          ]}
        />
        <ToolbarSelect
          label="Surface"
          value={local.min_surface || "all"}
          onChange={(value) => setLocal({ ...local, min_surface: value === "all" ? "" : value })}
          options={[
            { label: "Surface", value: "all" },
            { label: "≥ 30 m²", value: "30" },
            { label: "≥ 60 m²", value: "60" },
            { label: "≥ 100 m²", value: "100" },
            { label: "≥ 200 m²", value: "200" },
          ]}
        />

        <button
          type="button"
          onClick={() => setFiltersOpen((value) => !value)}
          className="inline-flex h-10 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md border border-[#cbd5df] bg-white px-3 text-sm font-bold text-[#1f2933] shadow-sm transition-colors hover:border-[#087f5b] hover:text-[#087f5b]"
          aria-expanded={filtersOpen}
        >
          <SlidersHorizontal className="h-4 w-4" />
          Filtres
          {activeCount > 0 ? (
            <span className="rounded-full bg-[#087f5b] px-1.5 py-0.5 text-[10px] text-white">
              {activeCount}
            </span>
          ) : null}
        </button>

        <button
          type="button"
          onClick={saveSearch}
          disabled={savingAlert}
          className="inline-flex h-10 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md bg-[#e33446] px-4 text-sm font-bold text-white shadow-sm transition-colors hover:bg-[#c9293a] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {savingAlert ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <Bell className="h-4 w-4" />
          )}
          Enregistrer
        </button>

        <button
          type="button"
          onClick={onToggleLayout}
          className="ml-auto hidden h-10 shrink-0 cursor-pointer flex-col items-center justify-center rounded-md border border-[#d8dee4] bg-white px-2 text-[10px] font-semibold leading-none text-[#3d4b57] shadow-sm transition-colors hover:border-[#087f5b] hover:text-[#087f5b] lg:inline-flex"
          title={wideMap ? "Afficher plus de liste" : "Afficher plus de carte"}
        >
          <LayoutPanelTop className="mb-0.5 h-4 w-4" />
          Layout
        </button>
      </div>

      {filtersOpen ? (
        <div className="mt-2 rounded-lg border border-[#d8dee4] bg-white p-3 shadow-xl">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-8">
            <FilterField label="Département">
              <Input
                aria-label="Département"
                placeholder="33"
                value={local.department}
                onChange={(event) => setLocal({ ...local, department: event.target.value })}
                className="h-10 bg-white"
              />
            </FilterField>
            <FilterField label="Ville">
              <Input
                aria-label="Ville"
                placeholder="Bordeaux"
                value={local.city}
                onChange={(event) => setLocal({ ...local, city: event.target.value })}
                className="h-10 bg-white"
              />
            </FilterField>
            <FilterField label="Type">
              <select
                aria-label="Type de bien"
                className="form-input h-10 w-full bg-white text-sm"
                value={local.type || "all"}
                onChange={(event) =>
                  setLocal({
                    ...local,
                    type: event.target.value === "all" ? "" : event.target.value,
                  })
                }
              >
                <option value="all">Tous les types</option>
                <option value="apartment">Appartement</option>
                <option value="house">Maison</option>
                <option value="land">Terrain</option>
                <option value="commercial">Commercial</option>
                <option value="garage">Garage</option>
              </select>
            </FilterField>
            <FilterField label="Occupation">
              <select
                aria-label="Occupation"
                className="form-input h-10 w-full bg-white text-sm"
                value={local.occupancy || "all"}
                onChange={(event) =>
                  setLocal({
                    ...local,
                    occupancy: event.target.value === "all" ? "" : event.target.value,
                  })
                }
              >
                <option value="all">Toutes</option>
                <option value="free">Libre</option>
                <option value="occupied">Occupé</option>
                <option value="rented">Loué</option>
              </select>
            </FilterField>
            <FilterField label="Score min">
              <Input
                aria-label="Score minimum"
                type="number"
                min="0"
                max="100"
                placeholder="70"
                value={local.min_score}
                onChange={(event) => setLocal({ ...local, min_score: event.target.value })}
                className="h-10 bg-white"
              />
            </FilterField>
            <FilterField label="Prix/m² max">
              <Input
                aria-label="Prix au mètre carré maximum"
                type="number"
                placeholder="3500"
                value={local.max_price_per_m2}
                onChange={(event) => setLocal({ ...local, max_price_per_m2: event.target.value })}
                className="h-10 bg-white"
              />
            </FilterField>
            <FilterField label="Rendement min">
              <Input
                aria-label="Rendement minimum"
                type="number"
                placeholder="5"
                value={local.min_yield}
                onChange={(event) => setLocal({ ...local, min_yield: event.target.value })}
                className="h-10 bg-white"
              />
            </FilterField>
            <FilterField label="Autour de">
              <Input
                aria-label="Adresse de recherche"
                placeholder="Adresse, ville"
                value={local.around_address}
                onChange={(event) =>
                  setLocal({
                    ...local,
                    around_address: event.target.value,
                    around_radius:
                      event.target.value && !local.around_radius ? "15" : local.around_radius,
                  })
                }
                className="h-10 bg-white"
              />
            </FilterField>
            <FilterField label="Rayon">
              <Input
                aria-label="Rayon autour de l'adresse"
                type="number"
                placeholder="15"
                value={local.around_radius}
                onChange={(event) => setLocal({ ...local, around_radius: event.target.value })}
                className="h-10 bg-white"
              />
            </FilterField>
          </div>

          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-xs font-medium text-[#687684]">
              {countLoading
                ? "Chargement des dossiers"
                : hasLocalFilters
                  ? `${count.toLocaleString("fr-FR")} affichés avec filtres d'analyse · ${loadedCount.toLocaleString(
                      "fr-FR",
                    )} cartes chargées`
                  : `${count.toLocaleString("fr-FR")} disponibles · ${loadedCount.toLocaleString(
                      "fr-FR",
                    )} cartes chargées`}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={resetFilters}
                className="inline-flex h-9 cursor-pointer items-center justify-center rounded-md border border-[#cbd5df] bg-white px-3 text-sm font-semibold text-[#1f2933] transition-colors hover:border-[#e33446] hover:text-[#e33446]"
              >
                Réinitialiser
              </button>
              <button
                type="button"
                onClick={() => setFiltersOpen(false)}
                className="inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-md bg-[#1f2933] px-3 text-sm font-semibold text-white transition-colors hover:bg-[#111827]"
              >
                <X className="h-4 w-4" />
                Fermer
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </header>
  );
}

function ToolbarSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
}) {
  return (
    <label className="relative inline-flex h-10 shrink-0 cursor-pointer items-center rounded-md border border-[#cbd5df] bg-white text-sm font-bold text-[#1f2933] shadow-sm transition-colors hover:border-[#087f5b]">
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-full cursor-pointer appearance-none bg-transparent py-0 pl-3 pr-9 text-sm font-bold outline-none"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 h-4 w-4 text-[#55626f]" />
    </label>
  );
}

function SortControl({ sort, search }: { sort: SortKey; search: SalesSearchParams }) {
  const navigate = useNavigate({ from: "/sales" });

  return (
    <label className="flex shrink-0 items-center gap-1.5 text-sm font-semibold text-[#3d4b57]">
      <span>Trier :</span>
      <select
        value={sort}
        onChange={(event) => {
          const nextSort = event.target.value as SortKey;
          navigate({
            search: { ...search, sort: nextSort === "score_desc" ? undefined : nextSort },
            replace: true,
          });
        }}
        className="cursor-pointer rounded-md border border-transparent bg-transparent px-1 py-1 text-sm font-bold text-[#087f5b] outline-none hover:border-[#cbd5df]"
      >
        <option value="score_desc">Pertinence</option>
        <option value="price_desc">Prix élevé à bas</option>
        <option value="price_asc">Prix bas à élevé</option>
        <option value="date_asc">Date proche</option>
        <option value="date_desc">Date lointaine</option>
        <option value="surface_desc">Surface</option>
      </select>
    </label>
  );
}

function SalesGoogleMap({
  sales,
  hoveredSaleId,
  selectedSaleId,
  isLoading,
  onHover,
  onSelect,
}: {
  sales: AuctionSale[];
  hoveredSaleId: string | null;
  selectedSaleId: string | null;
  isLoading: boolean;
  onHover: (saleId: string | null) => void;
  onSelect: (saleId: string) => void;
}) {
  const apiKey = getGoogleMapsApiKey();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const googleRef = useRef<typeof google | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);
  const markersRef = useRef<
    globalThis.Map<
      string,
      {
        marker: google.maps.Marker;
        sale: AuctionSale;
        listeners: google.maps.MapsEventListener[];
      }
    >
  >(new globalThis.Map());
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [manualZoom, setManualZoom] = useState(6);
  const [mapTypeId, setMapTypeId] = useState<"roadmap" | "terrain">("roadmap");
  const visibleMarkerItems = useMemo(
    () => buildVisibleMapMarkerItems(sales, manualZoom),
    [manualZoom, sales],
  );

  useEffect(() => {
    if (!apiKey) {
      setMapError("Ajoutez VITE_GOOGLE_MAPS_API_KEY pour afficher Google Maps.");
      return;
    }
    if (!containerRef.current || mapRef.current) return;

    let cancelled = false;
    loadGoogleMaps(apiKey)
      .then((g) => {
        if (cancelled || !containerRef.current) return;
        googleRef.current = g;
        mapRef.current = new g.maps.Map(containerRef.current, {
          backgroundColor: "#dceee5",
          center: DEFAULT_MAP_CENTER,
          clickableIcons: false,
          disableDefaultUI: true,
          gestureHandling: "greedy",
          mapTypeControl: false,
          mapTypeId,
          rotateControl: false,
          scaleControl: false,
          streetViewControl: false,
          styles: GOOGLE_MAP_STYLES,
          zoom: 6,
          zoomControl: false,
        });
        infoWindowRef.current = new g.maps.InfoWindow({ maxWidth: 260 });
        setMapReady(true);
        setMapError(null);
      })
      .catch((error) => {
        if (!cancelled) {
          setMapError(error instanceof Error ? error.message : "Google Maps indisponible.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [apiKey, mapTypeId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const listener = map.addListener("idle", () => {
      const zoom = map.getZoom();
      if (typeof zoom === "number") setManualZoom(zoom);
    });

    return () => listener.remove();
  }, [mapReady]);

  useEffect(() => {
    const g = googleRef.current;
    const map = mapRef.current;
    if (!g || !map || !mapReady) return;

    markersRef.current.forEach(({ marker, listeners }) => {
      listeners.forEach((listener) => listener.remove());
      marker.setMap(null);
    });
    markersRef.current.clear();

    visibleMarkerItems.forEach(({ sale, hiddenCount }, index) => {
      if (sale.latitude == null || sale.longitude == null) return;

      const position = { lat: sale.latitude, lng: sale.longitude };
      const title = sale.title ?? propertyTypeLabel(sale.property_type);
      const marker = new g.maps.Marker({
        icon: createPriceMarkerIcon(g, compactPrice(sale.starting_price_eur), false, hiddenCount),
        map,
        optimized: false,
        position,
        title:
          hiddenCount > 0
            ? `${title} · ${hiddenCount} autre${hiddenCount > 1 ? "s" : ""} à proximité`
            : title,
        zIndex: index,
      });
      const listeners = [
        marker.addListener("mouseover", () => onHover(sale.id)),
        marker.addListener("mouseout", () => onHover(null)),
        marker.addListener("click", () => {
          onSelect(sale.id);
          openSaleInfoWindow(g, map, marker, sale, infoWindowRef.current);
        }),
      ];

      markersRef.current.set(sale.id, { marker, sale, listeners });
    });
  }, [mapReady, onHover, onSelect, visibleMarkerItems]);

  useEffect(() => {
    const g = googleRef.current;
    const map = mapRef.current;
    if (!g || !map || !mapReady) return;

    const fittedZoom = fitGoogleMapToSales(g, map, sales);
    if (fittedZoom != null) setManualZoom(fittedZoom);
  }, [mapReady, sales]);

  useEffect(() => {
    const g = googleRef.current;
    if (!g) return;

    const activeId = hoveredSaleId ?? selectedSaleId;
    let markerOrder = 0;
    markersRef.current.forEach(({ marker, sale }) => {
      const active = sale.id === activeId;
      const item = visibleMarkerItems.find(({ sale: itemSale }) => itemSale.id === sale.id);
      marker.setIcon(
        createPriceMarkerIcon(
          g,
          compactPrice(sale.starting_price_eur),
          active,
          item?.hiddenCount ?? 0,
        ),
      );
      marker.setZIndex(active ? 10_000 : markerOrder);
      markerOrder += 1;
    });
  }, [hoveredSaleId, selectedSaleId, visibleMarkerItems]);

  function changeZoom(delta: number) {
    setManualZoom((current) => {
      const next = Math.max(4, Math.min(18, current + delta));
      mapRef.current?.setZoom(next);
      return next;
    });
  }

  function centerOnFrance() {
    mapRef.current?.setCenter(DEFAULT_MAP_CENTER);
    mapRef.current?.setZoom(6);
    setManualZoom(6);
  }

  function fitVisibleSales() {
    const g = googleRef.current;
    const map = mapRef.current;
    if (!g || !map) return;
    const fittedZoom = fitGoogleMapToSales(g, map, sales);
    if (fittedZoom != null) setManualZoom(fittedZoom);
  }

  function toggleMapType() {
    const next = mapTypeId === "roadmap" ? "terrain" : "roadmap";
    setMapTypeId(next);
    mapRef.current?.setMapTypeId(next);
  }

  return (
    <div className="sticky top-0 h-screen overflow-hidden bg-[#dceee5]">
      <div ref={containerRef} className="absolute inset-0" aria-label="Carte Google Maps" />

      {mapError ? (
        <div className="absolute inset-0 flex items-center justify-center bg-[#e8f3ec] px-8 text-center">
          <div className="max-w-sm rounded-lg border border-[#cddbd2] bg-white p-5 shadow-lg">
            <MapPin className="mx-auto h-8 w-8 text-[#087f5b]" />
            <h2 className="mt-3 text-base font-bold text-[#1f2933]">Google Maps requis</h2>
            <p className="mt-2 text-sm leading-relaxed text-[#55626f]">{mapError}</p>
          </div>
        </div>
      ) : null}

      {!mapError && !mapReady ? (
        <div className="absolute inset-0 flex items-center justify-center bg-[#e8f3ec]">
          <div className="inline-flex items-center gap-2 rounded-md border border-[#cddbd2] bg-white px-4 py-3 text-sm font-bold text-[#1f2933] shadow-lg">
            <LoaderCircle className="h-4 w-4 animate-spin text-[#087f5b]" />
            Chargement Google Maps
          </div>
        </div>
      ) : null}

      {!mapError && mapReady && sales.length === 0 && !isLoading ? (
        <div className="absolute left-4 top-4 max-w-xs rounded-lg border border-[#cddbd2] bg-white/95 p-3 text-sm font-semibold text-[#3d4b57] shadow-lg backdrop-blur">
          Aucune coordonnée disponible pour les dossiers affichés.
        </div>
      ) : null}

      <div className="absolute right-4 top-4 flex flex-col overflow-hidden rounded-md border border-[#d8dee4] bg-white shadow-lg">
        <button
          type="button"
          onClick={() => changeZoom(1)}
          className="grid h-12 w-12 cursor-pointer place-items-center border-b border-[#d8dee4] text-[#1f2933] transition-colors hover:bg-[#f4f7f9]"
          aria-label="Zoomer"
        >
          <Plus className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={() => changeZoom(-1)}
          className="grid h-12 w-12 cursor-pointer place-items-center text-[#1f2933] transition-colors hover:bg-[#f4f7f9]"
          aria-label="Dézoomer"
        >
          <Minus className="h-5 w-5" />
        </button>
      </div>

      <div className="absolute right-4 top-36 flex flex-col gap-3">
        <MapControlButton icon={Navigation} label="Cadrer" onClick={fitVisibleSales} />
        <MapControlButton
          icon={Layers}
          label={mapTypeId === "roadmap" ? "Terrain" : "Plan"}
          onClick={toggleMapType}
        />
        <button
          type="button"
          onClick={centerOnFrance}
          className="inline-flex h-[54px] w-12 cursor-pointer flex-col items-center justify-center rounded-md border border-[#d8dee4] bg-white text-[10px] font-semibold text-[#1f2933] shadow-lg transition-colors hover:bg-[#f4f7f9]"
        >
          <Map className="mb-0.5 h-5 w-5" />
          Carte
        </button>
      </div>

      <div className="absolute bottom-4 left-4 rounded-md border border-[#d8dee4] bg-white/95 px-3 py-2 text-xs font-semibold text-[#3d4b57] shadow-lg backdrop-blur">
        {visibleMarkerItems.length.toLocaleString("fr-FR")} pins visibles ·{" "}
        {sales.length.toLocaleString("fr-FR")} dossiers carte
      </div>
    </div>
  );
}

function MapControlButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-[54px] w-12 cursor-pointer flex-col items-center justify-center rounded-md border border-[#d8dee4] bg-white text-[10px] font-semibold text-[#1f2933] shadow-lg transition-colors hover:bg-[#f4f7f9]"
      aria-label={label}
      title={label}
    >
      <Icon className="mb-0.5 h-5 w-5" />
      {label}
    </button>
  );
}

function ListingCard({
  sale,
  locked,
  active,
  onHover,
  onSelect,
}: {
  sale: AuctionSale;
  locked: boolean;
  active: boolean;
  onHover: (saleId: string | null) => void;
  onSelect: (saleId: string | null) => void;
}) {
  const displaySurface = getDisplaySurface(sale);
  const surface = getSaleSurface(sale).value;
  const { isViewed } = useViewedSales();
  const viewed = !locked && isViewed(sale.id);
  const fresh = !locked && isNew(sale.created_at);
  const title = locked
    ? "Détail réservé aux membres"
    : (sale.title ?? propertyTypeLabel(sale.property_type));
  const location = locked
    ? "Localisation réservée"
    : [sale.city, sale.department ? `(${sale.department})` : null].filter(Boolean).join(" ");
  const facts = [
    sale.rooms_count != null ? `${sale.rooms_count} pièces` : null,
    sale.bedrooms_count != null ? `${sale.bedrooms_count} ch.` : null,
    displaySurface.value != null ? displaySurface.label : null,
  ].filter(Boolean);
  const amenityText = buildAmenityText(sale);
  const riskCount = locked ? 0 : (sale.risks?.length ?? 0);
  const ppm = locked ? null : pricePerM2(sale.starting_price_eur, surface);

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
      className={`group block h-full rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#087f5b] ${
        viewed ? "opacity-75" : ""
      }`}
    >
      <article
        className={`flex h-full flex-col overflow-hidden rounded-lg border bg-white shadow-sm transition-colors duration-200 ${
          active
            ? "border-[#1f2933] ring-2 ring-[#1f2933]"
            : "border-[#d8dee4] hover:border-[#1f2933]"
        }`}
      >
        <div className="relative aspect-[1.34] overflow-hidden bg-[#eef2f4]">
          <ListingImage sale={sale} locked={locked} title={title} />
          <div className="absolute left-2 top-2 flex flex-wrap gap-1.5">
            {locked ? (
              <ListingBadge tone="dark" icon={LockKeyhole}>
                Aperçu limité
              </ListingBadge>
            ) : fresh ? (
              <ListingBadge tone="pink">Nouveau</ListingBadge>
            ) : (
              <ListingBadge tone="dark">Vente judiciaire</ListingBadge>
            )}
          </div>
          {viewed ? (
            <span className="absolute right-2 top-2 rounded-md bg-white/95 px-2 py-1 text-[11px] font-bold text-[#55626f] shadow-sm">
              Vu
            </span>
          ) : null}
          <span
            aria-hidden
            className="absolute left-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full bg-black/34 text-lg font-bold text-white opacity-0 transition-opacity group-hover:opacity-100"
          >
            ‹
          </span>
          <span
            aria-hidden
            className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full bg-black/34 text-lg font-bold text-white opacity-0 transition-opacity group-hover:opacity-100"
          >
            ›
          </span>
        </div>

        <div className="flex flex-1 flex-col p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[22px] font-extrabold leading-tight tracking-normal text-[#17212b]">
                {formatPrice(sale.starting_price_eur)}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm font-bold text-[#1f2933]">
                {facts.length > 0 ? (
                  facts.map((fact) => <span key={fact}>{fact}</span>)
                ) : (
                  <span>Caractéristiques réservées</span>
                )}
              </div>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <ShareButton sale={sale} />
              <CompactFavoriteButton saleId={sale.id} />
            </div>
          </div>

          <div className="mt-2 min-w-0 text-sm font-semibold leading-snug text-[#1f2933]">
            <span className="line-clamp-1">{location || "Adresse à confirmer"}</span>
            <span className="mt-0.5 block line-clamp-1 text-[#55626f]">{title}</span>
          </div>

          <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-xs font-medium text-[#687684]">
            {locked ? (
              <span>Analyse et pièces disponibles après connexion</span>
            ) : (
              <>
                <span>{occupancyLabel(sale.occupancy_status)}</span>
                {ppm != null ? <span>{Math.round(ppm).toLocaleString("fr-FR")} €/m²</span> : null}
                {sale.sale_date ? <span>{formatDate(sale.sale_date)}</span> : null}
              </>
            )}
          </div>

          <div className="mt-2 line-clamp-1 text-xs font-medium text-[#7b8794]">
            {amenityText ||
              (locked ? "Données détaillées réservées" : "Dossier judiciaire à vérifier")}
          </div>

          <div className="mt-auto flex items-end justify-between gap-3 pt-3">
            <span className="line-clamp-1 text-[11px] font-semibold text-[#8b949e]">
              {locked
                ? "Immojudis"
                : `Source ${sale.source_name || sale.primary_source || "publique"}${
                    sale.tribunal_city ? ` · ${sale.tribunal_city}` : ""
                  }`}
            </span>
            <span
              className={`inline-flex shrink-0 items-center rounded-md px-2 py-1 text-[11px] font-extrabold ${
                locked
                  ? "bg-[#f4f1ea] text-[#9c642b]"
                  : riskCount > 0
                    ? "bg-[#fff6df] text-[#8a5b00]"
                    : "bg-[#e8f7ef] text-[#087f5b]"
              }`}
            >
              {locked
                ? "Réservé"
                : riskCount > 0
                  ? `${riskCount} point${riskCount > 1 ? "s" : ""}`
                  : "Vérifié"}
            </span>
          </div>
        </div>
      </article>
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
      ? googleStaticMapUrl({
          lat: sale.latitude,
          lng: sale.longitude,
          zoom: 15,
          width: 760,
          height: 560,
          maptype: "roadmap",
        })
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
  tone: "dark" | "pink";
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-extrabold uppercase tracking-normal text-white shadow-sm ${
        tone === "pink" ? "bg-[#a33b9b]" : "bg-[#1f2933]"
      }`}
    >
      {Icon ? <Icon className="h-3 w-3" /> : null}
      {children}
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
        await navigator.share({ title: sale.title ?? "Vente Immojudis", url });
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
      className="grid h-8 w-8 cursor-pointer place-items-center rounded-full text-[#1f2933] transition-colors hover:bg-[#eef2f4]"
      aria-label="Partager cette vente"
    >
      <Share2 className="h-5 w-5" />
    </button>
  );
}

function CompactFavoriteButton({ saleId }: { saleId: string }) {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isFavorite, setIsFavorite] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) {
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
  }, [saleId, user]);

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

    setBusy(true);
    try {
      if (isFavorite) {
        await removeFavorite(user.id, saleId);
        setIsFavorite(false);
      } else {
        await addFavorite(user.id, saleId);
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
      aria-pressed={isFavorite}
      aria-label={isFavorite ? "Ne plus suivre cette vente" : "Suivre cette vente"}
      className="grid h-8 w-8 cursor-pointer place-items-center rounded-full text-[#1f2933] transition-colors hover:bg-[#eef2f4] disabled:cursor-not-allowed disabled:opacity-60"
    >
      <Heart className={`h-5 w-5 ${isFavorite ? "fill-[#e33446] text-[#e33446]" : ""}`} />
    </button>
  );
}

function EmptyResults() {
  return (
    <div className="rounded-lg border border-[#d8dee4] bg-white p-10 text-center">
      <SearchIcon className="mx-auto h-8 w-8 text-[#087f5b]" />
      <h2 className="mt-4 text-xl font-bold text-[#1f2933]">Aucun dossier trouvé</h2>
      <p className="mt-2 text-sm text-[#55626f]">
        Élargissez les critères ou retirez un filtre d'analyse.
      </p>
    </div>
  );
}

function ListingCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-[#d8dee4] bg-white shadow-sm">
      <Skeleton className="aspect-[1.34] w-full rounded-none bg-[#eef2f4]" />
      <div className="space-y-3 p-3">
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

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="space-y-1">
      <span className="block text-[10px] font-bold uppercase tracking-[0.12em] text-[#687684]">
        {label}
      </span>
      {children}
    </label>
  );
}

function searchToToolbarState(search: SalesSearchParams): ToolbarState {
  return {
    department: search.department ?? "",
    city: search.city ?? "",
    type: search.type ?? "",
    max_price: search.max_price != null ? String(search.max_price) : "",
    min_surface: search.min_surface != null ? String(search.min_surface) : "",
    occupancy: search.occupancy ?? "",
    min_score: search.min_score != null ? String(search.min_score) : "",
    max_price_per_m2: search.max_price_per_m2 != null ? String(search.max_price_per_m2) : "",
    min_yield: search.min_yield != null ? String(search.min_yield) : "",
    around_address: search.around_address ?? "",
    around_radius: search.around_radius != null ? String(search.around_radius) : "",
  };
}

function emptyToolbarState(): ToolbarState {
  return {
    department: "",
    city: "",
    type: "",
    max_price: "",
    min_surface: "",
    occupancy: "",
    min_score: "",
    max_price_per_m2: "",
    min_yield: "",
    around_address: "",
    around_radius: "",
  };
}

function toolbarStateToSearch(local: ToolbarState, sort?: SortKey): SalesSearchParams {
  const next: SalesSearchParams = {};
  if (local.department) next.department = local.department;
  if (local.city) next.city = local.city;
  if (local.type) next.type = local.type;
  if (local.max_price) next.max_price = Number(local.max_price);
  if (local.min_surface) next.min_surface = Number(local.min_surface);
  if (local.occupancy) next.occupancy = local.occupancy;
  if (local.min_score) next.min_score = Number(local.min_score);
  if (local.max_price_per_m2) next.max_price_per_m2 = Number(local.max_price_per_m2);
  if (local.min_yield) next.min_yield = Number(local.min_yield);
  if (local.around_address) next.around_address = local.around_address;
  if (local.around_radius) next.around_radius = Number(local.around_radius);
  if (sort) next.sort = sort;
  return next;
}

function countActiveFilters(local: ToolbarState) {
  return Object.values(local).filter(Boolean).length;
}

function buildAlertName(local: ToolbarState) {
  const segments = [
    local.city,
    local.department ? `Dép. ${local.department}` : null,
    local.type ? propertyTypeLabel(local.type) : null,
    local.max_price ? `≤ ${compactPrice(Number(local.max_price))}` : null,
  ].filter(Boolean);

  return segments.length > 0 ? `Recherche ${segments.join(" · ")}` : "Recherche Immojudis";
}

function hasCoordinates(
  sale: AuctionSale,
): sale is AuctionSale & { latitude: number; longitude: number } {
  return sale.latitude != null && sale.longitude != null;
}

function fitGoogleMapToSales(
  g: typeof google,
  map: google.maps.Map,
  sales: AuctionSale[],
): number | null {
  const points = sales.filter(hasCoordinates);

  if (points.length === 0) {
    map.setCenter(DEFAULT_MAP_CENTER);
    map.setZoom(6);
    return 6;
  }

  if (points.length === 1) {
    const [sale] = points;
    map.setCenter({ lat: sale.latitude, lng: sale.longitude });
    map.setZoom(12);
    return 12;
  }

  const bounds = new g.maps.LatLngBounds();
  points.forEach((sale) => bounds.extend({ lat: sale.latitude, lng: sale.longitude }));
  map.fitBounds(bounds);
  return null;
}

function compactPrice(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "Prix";
  if (Math.abs(value) >= 1_000_000) {
    return `${new Intl.NumberFormat("fr-FR", {
      maximumFractionDigits: Math.abs(value) >= 10_000_000 ? 0 : 1,
    }).format(value / 1_000_000)} M€`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${Math.round(value / 1_000).toLocaleString("fr-FR")} k€`;
  }
  return `${value.toLocaleString("fr-FR")} €`;
}

type VisibleMapMarkerItem = {
  sale: AuctionSale;
  hiddenCount: number;
};

type MarkerCollisionBox = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

function buildVisibleMapMarkerItems(sales: AuctionSale[], zoom: number): VisibleMapMarkerItem[] {
  const candidates = sales.filter(hasCoordinates);
  if (zoom >= 10) return candidates.map((sale) => ({ sale, hiddenCount: 0 }));

  const accepted: Array<VisibleMapMarkerItem & { box: MarkerCollisionBox }> = [];

  candidates.forEach((sale) => {
    const label = compactPrice(sale.starting_price_eur);
    const projected = projectLatLngToWorldPixel(sale.latitude, sale.longitude, zoom);
    const width = priceMarkerWidth(label) + 38;
    const box = {
      left: projected.x - width / 2 - 8,
      right: projected.x + width / 2 + 8,
      top: projected.y - PRICE_MARKER_HEIGHT - 10,
      bottom: projected.y + 8,
    };
    const collided = accepted.find((item) => markerBoxesOverlap(box, item.box));

    if (collided) {
      collided.hiddenCount += 1;
      return;
    }

    accepted.push({ sale, hiddenCount: 0, box });
  });

  return accepted.map(({ sale, hiddenCount }) => ({ sale, hiddenCount }));
}

function projectLatLngToWorldPixel(lat: number, lng: number, zoom: number) {
  const sinLat = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  const scale = 256 * 2 ** zoom;

  return {
    x: ((lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale,
  };
}

function markerBoxesOverlap(a: MarkerCollisionBox, b: MarkerCollisionBox) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
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

function buildAmenityText(sale: AuctionSale) {
  return [
    sale.has_garden ? "Jardin" : null,
    sale.has_terrace ? "Terrasse" : null,
    sale.has_garage ? "Garage" : null,
    sale.has_pool ? "Piscine" : null,
    sale.has_air_conditioning ? "Climatisation" : null,
    sale.has_double_glazing ? "Double vitrage" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

const PRICE_MARKER_HEIGHT = 36;

function createPriceMarkerIcon(
  g: typeof google,
  label: string,
  active: boolean,
  hiddenCount = 0,
): google.maps.Icon {
  const baseWidth = priceMarkerWidth(label);
  const countLabel = hiddenCount > 0 ? `+${Math.min(hiddenCount, 99)}` : "";
  const countWidth = countLabel ? Math.max(28, countLabel.length * 8 + 16) : 0;
  const width = baseWidth + countWidth;
  const height = PRICE_MARKER_HEIGHT;
  const fill = active ? "#e33446" : "#087f5b";
  const stroke = active ? "#ffffff" : "#ffffff";
  const countBubble = countLabel
    ? `<rect x="${baseWidth - 5}" y="4" width="${countWidth}" height="20" rx="10" fill="#0b5f47" stroke="#ffffff" stroke-width="2"/>
       <text x="${baseWidth - 5 + countWidth / 2}" y="14.5" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif" font-size="10.5" font-weight="800" fill="#fff">${escapeSvgText(countLabel)}</text>`
    : "";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <path d="M11 2h${baseWidth - 22}a9 9 0 0 1 9 9v8a9 9 0 0 1-9 9H${baseWidth / 2 + 7}L${baseWidth / 2}34l-7-6H11a9 9 0 0 1-9-9v-8a9 9 0 0 1 9-9Z" fill="${fill}" stroke="${stroke}" stroke-width="2.5"/>
      <text x="${baseWidth / 2}" y="17" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif" font-size="12" font-weight="800" fill="#fff">${escapeSvgText(label)}</text>
      ${countBubble}
    </svg>
  `;

  return {
    anchor: new g.maps.Point(baseWidth / 2, height - 1),
    scaledSize: new g.maps.Size(width, height),
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
  };
}

function priceMarkerWidth(label: string) {
  const textWidth = Array.from(label).reduce((width, char) => {
    if (char === " ") return width + 5;
    if (/[€MmkK]/.test(char)) return width + 11;
    if (/[0-9,.]/.test(char)) return width + 8.5;
    return width + 9;
  }, 0);

  return Math.max(88, Math.min(170, Math.ceil(textWidth + 46)));
}

function openSaleInfoWindow(
  g: typeof google,
  map: google.maps.Map,
  marker: google.maps.Marker,
  sale: AuctionSale,
  infoWindow: google.maps.InfoWindow | null,
) {
  if (!infoWindow) return;

  const wrapper = document.createElement("div");
  wrapper.style.display = "grid";
  wrapper.style.gap = "6px";
  wrapper.style.minWidth = "190px";

  const price = document.createElement("strong");
  price.textContent = formatPrice(sale.starting_price_eur);
  price.style.fontSize = "16px";
  price.style.color = "#17212b";

  const title = document.createElement("a");
  title.href = `/sales/${encodeURIComponent(sale.id)}`;
  title.textContent = sale.title ?? propertyTypeLabel(sale.property_type);
  title.style.color = "#087f5b";
  title.style.fontWeight = "700";
  title.style.textDecoration = "none";

  const meta = document.createElement("span");
  meta.textContent = [
    sale.city,
    sale.department,
    sale.sale_date ? formatDate(sale.sale_date) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  meta.style.color = "#55626f";
  meta.style.fontSize = "12px";

  wrapper.append(price, title, meta);
  infoWindow.setContent(wrapper);
  infoWindow.open({ anchor: marker, map, shouldFocus: false });
  if (sale.latitude != null && sale.longitude != null) {
    map.panTo({ lat: sale.latitude, lng: sale.longitude });
  }
}

function escapeSvgText(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const GOOGLE_MAP_STYLES: Array<Record<string, unknown>> = [
  {
    featureType: "poi",
    stylers: [{ visibility: "off" }],
  },
  {
    featureType: "transit",
    stylers: [{ visibility: "off" }],
  },
  {
    featureType: "road",
    elementType: "geometry",
    stylers: [{ color: "#d4deea" }],
  },
  {
    featureType: "road.highway",
    elementType: "geometry",
    stylers: [{ color: "#b8c7dc" }],
  },
  {
    featureType: "water",
    elementType: "geometry",
    stylers: [{ color: "#8bd8e8" }],
  },
  {
    featureType: "landscape.natural",
    elementType: "geometry",
    stylers: [{ color: "#ccebd8" }],
  },
  {
    featureType: "landscape.man_made",
    elementType: "geometry",
    stylers: [{ color: "#f6f7f3" }],
  },
];
