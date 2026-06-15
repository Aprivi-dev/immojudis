const MAP_LIMIT = 300;

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import MapIcon from "lucide-react/dist/esm/icons/map.js";
import Radar from "lucide-react/dist/esm/icons/radar.js";
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
import { getSaleSurface } from "@/lib/surface";

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
        const d = haversineKm(center, { lat: s.latitude, lng: s.longitude });
        if (d > search.around_radius) return false;
      }
      return true;
    });
  }, [sales, search.max_price_per_m2, search.min_yield, search.around_radius, center]);

  const fitToMarkers = Boolean(
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
  );

  return (
    <main className="liquid-page min-h-screen px-4 py-8 text-foreground sm:px-6 lg:py-10">
      <div className="mx-auto max-w-7xl">
        <header className="glass-shell mb-6 rounded-lg p-6 sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.28em] text-gold">
                <MapIcon className="h-4 w-4" />
                Vue territoire
              </div>
              <h1 className="mt-4 font-display text-4xl leading-tight text-foreground sm:text-5xl">
                Carte des ventes
              </h1>
              <p className="mt-4 max-w-3xl text-sm leading-relaxed text-muted-foreground sm:text-base">
                Repérez les opportunités par zone, anticipez les dates d'audience et gardez une
                lecture claire du marché local.
              </p>
            </div>
            <div className="grid min-w-[min(100%,26rem)] gap-3 sm:grid-cols-2">
              <MapMetric
                label="Géolocalisées"
                value={
                  isLoading ? "..." : `${filtered.length} annonce${filtered.length > 1 ? "s" : ""}`
                }
              />
              <MapMetric
                label="Lecture"
                value={
                  center && search.around_radius != null
                    ? `${search.around_radius} km`
                    : "France SO"
                }
              />
            </div>
          </div>
          {center && search.around_radius != null ? (
            <div className="signal-chip mt-5 inline-flex rounded-full px-3 py-1.5 text-xs text-gold-soft">
              Autour de {center.label}
            </div>
          ) : null}
          {sales.length >= MAP_LIMIT ? (
            <div className="mt-3 text-xs leading-relaxed text-amber-100">
              Affichage limité aux {MAP_LIMIT} premiers résultats : affinez les filtres pour une
              zone plus précise.
            </div>
          ) : null}
        </header>

        <section className="mb-5">
          <SaleFiltersForm from="/map" />
        </section>

        <section className="glass-shell overflow-hidden rounded-lg p-3">
          <SaleMap sales={filtered} fitToMarkers={fitToMarkers} />
        </section>

        <div className="mt-4 flex flex-wrap gap-3 text-xs text-muted-foreground">
          <LegendItem color="#0f9d6e" label="Vente dans 30 j ou plus" />
          <LegendItem color="#d97706" label="Moins de 30 j" />
          <LegendItem color="#dc2626" label="Moins de 7 j" />
          <LegendItem color="#6b7280" label="Vente passée" />
          <LegendItem color="#9ca3af" label="Date inconnue" />
          <span className="ml-auto inline-flex items-center gap-1.5 text-gold-soft">
            <Radar className="h-3.5 w-3.5" />
            Lecture géographique
          </span>
        </div>
      </div>
    </main>
  );
}

function MapMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="liquid-panel-soft rounded-lg p-4">
      <div className="font-display text-2xl tabular-nums text-gold-soft">{value}</div>
      <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="liquid-panel-soft inline-flex items-center gap-1.5 rounded-full px-3 py-1.5">
      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}
