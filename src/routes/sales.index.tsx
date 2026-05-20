import { createFileRoute } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { getSales } from "@/lib/queries";
import type { SaleFilters, SortKey } from "@/lib/types";
import { SaleCard } from "@/components/SaleCard";
import { SaleFilters as SaleFiltersForm } from "@/components/SaleFilters";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { estimateGrossYieldPct, geocodeAddress, haversineKm, pricePerM2, type GeoPoint } from "@/lib/geo";

const PAGE_SIZE = 50;

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
      { title: "Annonces — Enchères Immo" },
      { name: "description", content: "Consultez toutes les ventes aux enchères immobilières disponibles." },
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
  const sort = (search.sort as SortKey) || "date_asc";
  const {
    data,
    isLoading,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    error,
  } = useInfiniteQuery({
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
      const surface = s.app_surface_m2 ?? s.habitable_surface_m2 ?? s.carrez_surface_m2;
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

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-foreground">Annonces</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {isLoading
            ? "Chargement…"
            : `${filtered.length} résultat${filtered.length > 1 ? "s" : ""}${filtered.length !== sales.length ? ` (sur ${sales.length})` : ""}`}
          {geocoding && " · géocodage…"}
          {center && search.around_radius != null && (
            <> · autour de <span className="font-medium text-foreground">{center.label}</span> ({search.around_radius} km)</>
          )}
        </p>
      </div>

      <div className="mb-6">
        <SaleFiltersForm />
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
          {error instanceof Error ? error.message : "Erreur de chargement"}
        </div>
      )}

      {!isLoading && filtered.length === 0 && !error && (
        <div className="rounded-lg border border-dashed border-border p-12 text-center text-muted-foreground">
          Aucune annonce ne correspond à vos critères.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {isLoading
          ? Array.from({ length: 8 }).map((_, i) => <SaleCardSkeleton key={i} />)
          : filtered.map((s) => <SaleCard key={s.id} sale={s} />)}
      </div>

      {!isLoading && hasNextPage && (
        <div className="mt-6 flex justify-center">
          <Button
            variant="outline"
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? "Chargement…" : "Charger plus d'annonces"}
          </Button>
        </div>
      )}
    </main>
  );
}

function SaleCardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-6 w-10 rounded-full" />
      </div>
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-3 w-2/3" />
      <div className="flex gap-2">
        <Skeleton className="h-5 w-14 rounded-md" />
        <Skeleton className="h-5 w-14 rounded-md" />
      </div>
      <Skeleton className="mt-auto h-9 w-full rounded-md" />
    </div>
  );
}