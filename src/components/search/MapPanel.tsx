"use client";

import type * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import Layers from "lucide-react/dist/esm/icons/layers.js";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import LocateFixed from "lucide-react/dist/esm/icons/locate-fixed.js";
import Map from "lucide-react/dist/esm/icons/map.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import Minus from "lucide-react/dist/esm/icons/minus.js";
import Navigation from "lucide-react/dist/esm/icons/navigation.js";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import { formatDate, formatPrice, propertyTypeLabel } from "@/lib/format";
import { getGoogleMapsApiKey, loadGoogleMaps } from "@/lib/google-maps";
import type { AuctionSale } from "@/lib/types";
import { compactPrice, hasCoordinates } from "@/lib/search/search-filters";
import type { ViewportBounds } from "@/lib/search/search-url-state";

const DEFAULT_MAP_CENTER = { lat: 46.7111, lng: 1.7191 };
const PRICE_MARKER_HEIGHT = 36;

export type MapPanelProps = {
  sales: AuctionSale[];
  hoveredSaleId: string | null;
  selectedSaleId: string | null;
  isLoading: boolean;
  searchAsMove: boolean;
  onHover: (saleId: string | null) => void;
  onSelect: (saleId: string) => void;
  onViewportChange: (bounds: ViewportBounds) => void;
  onSearchAsMoveChange: (enabled: boolean) => void;
};

