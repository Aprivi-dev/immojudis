import { createFileRoute } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import type * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import FileSearch from "lucide-react/dist/esm/icons/file-search.js";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal.js";
import { getSales } from "@/lib/queries";
import type { SaleFilters, SortKey } from "@/lib/types";
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
  sort?: string;
  max_price_per_m2?: number;
  min_yield?: number;
  around_address?: string;
  around_radius?: number;
};

export const Route = createFileRoute("/sales/")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    department: search.department as string | undefined,
    city: search.city as string | undefined,
    type: search.type as string | undefined,
    max_price: search.max_price ? Number(search.max_price) : undefined,
    min_surface: search.min_surface ? Number(search.min_surface) : undefined,
    occupancy: search.occupancy as string | undefined,
    min_score: search.min_score ? Number(search.min_score) : undefined,
    sort: search.sort as string | undefined,
    max_price_per_m2: search.max_price_per_m2 ? Number(search.max_price_per_m2) : undefined,
    min_yield: search.min_yield ? Number(search.min_yield) : undefined,
    around_address: search.around_address as string | undefined,
    around_radius: search.around_radius ? Number(search.around_radius) : undefined,
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
  const filters: SaleFilters = {
    department: search.department,
    city: search.city,
    property_type: search.type,
    max_price: search.max_price,
    min_surface: search.min_surface,
    occupancy_status: search.occupancy,
    min_score: search.min_score,
  };
  const sort = (search.sort as SortKey) || "score_desc";
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const { data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage, error } =
    useInfiniteQuery({
      queryKey: ["sales", filters, sort],
      queryFn: ({ pageParam = 0 }) => getSales(filters, PAGE_SIZE, sort, pageParam),
      initialPageParam: 0,
      getNextPageParam: (lastPage, allPages) =>
        lastPage.length < PAGE_SIZE ? undefined : allPages.length * PAGE_SIZE,
      staleTime: 60_000,
    });
  const sales = useMemo(() => data?.pages.flat() ?? [], [data]);

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
  }, [sales, search.max_price_per_m2, search.min_yield, search.around_radius, center]);

  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node || !hasNextPage || isLoading || isFetchingNextPage) return;

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
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, filtered.length]);

  const loadedCount = sales.length;
  const filteredCount = filtered.length;
  const hasLocalFilters = Boolean(search.max_price_per_m2 || search.min_yield || center);

  return (
    <main className="liquid-page min-h-screen px-4 py-8 text-foreground sm:px-6 lg:py-10">
      <div className="mx-auto max-w-7xl">
        <header className="glass-shell glass-sheen mb-6 overflow-hidden rounded-lg p-6 sm:p-8">
          <div className="relative z-10 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.28em] text-gold">
                <FileSearch className="h-4 w-4" />
                Dossiers analysés
              </div>
              <h1 className="mt-4 font-display text-4xl leading-tight text-foreground sm:text-5xl">
                Annonces analysées
              </h1>
              <p className="mt-4 max-w-3xl text-sm leading-relaxed text-muted-foreground sm:text-base">
                Parcourez les ventes judiciaires avec les critères qui aident à fixer une mise
                plafond : prix, surface, occupation, localisation et points à vérifier. Les
                résultats continuent de se charger au scroll.
              </p>
            </div>

            <div className="grid min-w-[min(100%,28rem)] gap-3 sm:grid-cols-3">
              <HeroMetric
                label="Résultats affichés"
                value={isLoading ? "—" : filteredCount.toLocaleString("fr-FR")}
              />
              <HeroMetric
                label="Dossiers chargés"
                value={isLoading ? "—" : loadedCount.toLocaleString("fr-FR")}
              />
              <HeroMetric
                label="Chargement"
                value={hasNextPage ? "Scroll" : isLoading ? "..." : "Complet"}
              />
            </div>
          </div>

          <div className="mt-6 flex flex-wrap gap-2 text-xs text-muted-foreground">
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

        <section className="mb-6">
          <SaleFiltersForm />
        </section>

        {error && (
          <div className="liquid-panel-soft mb-4 rounded-lg border-destructive/25 p-4 text-sm text-destructive">
            {error instanceof Error ? error.message : "Erreur de chargement"}
          </div>
        )}

        {!isLoading && filtered.length === 0 && !error && (
          <div className="liquid-panel rounded-lg p-12 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-gold/25 bg-gold/10 text-gold">
              <FileSearch className="h-5 w-5" />
            </div>
            <h2 className="mt-5 font-display text-2xl text-foreground">Aucun dossier trouvé</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Élargissez les critères ou retirez un filtre local pour relancer la lecture.
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {isLoading
            ? Array.from({ length: 8 }).map((_, i) => <SaleCardSkeleton key={i} />)
            : filtered.map((s) => <SaleCard key={s.id} sale={s} />)}
        </div>

        <div ref={loadMoreRef} className="h-1" aria-hidden />

        {!isLoading && (hasNextPage || isFetchingNextPage) && (
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
              className="liquid-panel-soft border-white/10 text-gold hover:border-gold hover:text-gold-soft"
            >
              {isFetchingNextPage ? "Chargement..." : "Charger plus d'annonces"}
            </Button>
          </div>
        )}

        {!isLoading && !hasNextPage && filtered.length > 0 && (
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
    <div className="liquid-panel-soft rounded-lg p-4">
      <div className="font-display text-2xl tabular-nums text-gold-soft">{value}</div>
      <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
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
    <span className="liquid-panel-soft inline-flex items-center gap-2 rounded-full px-3 py-1.5">
      <Icon className={`h-3.5 w-3.5 text-gold ${spinning ? "animate-spin" : ""}`} />
      {label}
    </span>
  );
}

function SaleCardSkeleton() {
  return (
    <div className="liquid-panel flex min-h-[26rem] flex-col overflow-hidden rounded-lg">
      <Skeleton className="h-40 w-full rounded-none bg-white/10" />
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="grid flex-1 gap-2">
            <Skeleton className="h-5 w-3/4 bg-white/10" />
            <Skeleton className="h-3 w-1/2 bg-white/10" />
          </div>
          <Skeleton className="h-7 w-16 rounded-full bg-white/10" />
        </div>
        <Skeleton className="h-8 w-1/2 bg-white/10" />
        <div className="grid grid-cols-2 gap-2">
          <Skeleton className="h-16 rounded-md bg-white/10" />
          <Skeleton className="h-16 rounded-md bg-white/10" />
        </div>
        <Skeleton className="mt-auto h-10 w-full rounded-md bg-white/10" />
      </div>
    </div>
  );
}
