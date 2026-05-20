import { useEffect, useRef } from "react";
import { Locate } from "lucide-react";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import type { LatLngExpression, Map, Marker, Layer } from "leaflet";
import type { AuctionSale } from "@/lib/types";
import { formatPrice, formatDate, propertyTypeLabel } from "@/lib/format";

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

function buildPopup(s: AuctionSale): string {
  const surface = s.app_surface_m2 ?? s.habitable_surface_m2 ?? s.carrez_surface_m2;
  const ppm2 = surface && s.starting_price_eur ? Math.round(s.starting_price_eur / surface) : null;
  const d = daysUntil(s.sale_date);
  const countdown =
    d == null ? "" : d < 0 ? "Passée" : d === 0 ? "Aujourd'hui" : `J−${d}`;
  const countdownColor = d == null || d < 0 ? "#6b7280" : d < 7 ? "#dc2626" : d < 30 ? "#d97706" : "#059669";

  return `
    <div style="min-width:220px;font-family:inherit">
      <div style="font-weight:600;font-size:13px;line-height:1.3;margin-bottom:4px">${escapeHtml(s.title ?? propertyTypeLabel(s.property_type))}</div>
      <div style="color:#6b7280;font-size:11px;margin-bottom:6px">${escapeHtml([s.city, s.department && `(${s.department})`].filter(Boolean).join(" "))}</div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
        <span style="font-weight:700;font-size:15px">${formatPrice(s.starting_price_eur)}</span>
        ${ppm2 ? `<span style="color:#6b7280;font-size:11px">${formatPrice(ppm2)} €/m²</span>` : ""}
      </div>
      <div style="display:flex;gap:8px;font-size:11px;color:#4b5563;margin-bottom:6px">
        ${surface ? `<span>${Math.round(surface)} m²</span>` : ""}
        ${s.sale_date ? `<span>${formatDate(s.sale_date)}</span>` : ""}
        ${countdown ? `<span style="color:${countdownColor};font-weight:600">${countdown}</span>` : ""}
      </div>
      ${s.investment_score != null ? `<div style="font-size:11px;color:#4b5563;margin-bottom:6px">Score : <strong>${Math.round(s.investment_score)}/100</strong></div>` : ""}
      <a href="/sales/${s.id}" style="display:inline-block;background:#0f172a;color:#fff;padding:4px 10px;border-radius:4px;font-size:11px;text-decoration:none;font-weight:500">Voir le détail →</a>
    </div>`;
}

export function SaleMap({ sales }: { sales: AuctionSale[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const clusterRef = useRef<L.MarkerClusterGroup | null>(null);
  const userMarkerRef = useRef<Layer | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let cancelled = false;

    Promise.all([import("leaflet"), import("leaflet.markercluster")]).then(([{ default: L }]) => {
      if (cancelled || !containerRef.current || mapRef.current) return;

      const map = L.map(containerRef.current, { preferCanvas: true }).setView([46.6, 2.4], 6);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19,
      }).addTo(map);

      // Cluster group: petits cercles colorés selon densité
      const cluster = L.markerClusterGroup({
        showCoverageOnHover: false,
        spiderfyOnMaxZoom: true,
        maxClusterRadius: 50,
        iconCreateFunction: (c) => {
          const n = c.getChildCount();
          const size = n < 10 ? 32 : n < 50 ? 38 : 46;
          return L.divIcon({
            html: `<div style="background:rgba(15,23,42,0.85);color:#fff;width:${size}px;height:${size}px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:13px;border:3px solid rgba(255,255,255,0.95);box-shadow:0 2px 6px rgba(0,0,0,0.25)">${n}</div>`,
            className: "auction-cluster",
            iconSize: [size, size],
          });
        },
      });
      map.addLayer(cluster);
      clusterRef.current = cluster;
      mapRef.current = map;
    });

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
        const m = L.marker([s.latitude, s.longitude], { icon }).bindPopup(buildPopup(s), { maxWidth: 260 });
        markers.push(m);
      }
      clusterRef.current.addLayers(markers);
      if (points.length > 0) {
        mapRef.current.fitBounds(L.latLngBounds(points).pad(0.15), { maxZoom: 13 });
      } else {
        mapRef.current.setView([46.6, 2.4], 6);
      }
    });
  }, [sales]);

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
      <div ref={containerRef} className="h-[calc(100vh-16rem)] min-h-[400px] w-full rounded-lg border border-border" />
      <button
        type="button"
        onClick={locateMe}
        title="Centrer sur ma position"
        className="absolute right-3 top-3 z-[1000] inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium shadow-md hover:bg-accent"
      >
        <Locate className="h-3.5 w-3.5" /> Ma position
      </button>
    </div>
  );
}