export function MapPanel({
  sales,
  hoveredSaleId,
  selectedSaleId,
  isLoading,
  searchAsMove,
  onHover,
  onSelect,
  onViewportChange,
  onSearchAsMoveChange,
}: MapPanelProps) {
  const apiKey = getGoogleMapsApiKey();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const googleRef = useRef<typeof google | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);
  const markersRef = useRef<
    globalThis.Map<
      string,
      {
        marker: google.maps.Marker;
        sale: AuctionSale;
        listeners: google.maps.MapsEventListener[];
      }
    >
  >(new globalThis.Map());
  const searchAsMoveRef = useRef(searchAsMove);
  const onViewportChangeRef = useRef(onViewportChange);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [manualZoom, setManualZoom] = useState(6);
  const [mapTypeId, setMapTypeId] = useState<"roadmap" | "terrain">("roadmap");

  const visibleMarkerItems = useMemo(
    () => buildVisibleMapMarkerItems(sales, manualZoom),
    [manualZoom, sales],
  );

  useEffect(() => {
    searchAsMoveRef.current = searchAsMove;
    onViewportChangeRef.current = onViewportChange;
  }, [onViewportChange, searchAsMove]);

  useEffect(() => {
    if (!apiKey) {
      setMapError("Ajoutez NEXT_PUBLIC_GOOGLE_MAPS_API_KEY pour afficher Google Maps.");
      return;
    }
    if (!containerRef.current || mapRef.current) return;

    let cancelled = false;
    loadGoogleMaps(apiKey)
      .then((g) => {
        if (cancelled || !containerRef.current) return;
        googleRef.current = g;
        mapRef.current = new g.maps.Map(containerRef.current, {
          backgroundColor: "#e7f4ef",
          center: DEFAULT_MAP_CENTER,
          clickableIcons: false,
          disableDefaultUI: true,
          gestureHandling: "greedy",
          mapTypeControl: false,
          mapTypeId,
          rotateControl: false,
          scaleControl: false,
          streetViewControl: false,
          styles: GOOGLE_MAP_STYLES,
          zoom: 6,
          zoomControl: false,
        });
        infoWindowRef.current = new g.maps.InfoWindow({ maxWidth: 280 });
        setMapReady(true);
        setMapError(null);
      })
      .catch((error) => {
        if (!cancelled) {
          setMapError(error instanceof Error ? error.message : "Google Maps indisponible.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [apiKey, mapTypeId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const listener = map.addListener("idle", () => {
      const zoom = map.getZoom();
      if (typeof zoom === "number") setManualZoom(zoom);
      const bounds = map.getBounds();
      if (!bounds || !searchAsMoveRef.current) return;
      const northEast = bounds.getNorthEast();
      const southWest = bounds.getSouthWest();
      onViewportChangeRef.current({
        north: northEast.lat(),
        south: southWest.lat(),
        east: northEast.lng(),
        west: southWest.lng(),
      });
    });

    return () => listener.remove();
  }, [mapReady]);

  useEffect(() => {
    const g = googleRef.current;
    const map = mapRef.current;
    if (!g || !map || !mapReady) return;

    markersRef.current.forEach(({ marker, listeners }) => {
      listeners.forEach((listener) => listener.remove());
      marker.setMap(null);
    });
    markersRef.current.clear();

    visibleMarkerItems.forEach(({ sale, hiddenCount }, index) => {
      if (!hasCoordinates(sale)) return;
      const position = { lat: sale.latitude, lng: sale.longitude };
      const title = sale.title ?? propertyTypeLabel(sale.property_type);
      const marker = new g.maps.Marker({
        icon: createPriceMarkerIcon(g, compactPrice(sale.starting_price_eur), false, hiddenCount),
        map,
        optimized: false,
        position,
        title:
          hiddenCount > 0
            ? `${title} · ${hiddenCount} autre${hiddenCount > 1 ? "s" : ""} à proximité`
            : title,
        zIndex: index,
      });
      const listeners = [
        marker.addListener("mouseover", () => onHover(sale.id)),
        marker.addListener("mouseout", () => onHover(null)),
        marker.addListener("click", () => {
          onSelect(sale.id);
          openSaleInfoWindow(map, marker, sale, infoWindowRef.current);
        }),
      ];
      markersRef.current.set(sale.id, { marker, sale, listeners });
    });
  }, [mapReady, onHover, onSelect, visibleMarkerItems]);

  useEffect(() => {
    const g = googleRef.current;
    const map = mapRef.current;
    if (!g || !map || !mapReady) return;

    const fittedZoom = fitGoogleMapToSales(g, map, sales);
    if (fittedZoom != null) setManualZoom(fittedZoom);
  }, [mapReady, sales]);

  useEffect(() => {
    const g = googleRef.current;
    if (!g) return;

    const activeId = hoveredSaleId ?? selectedSaleId;
    let markerOrder = 0;
    markersRef.current.forEach(({ marker, sale }) => {
      const active = sale.id === activeId;
      const item = visibleMarkerItems.find(({ sale: itemSale }) => itemSale.id === sale.id);
      marker.setIcon(
        createPriceMarkerIcon(
          g,
          compactPrice(sale.starting_price_eur),
          active,
          item?.hiddenCount ?? 0,
        ),
      );
      marker.setZIndex(active ? 10_000 : markerOrder);
      markerOrder += 1;
    });
  }, [hoveredSaleId, selectedSaleId, visibleMarkerItems]);

  function changeZoom(delta: number) {
    setManualZoom((current) => {
      const next = Math.max(4, Math.min(18, current + delta));
      mapRef.current?.setZoom(next);
      return next;
    });
  }

  function fitVisibleSales() {
    const g = googleRef.current;
    const map = mapRef.current;
    if (!g || !map) return;
    const fittedZoom = fitGoogleMapToSales(g, map, sales);
    if (fittedZoom != null) setManualZoom(fittedZoom);
  }

  function centerOnFrance() {
    mapRef.current?.setCenter(DEFAULT_MAP_CENTER);
    mapRef.current?.setZoom(6);
    setManualZoom(6);
  }

  function toggleMapType() {
    const next = mapTypeId === "roadmap" ? "terrain" : "roadmap";
    setMapTypeId(next);
    mapRef.current?.setMapTypeId(next);
  }

  return (
    <div className="relative h-full min-h-[28rem] overflow-hidden bg-[#e7f4ef]">
      <div ref={containerRef} className="absolute inset-0" aria-label="Carte des biens" />

      {mapError ? <MapFallback message={mapError} /> : null}

      {!mapError && !mapReady ? (
        <div className="absolute inset-0 grid place-items-center bg-[#e7f4ef]">
          <div className="inline-flex items-center gap-2 rounded-md border border-[#cbded8] bg-white px-4 py-3 text-sm font-bold text-[#132238] shadow-lg">
            <LoaderCircle className="h-4 w-4 animate-spin text-[#0f766e]" />
            Chargement de la carte
          </div>
        </div>
      ) : null}

      {!mapError && mapReady && sales.length === 0 && !isLoading ? (
        <div className="absolute left-4 top-4 max-w-xs rounded-md border border-[#cbded8] bg-white/95 p-3 text-sm font-semibold text-[#3d4b57] shadow-lg backdrop-blur">
          Aucune coordonnée disponible pour les résultats affichés.
        </div>
      ) : null}

      <div className="absolute left-4 top-4 flex max-w-[calc(100%-2rem)] flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onSearchAsMoveChange(!searchAsMove)}
          aria-pressed={searchAsMove}
          className={`inline-flex h-10 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm font-bold shadow-lg backdrop-blur transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e] ${
            searchAsMove
              ? "border-[#0f766e] bg-[#0f766e] text-white"
              : "border-[#d6e0dc] bg-white/95 text-[#132238] hover:border-[#0f766e]"
          }`}
        >
          <LocateFixed className="h-4 w-4" />
          Chercher sur la carte
        </button>
      </div>

      <div className="absolute right-4 top-4 flex flex-col overflow-hidden rounded-md border border-[#d6e0dc] bg-white shadow-lg">
        <MapIconButton label="Zoomer" onClick={() => changeZoom(1)}>
          <Plus className="h-5 w-5" />
        </MapIconButton>
        <MapIconButton label="Dézoomer" onClick={() => changeZoom(-1)} separated>
          <Minus className="h-5 w-5" />
        </MapIconButton>
      </div>

      <div className="absolute right-4 top-32 flex flex-col gap-2">
        <MapControlButton icon={Navigation} label="Cadrer" onClick={fitVisibleSales} />
        <MapControlButton
          icon={Layers}
          label={mapTypeId === "roadmap" ? "Terrain" : "Plan"}
          onClick={toggleMapType}
        />
        <MapControlButton icon={Map} label="France" onClick={centerOnFrance} />
      </div>

      <div className="absolute bottom-4 left-4 rounded-md border border-[#d6e0dc] bg-white/95 px-3 py-2 text-xs font-semibold text-[#3d4b57] shadow-lg backdrop-blur">
        {visibleMarkerItems.length.toLocaleString("fr-FR")} markers visibles ·{" "}
        {sales.length.toLocaleString("fr-FR")} dossiers géocodés
      </div>
    </div>
  );
}

function MapFallback({ message }: { message: string }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-[#e7f4ef] px-6 text-center">
      <div className="max-w-sm rounded-md border border-[#cbded8] bg-white p-5 shadow-lg">
        <MapPin className="mx-auto h-8 w-8 text-[#0f766e]" />
        <h2 className="mt-3 text-base font-bold text-[#132238]">Carte indisponible</h2>
        <p className="mt-2 text-sm leading-relaxed text-[#55626f]">{message}</p>
      </div>
    </div>
  );
}

function MapIconButton({
  children,
  label,
  onClick,
  separated,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  separated?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`grid h-11 w-11 cursor-pointer place-items-center text-[#132238] transition-colors hover:bg-[#f4f7f9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e] ${
        separated ? "border-t border-[#d6e0dc]" : ""
      }`}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function MapControlButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-[54px] w-12 cursor-pointer flex-col items-center justify-center rounded-md border border-[#d6e0dc] bg-white text-[10px] font-semibold text-[#132238] shadow-lg transition-colors hover:bg-[#f4f7f9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e]"
      aria-label={label}
      title={label}
    >
      <Icon className="mb-0.5 h-5 w-5" />
      {label}
    </button>
  );
}

type VisibleMapMarkerItem = {
  sale: AuctionSale;
  hiddenCount: number;
};

type MarkerCollisionBox = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

function buildVisibleMapMarkerItems(sales: AuctionSale[], zoom: number): VisibleMapMarkerItem[] {
  const candidates = sales.filter(hasCoordinates);
  if (zoom >= 10) return candidates.map((sale) => ({ sale, hiddenCount: 0 }));

  const accepted: Array<VisibleMapMarkerItem & { box: MarkerCollisionBox }> = [];

  candidates.forEach((sale) => {
    const label = compactPrice(sale.starting_price_eur);
    const projected = projectLatLngToWorldPixel(sale.latitude, sale.longitude, zoom);
    const width = priceMarkerWidth(label) + 38;
    const box = {
      left: projected.x - width / 2 - 8,
      right: projected.x + width / 2 + 8,
      top: projected.y - PRICE_MARKER_HEIGHT - 10,
      bottom: projected.y + 8,
    };
    const collided = accepted.find((item) => markerBoxesOverlap(box, item.box));

    if (collided) {
      collided.hiddenCount += 1;
      return;
    }

    accepted.push({ sale, hiddenCount: 0, box });
  });

  return accepted.map(({ sale, hiddenCount }) => ({ sale, hiddenCount }));
}

function projectLatLngToWorldPixel(lat: number, lng: number, zoom: number) {
  const sinLat = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  const scale = 256 * 2 ** zoom;

  return {
    x: ((lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale,
  };
}

function markerBoxesOverlap(a: MarkerCollisionBox, b: MarkerCollisionBox) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function fitGoogleMapToSales(
  g: typeof google,
  map: google.maps.Map,
  sales: AuctionSale[],
): number | null {
  const points = sales.filter(hasCoordinates);

  if (points.length === 0) {
    map.setCenter(DEFAULT_MAP_CENTER);
    map.setZoom(6);
    return 6;
  }

  if (points.length === 1) {
    const [sale] = points;
    map.setCenter({ lat: sale.latitude, lng: sale.longitude });
    map.setZoom(12);
    return 12;
  }

  const bounds = new g.maps.LatLngBounds();
  points.forEach((sale) => bounds.extend({ lat: sale.latitude, lng: sale.longitude }));
  map.fitBounds(bounds);
  return null;
}

function createPriceMarkerIcon(
  g: typeof google,
  label: string,
  active: boolean,
  hiddenCount = 0,
): google.maps.Icon {
  const baseWidth = priceMarkerWidth(label);
  const countLabel = hiddenCount > 0 ? `+${Math.min(hiddenCount, 99)}` : "";
  const countWidth = countLabel ? Math.max(28, countLabel.length * 8 + 16) : 0;
  const width = baseWidth + countWidth;
  const height = PRICE_MARKER_HEIGHT;
  const fill = active ? "#c2410c" : "#0f766e";
  const countBubble = countLabel
    ? `<rect x="${baseWidth - 5}" y="4" width="${countWidth}" height="20" rx="10" fill="#134e4a" stroke="#ffffff" stroke-width="2"/>
       <text x="${baseWidth - 5 + countWidth / 2}" y="14.5" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif" font-size="10.5" font-weight="800" fill="#fff">${escapeSvgText(countLabel)}</text>`
    : "";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <path d="M11 2h${baseWidth - 22}a9 9 0 0 1 9 9v8a9 9 0 0 1-9 9H${baseWidth / 2 + 7}L${baseWidth / 2}34l-7-6H11a9 9 0 0 1-9-9v-8a9 9 0 0 1 9-9Z" fill="${fill}" stroke="#ffffff" stroke-width="2.5"/>
      <text x="${baseWidth / 2}" y="17" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif" font-size="12" font-weight="800" fill="#fff">${escapeSvgText(label)}</text>
      ${countBubble}
    </svg>
  `;

  return {
    anchor: new g.maps.Point(baseWidth / 2, height - 1),
    scaledSize: new g.maps.Size(width, height),
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
  };
}

function priceMarkerWidth(label: string) {
  const textWidth = Array.from(label).reduce((width, char) => {
    if (char === " ") return width + 5;
    if (/[€MmkK]/.test(char)) return width + 11;
    if (/[0-9,.]/.test(char)) return width + 8.5;
    return width + 9;
  }, 0);

  return Math.max(88, Math.min(170, Math.ceil(textWidth + 46)));
}

function openSaleInfoWindow(
  map: google.maps.Map,
  marker: google.maps.Marker,
  sale: AuctionSale,
  infoWindow: google.maps.InfoWindow | null,
) {
  if (!infoWindow) return;

  const wrapper = document.createElement("div");
  wrapper.style.display = "grid";
  wrapper.style.gap = "6px";
  wrapper.style.minWidth = "210px";

  const price = document.createElement("strong");
  price.textContent = formatPrice(sale.starting_price_eur);
  price.style.fontSize = "16px";
  price.style.color = "#132238";

  const title = document.createElement("a");
  title.href = `/sales/${encodeURIComponent(sale.id)}`;
  title.textContent = sale.title ?? propertyTypeLabel(sale.property_type);
  title.style.color = "#0f766e";
  title.style.fontWeight = "800";
  title.style.textDecoration = "none";

  const meta = document.createElement("span");
  meta.textContent = [
    sale.city,
    sale.tribunal_city ?? sale.tribunal_name,
    sale.sale_date ? formatDate(sale.sale_date) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  meta.style.color = "#55626f";
  meta.style.fontSize = "12px";

  wrapper.append(price, title, meta);
  infoWindow.setContent(wrapper);
  infoWindow.open({ anchor: marker, map, shouldFocus: false });
  if (hasCoordinates(sale)) map.panTo({ lat: sale.latitude, lng: sale.longitude });
}

function escapeSvgText(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const GOOGLE_MAP_STYLES: Array<Record<string, unknown>> = [
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  {
    featureType: "road",
    elementType: "geometry",
    stylers: [{ color: "#d4deea" }],
  },
  {
    featureType: "road.highway",
    elementType: "geometry",
    stylers: [{ color: "#b8c7dc" }],
  },
  {
    featureType: "water",
    elementType: "geometry",
    stylers: [{ color: "#8bd8e8" }],
  },
  {
    featureType: "landscape.natural",
    elementType: "geometry",
    stylers: [{ color: "#ccebd8" }],
  },
  {
    featureType: "landscape.man_made",
    elementType: "geometry",
    stylers: [{ color: "#eef4ed" }],
  },
  {
    featureType: "administrative",
    elementType: "labels.text.fill",
    stylers: [{ color: "#435160" }],
  },
];
