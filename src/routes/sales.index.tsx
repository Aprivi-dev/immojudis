import { createFileRoute } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import type * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import FileSearch from "lucide-react/dist/esm/icons/file-search.js";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal.js";
import { getSales } from "@/lib/queries";
import { useAuth } from "@/hooks/use-auth";
import {
  asFiniteNumber,
  asSearchString,
  asSortKey,
  type SaleFilters,
  type SortKey,
} from "@/lib/types";
import { SaleCard } from "@/components/SaleCard";
import { SaleFilters as SaleFiltersForm } from "@/components/SaleFilters";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  estimateGrossYieldPct,
  geocodeAddress,
  haversineKm,
  pricePerM2,
  type GeoPoint,
} from "@/lib/geo";
import { getSaleSurface } from "@/lib/surface";

const PAGE_SIZE = 16;

type Search = {
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

export const Route = createFileRoute("/sales/")({
  validateSearch: (search: Record<string, unknown>): Search => ({
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
  const sales = useMemo(() => data?.pages.flat() ?? [], [data]);
  const isInitialLoading = authLoading || isLoading;

  // Geocode "around address" when provided
  const [center, setCenter] = useState<GeoPoint | null>(null);
  const [geocoding, setGeocoding] = useState(false);
  useEffect(() => {
    if (!search.around_address) {
      setCenter(null);
      return;
    }
    let cancelled = false;
    setGeocoding(true);
    geocodeAddress(search.around_address).then((p) => {
      if (cancelled) return;
      setCenter(p);
      setGeocoding(false);
    });
    return () => {
      cancelled = true;
    };
  }, [search.around_address]);

  const filtered = useMemo(() => {
    if (isPreview) return sales;
    return sales.filter((s) => {
      const surface = getSaleSurface(s).value;
      if (search.max_price_per_m2 != null) {
        const ppm = pricePerM2(s.starting_price_eur, surface);
        if (ppm == null || ppm > search.max_price_per_m2) return false;
      }
      if (search.min_yield != null) {
        const y = estimateGrossYieldPct(s.starting_price_eur, surface, s.department);
        if (y == null || y < search.min_yield) return false;
      }
      if (center && search.around_radius != null) {
        if (s.latitude == null || s.longitude == null) return false;
        const d = haversineKm(center, { lat: s.latitude, lng: s.longitude });
        if (d > search.around_radius) return false;
      }
      return true;
    });
  }, [center, isPreview, sales, search.max_price_per_m2, search.min_yield, search.around_radius]);

  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node || !hasNextPage || isInitialLoading || isFetchingNextPage) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          void fetchNextPage();
        }
      },
      { rootMargin: "720px 0px" },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, isInitialLoading, filtered.length]);

  const loadedCount = sales.length;
  const filteredCount = filtered.length;
  const hasLocalFilters =
    !isPreview && Boolean(search.max_price_per_m2 || search.min_yield || center);

  return (
    <main className="min-h-screen bg-[#f7f7f7] px-4 py-5 text-foreground sm:px-6 lg:px-8 lg:py-6">
      <div className="mx-auto max-w-[1520px]">
        <header className="mb-4 border-b border-border pb-5">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-gold-soft">
                <FileSearch className="h-4 w-4" />
                Dossiers analysés
              </div>
              <h1 className="mt-3 font-sans text-3xl font-semibold leading-tight text-foreground sm:text-4xl">
                Annonces analysées
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground sm:text-base">
                Parcourez les ventes judiciaires avec les critères qui aident à fixer une mise
                plafond : prix, surface, occupation, localisation et points à vérifier. Les
                résultats continuent de se charger au scroll.
              </p>
            </div>

            <div className="grid w-full gap-2 sm:grid-cols-3 lg:max-w-xl">
              <HeroMetric
                label="Résultats affichés"
                value={isInitialLoading ? "—" : filteredCount.toLocaleString("fr-FR")}
              />
              <HeroMetric
                label="Dossiers chargés"
                value={isInitialLoading ? "—" : loadedCount.toLocaleString("fr-FR")}
              />
              <HeroMetric
                label="Chargement"
                value={hasNextPage ? "Scroll" : isInitialLoading ? "..." : "Complet"}
              />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2 text-xs text-muted-foreground">
            {geocoding ? (
              <StatusPill icon={LoaderCircle} label="Géocodage en cours" spinning />
            ) : null}
            {center && search.around_radius != null ? (
              <StatusPill
                icon={MapPin}
                label={`${center.label} · rayon ${search.around_radius} km`}
              />
            ) : null}
            {hasLocalFilters ? (
              <StatusPill icon={SlidersHorizontal} label="Filtres locaux appliqués" />
            ) : null}
          </div>
        </header>

        <section className="sticky top-16 z-30 -mx-4 mb-6 border-y border-border bg-[#f7f7f7]/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          <SaleFiltersForm />
        </section>

        {error && (
          <div className="mb-4 rounded-lg border border-destructive/25 bg-white p-4 text-sm text-destructive shadow-sm">
            {error instanceof Error ? error.message : "Erreur de chargement"}
          </div>
        )}

        {!isInitialLoading && filtered.length === 0 && !error && (
          <div className="rounded-lg border border-border bg-white p-12 text-center shadow-sm">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-gold/25 bg-gold/10 text-gold-soft">
              <FileSearch className="h-5 w-5" />
            </div>
            <h2 className="mt-5 font-sans text-2xl font-semibold text-foreground">
              Aucun dossier trouvé
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Élargissez les critères ou retirez un filtre local pour relancer la lecture.
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {isInitialLoading
            ? Array.from({ length: 8 }).map((_, i) => <SaleCardSkeleton key={i} />)
            : filtered.map((s) => <SaleCard key={s.id} sale={s} locked={isPreview} />)}
        </div>

        <div ref={loadMoreRef} className="h-1" aria-hidden />

        {!isInitialLoading && (hasNextPage || isFetchingNextPage) && (
          <div className="mt-8 flex flex-col items-center gap-3">
            {isFetchingNextPage ? (
              <div className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="h-4 w-4 animate-spin text-gold" />
                Chargement des dossiers suivants
              </div>
            ) : null}
            <Button
              variant="outline"
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
              className="border-border bg-white text-foreground hover:border-gold hover:text-gold-soft"
            >
              {isFetchingNextPage ? "Chargement..." : "Charger plus d'annonces"}
            </Button>
          </div>
        )}

        {!isInitialLoading && !hasNextPage && filtered.length > 0 && (
          <div className="mt-8 text-center text-xs uppercase tracking-[0.18em] text-muted-foreground">
            Tous les dossiers chargés
          </div>
        )}
      </div>
    </main>
  );
}

function HeroMetric({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-lg border border-border bg-white p-3 shadow-sm">
      <div className="text-2xl font-semibold tabular-nums text-foreground">{value}</div>
      <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

function StatusPill({
  icon: Icon,
  label,
  spinning = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  spinning?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-border bg-white px-3 py-1.5 shadow-sm">
      <Icon className={`h-3.5 w-3.5 text-gold-soft ${spinning ? "animate-spin" : ""}`} />
      {label}
    </span>
  );
}

function SaleCardSkeleton() {
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-white shadow-sm">
      <Skeleton className="aspect-[4/3] w-full rounded-none bg-muted" />
      <div className="flex flex-1 flex-col gap-3 p-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="grid flex-1 gap-2">
            <Skeleton className="h-5 w-3/4 bg-muted" />
            <Skeleton className="h-3 w-1/2 bg-muted" />
          </div>
          <Skeleton className="h-7 w-16 rounded-full bg-muted" />
        </div>
        <Skeleton className="h-8 w-1/2 bg-muted" />
        <div className="grid grid-cols-2 gap-2">
          <Skeleton className="h-12 rounded-md bg-muted" />
          <Skeleton className="h-12 rounded-md bg-muted" />
        </div>
        <Skeleton className="mt-auto h-4 w-24 bg-muted" />
      </div>
    </div>
  );
}
