import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { AuctionSale } from "@/lib/types";
import { formatPrice } from "@/lib/format";

// Fix Leaflet default icon paths (Vite bundling)
const iconDefault = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});
L.Marker.prototype.options.icon = iconDefault;

export function SaleMap({ sales }: { sales: AuctionSale[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current).setView([46.6, 2.4], 6);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 19,
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current || !layerRef.current) return;
    layerRef.current.clearLayers();
    const points: L.LatLngExpression[] = [];
    for (const s of sales) {
      if (s.latitude == null || s.longitude == null) continue;
      points.push([s.latitude, s.longitude]);
      const popup = `
        <div style="min-width:200px">
          <div style="font-weight:600;margin-bottom:4px">${escapeHtml(s.title ?? "Vente aux enchères")}</div>
          <div style="color:#666;font-size:12px;margin-bottom:4px">${escapeHtml(s.city ?? "")}${s.department ? " (" + escapeHtml(s.department) + ")" : ""}</div>
          <div style="font-weight:700;font-size:14px">${formatPrice(s.starting_price_eur)}</div>
          ${s.investment_score != null ? `<div style="font-size:12px;color:#555">Score: ${Math.round(s.investment_score)}</div>` : ""}
          <a href="/sales/${s.id}" style="color:#2563eb;font-size:12px;display:inline-block;margin-top:6px">Voir le détail →</a>
        </div>`;
      L.marker([s.latitude, s.longitude]).addTo(layerRef.current).bindPopup(popup);
    }
    if (points.length > 0) {
      mapRef.current.fitBounds(L.latLngBounds(points).pad(0.2));
    }
  }, [sales]);

  return <div ref={containerRef} className="h-[calc(100vh-12rem)] min-h-[400px] w-full rounded-lg border border-border" />;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}