import { useEffect, useRef, useState } from "react";
import Locate from "lucide-react/dist/esm/icons/locate.js";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import type { LatLngExpression, Map, Marker, Layer, FeatureGroup } from "leaflet";
import type { AuctionMapPin } from "@/lib/types";
import {
  formatPrice,
  formatPricePerM2,
  formatDate,
  occupancyLabel,
  propertyTypeLabel,
} from "@/lib/format";
import { OSM_TILE_LAYER_URL, OSM_TILE_OPTIONS } from "@/lib/tiles";

// Couleurs cohérentes avec ScoreBadge / InvestmentAnalysis
function scoreColor(score: number | null | undefined): { bg: string; ring: string; label: string } {
  if (score == null) return { bg: "#9ca3af", ring: "#6b7280", label: "?" };
  if (score >= 80) return { bg: "#10b981", ring: "#047857", label: String(Math.round(score)) };
  if (score >= 60) return { bg: "#3b82f6", ring: "#1d4ed8", label: String(Math.round(score)) };
  if (score >= 40) return { bg: "#f59e0b", ring: "#b45309", label: String(Math.round(score)) };
  return { bg: "#ef4444", ring: "#b91c1c", label: String(Math.round(score)) };
}

function daysUntil(date: string | null | undefined): number | null {
  if (!date) return null;
  const t = new Date(date).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86_400_000);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildPopup(s: AuctionMapPin): string {
  const surface = s.app_surface_m2;
  const ppm2 = surface && s.starting_price_eur ? Math.round(s.starting_price_eur / surface) : null;
  const d = daysUntil(s.sale_date);
  const countdown = d == null ? "" : d < 0 ? "Passée" : d === 0 ? "Aujourd'hui" : `J−${d}`;
  const occupancy = occupancyLabel(s.occupancy_status);
  const countdownColor =
    d == null || d < 0 ? "#6b7280" : d < 7 ? "#dc2626" : d < 30 ? "#d97706" : "#059669";

  return `
    <div style="min-width:220px;font-family:inherit">
      <div style="font-weight:600;font-size:13px;line-height:1.3;margin-bottom:4px">${escapeHtml(s.title ?? propertyTypeLabel(s.property_type))}</div>
      <div style="color:#6b7280;font-size:11px;margin-bottom:6px">${escapeHtml([s.city, s.department && `(${s.department})`].filter(Boolean).join(" "))}</div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
        <span style="font-weight:700;font-size:15px">${formatPrice(s.starting_price_eur)}</span>
        ${ppm2 ? `<span style="color:#6b7280;font-size:11px">${formatPricePerM2(ppm2)}</span>` : ""}
      </div>
      <div style="display:flex;gap:8px;font-size:11px;color:#4b5563;margin-bottom:6px">
        ${surface ? `<span>${Math.round(surface)} m²</span>` : ""}
        ${s.sale_date ? `<span>${formatDate(s.sale_date)}</span>` : ""}
        ${countdown ? `<span style="color:${countdownColor};font-weight:600">${countdown}</span>` : ""}
      </div>
      <div style="font-size:11px;color:#4b5563;margin-bottom:6px">Occupation : <strong>${escapeHtml(occupancy)}</strong></div>
      ${s.investment_score != null ? `<div style="font-size:11px;color:#4b5563;margin-bottom:6px">Score : <strong>${Math.round(s.investment_score)}/100</strong></div>` : ""}
      <a href="/sales/${s.id}" style="display:inline-block;background:#f2c487;color:#09090b;padding:4px 10px;border-radius:6px;font-size:11px;text-decoration:none;font-weight:700">Voir le détail →</a>
    </div>`;
}

