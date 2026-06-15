import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import Maximize2 from "lucide-react/dist/esm/icons/maximize-2.js";
import "leaflet/dist/leaflet.css";
import type { Map as LMap, Layer } from "leaflet";
import type { AuctionSale } from "@/lib/types";
import { getNearbySales } from "@/lib/queries";
import { haversineKm } from "@/lib/geo";
import { formatPrice, formatDate, propertyTypeLabel } from "@/lib/format";
import { OSM_TILE_LAYER_URL, OSM_TILE_OPTIONS } from "@/lib/tiles";
import { getGoogleMapsApiKey } from "@/lib/google-maps";
import { GoogleLocationShowcase } from "@/components/GoogleLocationShowcase";

const DVF_RADIUS_M = 500; // cohérent avec le calculateur de rentabilité
const NEARBY_RADIUS_KM = 0.2; // phase 1 : 200 m

function scoreColor(score: number | null | undefined): string {
  if (score == null) return "#9ca3af";
  if (score >= 80) return "#10b981";
  if (score >= 60) return "#3b82f6";
  if (score >= 40) return "#f59e0b";
  return "#ef4444";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function nearbyPopup(s: AuctionSale): string {
  const surface = s.app_surface_m2 ?? s.habitable_surface_m2 ?? s.carrez_surface_m2;
  return `
    <div style="min-width:200px;font-family:inherit">
      <div style="font-weight:600;font-size:12px;line-height:1.3;margin-bottom:4px">${escapeHtml(s.title ?? propertyTypeLabel(s.property_type))}</div>
      <div style="display:flex;justify-content:space-between;font-size:11px;color:#4b5563;margin-bottom:4px">
        <span style="font-weight:600">${formatPrice(s.starting_price_eur)}</span>
        ${surface ? `<span>${Math.round(surface)} m²</span>` : ""}
      </div>
      ${s.sale_date ? `<div style="font-size:11px;color:#6b7280;margin-bottom:6px">${formatDate(s.sale_date)}</div>` : ""}
      <a href="/sales/${s.id}" style="display:inline-block;background:#f2c487;color:#09090b;padding:3px 8px;border-radius:6px;font-size:11px;text-decoration:none;font-weight:700">Voir →</a>
    </div>`;
}

export function SaleContextMap({ sale }: { sale: AuctionSale }) {
  const googleMapsApiKey = getGoogleMapsApiKey();

  if (googleMapsApiKey && sale.latitude != null && sale.longitude != null) {
    return <GoogleLocationShowcase sale={sale} apiKey={googleMapsApiKey} />;
  }

  return <OsmSaleContextMap sale={sale} />;
}

function OsmSaleContextMap({ sale }: { sale: AuctionSale }) {
  const lat = sale.latitude;
  const lng = sale.longitude;
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LMap | null>(null);
  const layersRef = useRef<Layer[]>([]);
  const [ready, setReady] = useState(false);
  const [tileError, setTileError] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);

  const { data: nearby = [] } = useQuery({
    queryKey: ["nearby-sales", sale.id, lat, lng],
    queryFn: () =>
      lat != null && lng != null
        ? getNearbySales(lat, lng, NEARBY_RADIUS_KM, sale.id, 30)
        : Promise.resolve([]),
    enabled: lat != null && lng != null,
    staleTime: 5 * 60_000,
  });

  // Filtre exact par distance (le bbox est plus large que le cercle)
  const filteredNearby = nearby.filter((s) => {
    if (s.latitude == null || s.longitude == null || lat == null || lng == null) return false;
    return haversineKm({ lat, lng }, { lat: s.latitude, lng: s.longitude }) <= NEARBY_RADIUS_KM;
  });

  useEffect(() => {
    if (!containerRef.current || mapRef.current || lat == null || lng == null) return;
    let cancelled = false;

    (async () => {
      try {
        setMapError(null);
        setTileError(false);
        const L = (await import("leaflet")).default;
        (window as unknown as { L: typeof L }).L = L;
        if (cancelled || !containerRef.current || mapRef.current) return;

        const map = L.map(containerRef.current, {
          preferCanvas: true,
          scrollWheelZoom: false,
        }).setView([lat, lng], 15);
        const tiles = L.tileLayer(OSM_TILE_LAYER_URL, OSM_TILE_OPTIONS)
          .on("tileerror", () => {
            if (!cancelled) setTileError(true);
          })
          .on("tileload", () => {
            if (!cancelled) setTileError(false);
          });
        tiles.addTo(map);

        // Cercle DVF 500 m
        L.circle([lat, lng], {
          radius: DVF_RADIUS_M,
          color: "#3b82f6",
          weight: 1.5,
          fillColor: "#3b82f6",
          fillOpacity: 0.08,
        })
          .addTo(map)
          .bindTooltip("Rayon DVF 500 m", { permanent: false, direction: "top" });

        // Pin principal (bien)
        const mainIcon = L.divIcon({
          html: `<div style="background:${scoreColor(sale.investment_score)};color:#fff;width:34px;height:34px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);display:flex;align-items:center;justify-content:center;border:3px solid rgba(242,196,135,0.9);box-shadow:0 2px 8px rgba(0,0,0,0.38)"><span style="transform:rotate(45deg);font-size:12px;font-weight:700">${sale.investment_score != null ? Math.round(sale.investment_score) : "?"}</span></div>`,
          className: "auction-pin-main",
          iconSize: [34, 34],
          iconAnchor: [17, 34],
        });
        L.marker([lat, lng], { icon: mainIcon, zIndexOffset: 1000 }).addTo(map);

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
      layersRef.current = [];
    };
  }, [lat, lng, sale.investment_score]);

  // Marqueurs des ventes voisines
  useEffect(() => {
    if (!mapRef.current || !ready) return;
    import("leaflet").then(({ default: L }) => {
      if (!mapRef.current) return;
      layersRef.current.forEach((l) => l.remove());
      layersRef.current = [];
      for (const s of filteredNearby) {
        if (s.latitude == null || s.longitude == null) continue;
        const icon = L.divIcon({
          html: `<div style="background:${scoreColor(s.investment_score)};color:#fff;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid rgba(242,196,135,0.9);box-shadow:0 1px 5px rgba(0,0,0,0.34);font-size:10px;font-weight:600">${s.investment_score != null ? Math.round(s.investment_score) : ""}</div>`,
          className: "auction-pin-nearby",
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        });
        const m = L.marker([s.latitude, s.longitude], { icon }).bindPopup(nearbyPopup(s), {
          maxWidth: 240,
        });
        m.addTo(mapRef.current!);
        layersRef.current.push(m);
      }
    });
  }, [filteredNearby, ready]);

  if (lat == null || lng == null) {
    return (
      <section className="liquid-panel rounded-lg p-5">
        <h2 className="text-lg font-semibold">Localisation</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Coordonnées GPS indisponibles pour ce bien.
        </p>
      </section>
    );
  }

  return (
    <section className="liquid-panel rounded-lg p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Localisation & voisinage</h2>
        <Link
          to="/map"
          search={{
            around_address: [sale.address, sale.postal_code, sale.city].filter(Boolean).join(" "),
            around_radius: 5,
          }}
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <Maximize2 className="h-3 w-3" /> Ouvrir la carte complète
        </Link>
      </div>
      <div className="relative overflow-hidden rounded-lg">
        <div ref={containerRef} className="liquid-media h-72 w-full" />
        {mapError && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/85 px-6 text-center backdrop-blur-sm">
            <div>
              <div className="text-sm font-semibold text-foreground">Carte indisponible</div>
              <p className="mt-1 text-xs text-muted-foreground">
                La localisation reste enregistrée, mais le fond OpenStreetMap n'a pas pu être
                chargé.
              </p>
            </div>
          </div>
        )}
        {!mapError && tileError && (
          <div className="absolute left-3 top-3 z-[500] rounded-md border border-amber-300/30 bg-background/90 px-3 py-2 text-xs text-muted-foreground shadow-lg backdrop-blur">
            Fond de carte temporairement indisponible.
          </div>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: "#3b82f6" }} />
          Cercle bleu : rayon DVF 500 m (zone de référence du calculateur)
        </span>
        <span>
          {filteredNearby.length} autre{filteredNearby.length > 1 ? "s" : ""} vente
          {filteredNearby.length > 1 ? "s" : ""} dans un rayon de 200 m
        </span>
      </div>
    </section>
  );
}
