import { useEffect, useRef, useState } from "react";
import Locate from "lucide-react/dist/esm/icons/locate.js";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import type { Map as LeafletMap, Marker as LeafletMarker, Layer, FeatureGroup } from "leaflet";
import type { AuctionMapPin } from "@/lib/types";
import { getGoogleMapsApiKey, loadGoogleMaps } from "@/lib/google-maps";
import { propertyTypeLabel } from "@/lib/format";
import { urgencyColor, type UrgencyColor } from "@/lib/urgency";
import { OSM_TILE_LAYER_URL, OSM_TILE_OPTIONS } from "@/lib/tiles";

export type SaleMapProps = {
  sales: AuctionMapPin[];
  fitToMarkers?: boolean;
  selectedId?: string | null;
  hoveredId?: string | null;
  onSelect?: (id: string | null) => void;
  onHover?: (id: string | null) => void;
};

// Fond Google sombre, cohérent avec le thème éditorial de l'app.
const DARK_MAP_STYLE: Array<Record<string, unknown>> = [
  { elementType: "geometry", stylers: [{ color: "#11110f" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#9aa0a6" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#0b0b0d" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0c1a26" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#23241f" }] },
  { featureType: "road", elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { featureType: "landscape.natural", elementType: "geometry", stylers: [{ color: "#15150f" }] },
  { featureType: "administrative", elementType: "geometry", stylers: [{ color: "#3a3a36" }] },
];

export function SaleMap(props: SaleMapProps) {
  const apiKey = getGoogleMapsApiKey();
  if (apiKey) return <GoogleSaleMap {...props} apiKey={apiKey} />;
  return <LeafletSaleMap {...props} />;
}

// ─── Google Maps (chemin principal en prod) ─────────────────────────────────

function googleIcon(api: typeof google, color: UrgencyColor, active: boolean): google.maps.Icon {
  const stroke = active ? "#f2c487" : color.ring;
  const sw = active ? 3.6 : 2.5;
  const glow = active ? '<circle cx="22" cy="17" r="20.5" fill="#f2c487" opacity="0.22"/>' : "";
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44">' +
    '<defs><filter id="s" x="-40%" y="-30%" width="180%" height="180%"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#000" flood-opacity=".4"/></filter></defs>' +
    glow +
    `<path filter="url(#s)" d="M22 3.5c-7.46 0-13.5 5.86-13.5 13.08C8.5 26.4 22 39.5 22 39.5s13.5-13.1 13.5-22.92C35.5 9.36 29.46 3.5 22 3.5Z" fill="${color.bg}" stroke="${stroke}" stroke-width="${sw}"/>` +
    `<text x="22" y="20.5" text-anchor="middle" dominant-baseline="middle" fill="#fff" font-family="Inter,Arial,sans-serif" font-size="10.5" font-weight="800">${color.label}</text>` +
    "</svg>";
  const size = active ? 60 : 44;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new api.maps.Size(size, size),
    anchor: new api.maps.Point(size / 2, size * (40 / 44)),
  };
}

type GoogleMarkerMeta = {
  marker: google.maps.Marker;
  color: UrgencyColor;
  pos: google.maps.LatLngLiteral;
};

function clearGoogleListeners(listeners: google.maps.MapsEventListener[]) {
  listeners.splice(0).forEach((listener) => listener.remove());
}

function clearGoogleMarkers(markers: Map<string, GoogleMarkerMeta>) {
  markers.forEach((meta) => meta.marker.setMap(null));
  markers.clear();
}

function GoogleSaleMap({
  sales,
  fitToMarkers = false,
  selectedId,
  hoveredId,
  onSelect,
  onHover,
  apiKey,
}: SaleMapProps & { apiKey: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const apiRef = useRef<typeof google | null>(null);
  const markersRef = useRef<Map<string, GoogleMarkerMeta>>(new Map());
  const listenersRef = useRef<google.maps.MapsEventListener[]>([]);
  const userMarkerRef = useRef<google.maps.Marker | null>(null);
  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);

  const onSelectRef = useRef(onSelect);
  const onHoverRef = useRef(onHover);
  onSelectRef.current = onSelect;
  onHoverRef.current = onHover;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let cancelled = false;
    const listeners = listenersRef.current;
    const markers = markersRef.current;

    loadGoogleMaps(apiKey)
      .then((api) => {
        if (cancelled || !containerRef.current || mapRef.current) return;
        apiRef.current = api;
        mapRef.current = new api.maps.Map(containerRef.current, {
          backgroundColor: "#11110f",
          center: { lat: 46.6, lng: 2.4 },
          clickableIcons: false,
          fullscreenControl: true,
          gestureHandling: "greedy",
          keyboardShortcuts: true,
          mapTypeControl: false,
          mapTypeId: "roadmap",
          streetViewControl: false,
          styles: DARK_MAP_STYLE,
          zoom: 6,
          zoomControl: true,
        });
        mapRef.current.addListener("click", () => onSelectRef.current?.(null));
        setMapError(null);
        setReady(true);
      })
      .catch((error) => {
        if (!cancelled) {
          setMapError(
            error instanceof Error ? error.message : "La carte Google n'a pas pu être initialisée.",
          );
        }
      });

    return () => {
      cancelled = true;
      clearGoogleListeners(listeners);
      clearGoogleMarkers(markers);
      userMarkerRef.current?.setMap(null);
      userMarkerRef.current = null;
      mapRef.current = null;
      apiRef.current = null;
    };
  }, [apiKey]);

  // (Re)construction des marqueurs quand la liste change.
  useEffect(() => {
    const api = apiRef.current;
    const map = mapRef.current;
    if (!api || !map || !ready) return;

    clearGoogleListeners(listenersRef.current);
    clearGoogleMarkers(markersRef.current);

    const bounds = new api.maps.LatLngBounds();
    let firstPos: google.maps.LatLngLiteral | null = null;
    let count = 0;

    for (const sale of sales) {
      if (!sale.id || sale.latitude == null || sale.longitude == null) continue;
      const pos = { lat: sale.latitude, lng: sale.longitude };
      const color = urgencyColor(sale.sale_date);
      const marker = new api.maps.Marker({
        icon: googleIcon(api, color, false),
        map,
        optimized: true,
        position: pos,
        title: sale.title ?? propertyTypeLabel(sale.property_type),
        zIndex: 50,
      });
      const id = sale.id;
      listenersRef.current.push(marker.addListener("click", () => onSelectRef.current?.(id)));
      listenersRef.current.push(marker.addListener("mouseover", () => onHoverRef.current?.(id)));
      listenersRef.current.push(marker.addListener("mouseout", () => onHoverRef.current?.(null)));
      markersRef.current.set(id, { marker, color, pos });
      bounds.extend(pos);
      if (!firstPos) firstPos = pos;
      count += 1;
    }

    if (fitToMarkers && count > 1) map.fitBounds(bounds);
    else if (fitToMarkers && count === 1 && firstPos) {
      map.setCenter(firstPos);
      map.setZoom(13);
    }
  }, [ready, sales, fitToMarkers]);

  // Reflet de la sélection / du survol sur les pins (sans reconstruire).
  useEffect(() => {
    const api = apiRef.current;
    const map = mapRef.current;
    if (!api || !map) return;
    markersRef.current.forEach(({ marker, color }, id) => {
      const active = id === selectedId || id === hoveredId;
      marker.setIcon(googleIcon(api, color, active));
      marker.setZIndex(id === selectedId ? 1000 : id === hoveredId ? 800 : 50);
    });
    if (selectedId) {
      const sel = markersRef.current.get(selectedId);
      if (sel) map.panTo(sel.pos);
    }
  }, [selectedId, hoveredId]);

  const locateMe = () => {
    if (!mapRef.current || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const api = apiRef.current;
        if (!mapRef.current || !api?.maps?.Marker) return;
        const position = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        mapRef.current.setCenter(position);
        mapRef.current.setZoom(12);
        userMarkerRef.current?.setMap(null);
        userMarkerRef.current = new api.maps.Marker({
          map: mapRef.current,
          position,
          title: "Votre position",
        });
      },
      () => {},
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="liquid-media h-full w-full" />
      {mapError && <MapErrorOverlay google />}
      <LocateButton onClick={locateMe} />
    </div>
  );
}

// ─── Leaflet / OpenStreetMap (repli sans clé, et rendu local) ───────────────

function leafletDivIcon(L: typeof import("leaflet"), color: UrgencyColor, active: boolean) {
  const size = active ? 38 : 30;
  const border = active ? "#f2c487" : color.ring;
  const bw = active ? 3 : 2;
  const shadow = active
    ? "box-shadow:0 0 0 4px rgba(242,196,135,0.25),0 3px 8px rgba(0,0,0,0.45);"
    : "box-shadow:0 2px 4px rgba(0,0,0,0.3);";
  return L.divIcon({
    html: `<div style="background:${color.bg};color:#fff;width:${size}px;height:${size}px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);display:flex;align-items:center;justify-content:center;border:${bw}px solid ${border};${shadow}"><span style="transform:rotate(45deg);font-size:11px;font-weight:700">${color.label}</span></div>`,
    className: "auction-pin",
    iconSize: [size, size],
    iconAnchor: [size / 2, size],
    popupAnchor: [0, -size],
  });
}

type LeafletMarkerMeta = { marker: LeafletMarker; color: UrgencyColor };

function LeafletSaleMap({
  sales,
  fitToMarkers = false,
  selectedId,
  hoveredId,
  onSelect,
  onHover,
}: SaleMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const clusterRef = useRef<FeatureGroup | null>(null);
  const lRef = useRef<typeof import("leaflet") | null>(null);
  const markersRef = useRef<Map<string, LeafletMarkerMeta>>(new Map());
  const userMarkerRef = useRef<Layer | null>(null);
  const [ready, setReady] = useState(false);
  const [tileError, setTileError] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);

  const onSelectRef = useRef(onSelect);
  const onHoverRef = useRef(onHover);
  onSelectRef.current = onSelect;
  onHoverRef.current = onHover;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let cancelled = false;
    const markers = markersRef.current;

    (async () => {
      try {
        setMapError(null);
        setTileError(false);
        const L = (await import("leaflet")).default;
        (window as unknown as { L: typeof L }).L = L;
        await import("leaflet.markercluster");
        if (cancelled || !containerRef.current || mapRef.current) return;

        const map = L.map(containerRef.current, { preferCanvas: true }).setView([46.6, 2.4], 6);
        L.tileLayer(OSM_TILE_LAYER_URL, OSM_TILE_OPTIONS)
          .on("tileerror", () => {
            if (!cancelled) setTileError(true);
          })
          .on("tileload", () => {
            if (!cancelled) setTileError(false);
          })
          .addTo(map);

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
        map.on("click", () => onSelectRef.current?.(null));
        map.addLayer(cluster);
        lRef.current = L;
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
      lRef.current = null;
      markers.clear();
      userMarkerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const L = lRef.current;
    const map = mapRef.current;
    const cluster = clusterRef.current;
    if (!L || !map || !cluster || !ready) return;

    cluster.clearLayers();
    markersRef.current.clear();
    const points: Array<[number, number]> = [];
    const markers: LeafletMarker[] = [];

    for (const s of sales) {
      if (!s.id || s.latitude == null || s.longitude == null) continue;
      const color = urgencyColor(s.sale_date);
      const marker = L.marker([s.latitude, s.longitude], { icon: leafletDivIcon(L, color, false) });
      const id = s.id;
      marker.on("click", () => onSelectRef.current?.(id));
      marker.on("mouseover", () => onHoverRef.current?.(id));
      marker.on("mouseout", () => onHoverRef.current?.(null));
      markersRef.current.set(id, { marker, color });
      markers.push(marker);
      points.push([s.latitude, s.longitude]);
    }

    (cluster as unknown as { addLayers: (m: LeafletMarker[]) => void }).addLayers(markers);
    if (fitToMarkers && points.length > 0) {
      map.fitBounds(L.latLngBounds(points).pad(0.15), { maxZoom: 13 });
    }
  }, [ready, sales, fitToMarkers]);

  useEffect(() => {
    const L = lRef.current;
    const cluster = clusterRef.current;
    if (!L || !cluster) return;
    markersRef.current.forEach(({ marker, color }, id) => {
      const active = id === selectedId || id === hoveredId;
      marker.setIcon(leafletDivIcon(L, color, active));
    });
    if (selectedId) {
      const sel = markersRef.current.get(selectedId);
      if (sel) {
        (
          cluster as unknown as { zoomToShowLayer: (m: LeafletMarker, cb: () => void) => void }
        ).zoomToShowLayer(sel.marker, () => {});
      }
    }
  }, [selectedId, hoveredId]);

  const locateMe = () => {
    if (!mapRef.current || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        const L = lRef.current;
        if (!mapRef.current || !L) return;
        mapRef.current.setView([latitude, longitude], 12);
        if (userMarkerRef.current) userMarkerRef.current.remove();
        userMarkerRef.current = L.circleMarker([latitude, longitude], {
          radius: 8,
          color: "#2563eb",
          fillColor: "#3b82f6",
          fillOpacity: 0.6,
          weight: 2,
        }).addTo(mapRef.current);
      },
      () => {},
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="liquid-media h-full w-full" />
      {mapError && <MapErrorOverlay />}
      {!mapError && tileError && (
        <div className="liquid-panel-soft absolute left-3 top-3 z-[1000] rounded-md px-3 py-2 text-xs text-muted-foreground shadow-lg">
          Fond de carte temporairement indisponible.
        </div>
      )}
      <LocateButton onClick={locateMe} />
    </div>
  );
}

// ─── UI partagée ────────────────────────────────────────────────────────────

function LocateButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Centrer sur ma position"
      className="liquid-panel-soft absolute right-3 top-3 z-[1000] inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-gold-soft shadow-md hover:border-gold"
    >
      <Locate className="h-3.5 w-3.5" /> Ma position
    </button>
  );
}

function MapErrorOverlay({ google = false }: { google?: boolean }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center rounded-lg border border-gold/15 bg-background/90 px-6 text-center backdrop-blur-sm">
      <div>
        <div className="text-sm font-semibold text-foreground">
          {google ? "Carte Google indisponible" : "Carte indisponible"}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {google
            ? "Les annonces restent listées à gauche. Vérifie que Maps JavaScript API est activée sur la clé."
            : "Les annonces restent listées à gauche, mais le fond OpenStreetMap n'a pas pu être chargé."}
        </p>
      </div>
    </div>
  );
}