export function SaleMap({
  sales,
  fitToMarkers = false,
}: {
  sales: AuctionMapPin[];
  fitToMarkers?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const clusterRef = useRef<FeatureGroup | null>(null);
  const userMarkerRef = useRef<Layer | null>(null);
  const [ready, setReady] = useState(false);
  const [tileError, setTileError] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let cancelled = false;

    (async () => {
      try {
        setMapError(null);
        setTileError(false);
        const L = (await import("leaflet")).default;
        // leaflet.markercluster est un plugin qui attend `L` en global
        (window as unknown as { L: typeof L }).L = L;
        await import("leaflet.markercluster");
        if (cancelled || !containerRef.current || mapRef.current) return;

        const map = L.map(containerRef.current, { preferCanvas: true }).setView([46.6, 2.4], 6);
        const tiles = L.tileLayer(OSM_TILE_LAYER_URL, OSM_TILE_OPTIONS)
          .on("tileerror", () => {
            if (!cancelled) setTileError(true);
          })
          .on("tileload", () => {
            if (!cancelled) setTileError(false);
          });
        tiles.addTo(map);

        // Cluster group: petits cercles colorés selon densité
        const cluster = L.markerClusterGroup({
          showCoverageOnHover: false,
          spiderfyOnMaxZoom: true,
          maxClusterRadius: 50,
          iconCreateFunction: (c) => {
            const n = c.getChildCount();
            const size = n < 10 ? 32 : n < 50 ? 38 : 46;
            return L.divIcon({
              html: `<div style="background:rgba(9,9,11,0.9);color:#f8e5c9;width:${size}px;height:${size}px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;border:3px solid rgba(242,196,135,0.88);box-shadow:0 2px 10px rgba(0,0,0,0.35)">${n}</div>`,
              className: "auction-cluster",
              iconSize: [size, size],
            });
          },
        });
        map.addLayer(cluster);
        clusterRef.current = cluster;
        mapRef.current = map;
        setReady(true);
      } catch (error) {
        if (!cancelled) {
          setMapError(
            error instanceof Error ? error.message : "La carte n'a pas pu être initialisée.",
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      clusterRef.current = null;
      userMarkerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current || !clusterRef.current) return;
    import("leaflet").then(({ default: L }) => {
      if (!mapRef.current || !clusterRef.current) return;
      clusterRef.current.clearLayers();
      const points: LatLngExpression[] = [];
      const markers: Marker[] = [];
      for (const s of sales) {
        if (!s.id) continue;
        if (s.latitude == null || s.longitude == null) continue;
        points.push([s.latitude, s.longitude]);
        const c = scoreColor(s.investment_score);
        const icon = L.divIcon({
          html: `<div style="background:${c.bg};color:#fff;width:30px;height:30px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);display:flex;align-items:center;justify-content:center;border:2px solid ${c.ring};box-shadow:0 2px 4px rgba(0,0,0,0.3)"><span style="transform:rotate(45deg);font-size:11px;font-weight:700">${c.label}</span></div>`,
          className: "auction-pin",
          iconSize: [30, 30],
          iconAnchor: [15, 30],
          popupAnchor: [0, -28],
        });
        const m = L.marker([s.latitude, s.longitude], { icon }).bindPopup(buildPopup(s), {
          maxWidth: 260,
        });
        markers.push(m);
      }
      (clusterRef.current as unknown as { addLayers: (m: Marker[]) => void }).addLayers(markers);
      if (fitToMarkers && points.length > 0) {
        mapRef.current.fitBounds(L.latLngBounds(points).pad(0.15), { maxZoom: 13 });
      }
    });
  }, [sales, fitToMarkers, ready]);

  const locateMe = () => {
    if (!mapRef.current || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        import("leaflet").then(({ default: L }) => {
          if (!mapRef.current) return;
          mapRef.current.setView([latitude, longitude], 12);
          if (userMarkerRef.current) userMarkerRef.current.remove();
          userMarkerRef.current = L.circleMarker([latitude, longitude], {
            radius: 8,
            color: "#2563eb",
            fillColor: "#3b82f6",
            fillOpacity: 0.6,
            weight: 2,
          })
            .addTo(mapRef.current)
            .bindPopup("Votre position");
        });
      },
      () => {},
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="liquid-media h-[calc(100vh-16rem)] min-h-[400px] w-full rounded-lg"
      />
      {mapError && (
        <div className="absolute inset-0 flex items-center justify-center rounded-lg border border-gold/15 bg-background/90 px-6 text-center backdrop-blur-sm">
          <div>
            <div className="text-sm font-semibold text-foreground">Carte indisponible</div>
            <p className="mt-1 text-xs text-muted-foreground">
              Les annonces restent consultables en liste, mais le fond OpenStreetMap n'a pas pu être
              chargé.
            </p>
          </div>
        </div>
      )}
      {!mapError && tileError && (
        <div className="liquid-panel-soft absolute left-3 top-3 z-[1000] rounded-md px-3 py-2 text-xs text-muted-foreground shadow-lg">
          Fond de carte temporairement indisponible.
        </div>
      )}
      <button
        type="button"
        onClick={locateMe}
        title="Centrer sur ma position"
        className="liquid-panel-soft absolute right-3 top-3 z-[1000] inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-gold-soft shadow-md hover:border-gold"
      >
        <Locate className="h-3.5 w-3.5" /> Ma position
      </button>
    </div>
  );
}
