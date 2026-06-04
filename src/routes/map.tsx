const MAP_LIMIT = 300;

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { getMapPins } from "@/lib/queries";
import type { SaleFilters, SortKey } from "@/lib/types";
import { SaleMap } from "@/components/SaleMap";
import { SaleFilters as SaleFiltersForm } from "@/components/SaleFilters";
import {
  estimateGrossYieldPct,
  geocodeAddress,
  haversineKm,
  pricePerM2,
  type GeoPoint,
} from "@/lib/geo";

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

export const Route = createFileRoute("/map")({
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
      { title: "Carte des ventes — Immojudis" },
      {
        name: "description",
        content:
          "Visualisez toutes les ventes aux enchères immobilières sur une carte interactive.",
      },
    ],
  }),
  component: MapPage,
});

function MapPage() {
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

  const { data: sales = [], isLoading } = useQuery({
    queryKey: ["sales-map", filters, sort],
    // On plafonne pour ne pas saturer le client mobile ; un message le signale.
    queryFn: () => getMapPins(filters, MAP_LIMIT, sort),
    staleTime: 60_000,
  });

  // Géocodage "autour de l'adresse"
  const [center, setCenter] = useState<GeoPoint | null>(null);
  useEffect(() => {
    if (!search.around_address) {
      setCenter(null);
      return;
    }
    let cancelled = false;
    geocodeAddress(search.around_address).then((p) => {
      if (!cancelled) setCenter(p);
    });
    return () => {
      cancelled = true;
    };
  }, [search.around_address]);

  const filtered = useMemo(() => {
    return sales.filter((s) => {
      if (s.latitude == null || s.longitude == null) return false;
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
        const d = haversineKm(center, { lat: s.latitude, lng: s.longitude });
        if (d > search.around_radius) return false;
      }
      return true;
    });
  }, [sales, search.max_price_per_m2, search.min_yield, search.around_radius, center]);

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold text-foreground">Carte des ventes</h1>
        <p className="text-sm text-muted-foreground">
          {isLoading
            ? "Chargement…"
            : `${filtered.length} annonce${filtered.length > 1 ? "s" : ""} géolocalisée${filtered.length > 1 ? "s" : ""}`}
          {center && search.around_radius != null && (
            <>
              {" "}
              · autour de <span className="font-medium text-foreground">{center.label}</span> (
              {search.around_radius} km)
            </>
          )}
          {sales.length >= MAP_LIMIT && (
            <>
              {" "}
              ·{" "}
              <span className="text-amber-600 dark:text-amber-400">
                affichage limité aux {MAP_LIMIT} premiers résultats, affinez les filtres
              </span>
            </>
          )}
        </p>
      </div>

      <div className="mb-4">
        <SaleFiltersForm from="/map" />
      </div>

      <SaleMap
        sales={filtered}
        fitToMarkers={Boolean(
          search.department ||
          search.city ||
          search.type ||
          search.max_price ||
          search.min_surface ||
          search.occupancy ||
          search.min_score ||
          search.max_price_per_m2 ||
          search.min_yield ||
          (center && search.around_radius != null),
        )}
      />

      <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Dot color="#10b981" />
          Score ≥ 80
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Dot color="#3b82f6" />
          60–79
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Dot color="#f59e0b" />
          40–59
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Dot color="#ef4444" />
          &lt; 40
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Dot color="#9ca3af" />
          Non noté
        </span>
      </div>
    </main>
  );
}

function Dot({ color }: { color: string }) {
  return <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />;
}
