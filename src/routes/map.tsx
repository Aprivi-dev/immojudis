const MAP_LIMIT = 300;

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import MapIcon from "lucide-react/dist/esm/icons/map.js";
import { getMapPins } from "@/lib/queries";
import {
  asFiniteNumber,
  asSearchString,
  asSortKey,
  type SaleFilters,
  type SortKey,
} from "@/lib/types";
import { SaleMap } from "@/components/SaleMap";
import { MapFilterBar } from "@/components/MapFilterBar";
import { MapResultsRail, MapSaleCard } from "@/components/MapResultsRail";
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
  sort?: SortKey;
  max_price_per_m2?: number;
  min_yield?: number;
  around_address?: string;
  around_radius?: number;
};

export const Route = createFileRoute("/map")({
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
      { title: "Carte des ventes — Immojudis" },
      {
        name: "description",
        content:
          "Visualisez toutes les ventes aux enchères immobilières sur une carte interactive, synchronisée avec la liste des annonces.",
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
  const sort = search.sort || "date_asc";

  const { data: sales = [], isLoading } = useQuery({
    queryKey: ["sales-map", filters, sort],
    // On plafonne pour ne pas saturer le client mobile ; un message le signale.
    queryFn: () => getMapPins(filters, MAP_LIMIT, sort),
    staleTime: 60_000,
  });

  // Géocodage "autour de l'adresse".
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

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [view, setView] = useState<"map" | "list">("map");

  // Désélectionne si l'annonce sort du jeu filtré.
  useEffect(() => {
    if (selectedId && !filtered.some((s) => s.id === selectedId)) setSelectedId(null);
  }, [filtered, selectedId]);

  const selectedSale = selectedId ? (filtered.find((s) => s.id === selectedId) ?? null) : null;

  // Sélectionner depuis la liste révèle la carte sur mobile.
  const handleSelect = (id: string | null) => {
    setSelectedId(id);
    if (id) setView("map");
  };

  const showRadiusNote = Boolean(center && search.around_radius != null);
  const showLimitNote = sales.length >= MAP_LIMIT;

  return (
    <main className="flex h-[calc(100svh-4rem)] flex-col overflow-hidden bg-background text-foreground">
      {/* ── Barre d'outils (titre + filtres + bascule mobile) ──────────── */}
      <div className="z-10 border-b border-white/10 bg-background/70 px-3 py-2.5 backdrop-blur-xl sm:px-4">
        <div className="flex items-center gap-3">
          <div className="hidden shrink-0 items-center gap-2 pr-1 lg:flex">
            <MapIcon className="h-4 w-4 text-gold" />
            <span className="font-display text-lg leading-none text-foreground">Carte</span>
          </div>
          <div className="min-w-0 flex-1">
            <MapFilterBar />
          </div>
          <div className="flex shrink-0 rounded-full border border-white/12 bg-black/25 p-1 lg:hidden">
            <ViewToggle active={view === "list"} onClick={() => setView("list")}>
              Liste
            </ViewToggle>
            <ViewToggle active={view === "map"} onClick={() => setView("map")}>
              Carte
            </ViewToggle>
          </div>
        </div>
        {(showRadiusNote || showLimitNote) && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            {showRadiusNote && (
              <span className="signal-chip inline-flex rounded-full px-2.5 py-1 text-gold-soft">
                Autour de {center?.label} · {search.around_radius} km
              </span>
            )}
            {showLimitNote && (
              <span className="text-amber-100">
                {MAP_LIMIT} résultats max affichés — affinez les filtres pour une zone plus précise.
              </span>
            )}
          </div>
        )}
      </div>

      {/* ── Espace de travail : rail liste + carte ─────────────────────── */}
      <div className="flex min-h-0 flex-1">
        <aside
          className={`w-full shrink-0 border-r border-white/10 bg-background/30 lg:w-[400px] ${
            view === "map" ? "hidden lg:block" : "block"
          }`}
        >
          <MapResultsRail
            sales={filtered}
            isLoading={isLoading}
            selectedId={selectedId}
            hoveredId={hoveredId}
            onSelect={handleSelect}
            onHover={setHoveredId}
          />
        </aside>

        <div className={`relative min-w-0 flex-1 ${view === "list" ? "hidden lg:block" : "block"}`}>
          <SaleMap
            sales={filtered}
            fitToMarkers={fitToMarkers}
            selectedId={selectedId}
            hoveredId={hoveredId}
            onSelect={handleSelect}
            onHover={setHoveredId}
          />

          <MapLegend />

          {selectedSale && (
            <div className="absolute inset-x-3 bottom-3 z-[1000] sm:inset-x-auto sm:left-3 sm:w-[22rem]">
              <MapSaleCard
                sale={selectedSale}
                selected
                floating
                onClose={() => setSelectedId(null)}
              />
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function ViewToggle({
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
      className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
        active ? "bg-gold text-background" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function MapLegend() {
  const items: Array<[string, string]> = [
    ["#0f9d6e", "≥ 30 j"],
    ["#d97706", "< 30 j"],
    ["#dc2626", "< 7 j"],
    ["#6b7280", "passée"],
  ];
  return (
    <div className="liquid-panel-soft absolute bottom-3 right-3 z-[500] hidden items-center gap-3 rounded-full px-3.5 py-2 text-[11px] text-muted-foreground shadow-lg sm:flex">
      {items.map(([color, label]) => (
        <span key={label} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />
          {label}
        </span>
      ))}
    </div>
  );
}
