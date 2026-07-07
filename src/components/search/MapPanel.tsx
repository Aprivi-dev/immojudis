"use client";

import type * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import LocateFixed from "lucide-react/dist/esm/icons/locate-fixed.js";
import MapIcon from "lucide-react/dist/esm/icons/map.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import Minus from "lucide-react/dist/esm/icons/minus.js";
import Navigation from "lucide-react/dist/esm/icons/navigation.js";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import { DPE_CLASSES, dpeColor, extractDpe } from "@/lib/dpe";
import { formatDate, formatPrice, propertyTypeLabel } from "@/lib/format";
import type { AuctionSale } from "@/lib/types";
import { hasCoordinates } from "@/lib/search/search-filters";
import type { ViewportBounds } from "@/lib/search/search-url-state";
import {
  OSM_ATTRIBUTION,
  OSM_COPYRIGHT_URL,
  clampOsmZoom,
  mapBoundsFromCenter,
  openStreetMapUrl,
  osmTileUrlFromXYZ,
  projectLatLngToWorldPixel,
  unprojectWorldPixelToLatLng,
  type LatLng,
  type ViewportSize,
  type WorldPixel,
} from "@/lib/tiles";

const TILE_SIZE = 256;
const DEFAULT_MAP_CENTER = { lat: 46.7111, lng: 1.7191 };
const DEFAULT_MAP_ZOOM = 6;
const DEFAULT_MOBILE_MAP_ZOOM = 5;
const MIN_MAP_ZOOM = 4;
const MAX_MAP_ZOOM = 18;
const PINCH_ZOOM_STEP = 0.25;
const POINT_MARKER_SIZE = 22;
const POINT_MARKER_ACTIVE_SIZE = 30;
const POINT_MARKER_HIT_SIZE = 40;
const POINT_MARKER_CLUSTER_BADGE_SIZE = 22;
const POINT_MARKER_COLLISION_PADDING = 10;
const POINT_MARKER_FIT_PADDING = { top: 72, right: 64, bottom: 64, left: 64 };

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

type PointerPoint = {
  pointerId: number;
  clientX: number;
  clientY: number;
};

type PanGestureState = {
  type: "pan";
  pointerId: number;
  startX: number;
  startY: number;
  startCenterPixel: WorldPixel;
  startZoom: number;
};

type PinchGestureState = {
  type: "pinch";
  anchor: LatLng;
  startDistance: number;
  startZoom: number;
};

type GestureState = PanGestureState | PinchGestureState;

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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchAsMoveRef = useRef(searchAsMove);
  const onViewportChangeRef = useRef(onViewportChange);
  const activePointersRef = useRef<Map<number, PointerPoint>>(new Map());
  const centerRef = useRef<LatLng>(DEFAULT_MAP_CENTER);
  const gestureRef = useRef<GestureState | null>(null);
  const viewportRef = useRef<ViewportSize>({ width: 0, height: 0 });
  const zoomRef = useRef(DEFAULT_MAP_ZOOM);
  const [viewport, setViewport] = useState<ViewportSize>({ width: 0, height: 0 });
  const [center, setCenter] = useState<LatLng>(DEFAULT_MAP_CENTER);
  const [zoom, setZoom] = useState(DEFAULT_MAP_ZOOM);
  const [selectedPopupSale, setSelectedPopupSale] = useState<AuctionSale | null>(null);
  const [tileError, setTileError] = useState(false);

  const visibleMarkerItems = useMemo(() => buildVisibleMapMarkerItems(sales, zoom), [sales, zoom]);

  const camera = useMemo(() => buildCamera(center, zoom, viewport), [center, viewport, zoom]);

  const markerPositions = useMemo(
    () =>
      visibleMarkerItems
        .filter(({ sale }) => hasCoordinates(sale))
        .map(({ sale, hiddenCount }) => ({
          hiddenCount,
          left: projectLatLngToWorldPixel(sale.latitude, sale.longitude, zoom).x - camera.origin.x,
          sale,
          top: projectLatLngToWorldPixel(sale.latitude, sale.longitude, zoom).y - camera.origin.y,
        })),
    [camera.origin.x, camera.origin.y, visibleMarkerItems, zoom],
  );

  const activeId = hoveredSaleId ?? selectedSaleId ?? selectedPopupSale?.id ?? null;
  const selectedPopupPosition = selectedPopupSale
    ? markerPositions.find(({ sale }) => sale.id === selectedPopupSale.id)
    : undefined;

  useEffect(() => {
    searchAsMoveRef.current = searchAsMove;
    onViewportChangeRef.current = onViewportChange;
  }, [onViewportChange, searchAsMove]);

  useEffect(() => {
    centerRef.current = center;
  }, [center]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    const update = () => {
      const nextViewport = {
        width: node.clientWidth,
        height: node.clientHeight,
      };
      viewportRef.current = nextViewport;
      setViewport(nextViewport);
    };
    update();

    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    const handleTouchStart = (event: TouchEvent) => {
      syncActiveTouches(event.touches);
      startGesture(node);
    };
    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length === 0) return;
      event.preventDefault();
      syncActiveTouches(event.touches);

      if (event.touches.length >= 2) {
        if (gestureRef.current?.type !== "pinch") startGesture(node);
        applyPinchGesture(node);
        return;
      }

      if (gestureRef.current?.type !== "pan") startGesture(node);
      applyPanGesture();
    };
    const handleTouchEnd = (event: TouchEvent) => {
      syncActiveTouches(event.touches);

      if (event.touches.length > 0) {
        startGesture(node);
        return;
      }

      gestureRef.current = null;
    };

    node.addEventListener("touchstart", handleTouchStart, { passive: false });
    node.addEventListener("touchmove", handleTouchMove, { passive: false });
    node.addEventListener("touchend", handleTouchEnd);
    node.addEventListener("touchcancel", handleTouchEnd);
    return () => {
      node.removeEventListener("touchstart", handleTouchStart);
      node.removeEventListener("touchmove", handleTouchMove);
      node.removeEventListener("touchend", handleTouchEnd);
      node.removeEventListener("touchcancel", handleTouchEnd);
    };
    // Native touch listeners must stay passive:false and read current gesture refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!searchAsMoveRef.current || viewport.width <= 0 || viewport.height <= 0) return;
    onViewportChangeRef.current(mapBoundsFromCenter(center, zoom, viewport));
  }, [center, viewport, zoom]);

  useEffect(() => {
    if (viewport.width <= 0 || viewport.height <= 0) return;
    const next = fitSalesToViewport(sales, viewport);
    setMapCamera(next.center, next.zoom);
    setSelectedPopupSale(null);
  }, [sales, viewport]);

  function changeZoom(delta: number) {
    const nextZoom = clampOsmZoom(zoomRef.current + delta, MIN_MAP_ZOOM, MAX_MAP_ZOOM);
    zoomRef.current = nextZoom;
    setZoom(nextZoom);
  }

  function fitVisibleSales() {
    if (viewport.width <= 0 || viewport.height <= 0) return;
    const next = fitSalesToViewport(sales, viewport);
    setMapCamera(next.center, next.zoom);
  }

  function centerOnFrance() {
    setMapCamera(DEFAULT_MAP_CENTER, defaultMapZoomForViewport(viewportRef.current));
    setSelectedPopupSale(null);
  }

  function setMapCamera(nextCenter: LatLng, nextZoom = zoomRef.current) {
    centerRef.current = nextCenter;
    zoomRef.current = nextZoom;
    setCenter(nextCenter);
    setZoom(nextZoom);
  }

  function setMapCenter(nextCenter: LatLng) {
    centerRef.current = nextCenter;
    setCenter(nextCenter);
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "touch") return;
    if (event.pointerType === "mouse" && event.button !== 0) return;

    activePointersRef.current.set(event.pointerId, pointerPointFromEvent(event));
    startGesture(event.currentTarget);

    safelySetPointerCapture(event.currentTarget, event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "touch") return;
    if (!activePointersRef.current.has(event.pointerId)) return;
    activePointersRef.current.set(event.pointerId, pointerPointFromEvent(event));
    if (event.pointerType !== "mouse") event.preventDefault();

    if (activePointersRef.current.size >= 2) {
      if (gestureRef.current?.type !== "pinch") startGesture(event.currentTarget);
      applyPinchGesture(event.currentTarget);
      return;
    }

    if (gestureRef.current?.type !== "pan" || gestureRef.current.pointerId !== event.pointerId) {
      startGesture(event.currentTarget);
    }

    applyPanGesture();
  }

  function handlePointerEnd(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "touch") return;
    activePointersRef.current.delete(event.pointerId);

    safelyReleasePointerCapture(event.currentTarget, event.pointerId);

    if (activePointersRef.current.size > 0) {
      startGesture(event.currentTarget);
      return;
    }

    gestureRef.current = null;
  }

  function applyPanGesture() {
    const gesture = gestureRef.current;
    if (!gesture || gesture.type !== "pan") return;

    const pointer = activePointersRef.current.get(gesture.pointerId);
    if (!pointer) return;

    const nextCenterPixel = {
      x: gesture.startCenterPixel.x - (pointer.clientX - gesture.startX),
      y: gesture.startCenterPixel.y - (pointer.clientY - gesture.startY),
    };
    setMapCenter(
      unprojectWorldPixelToLatLng(nextCenterPixel.x, nextCenterPixel.y, gesture.startZoom),
    );
  }

  function startGesture(node: HTMLDivElement) {
    const pointers = Array.from(activePointersRef.current.values());

    if (pointers.length >= 2) {
      const [first, second] = pointers;
      const distance = distanceBetween(first, second);
      if (distance <= 0) return;
      gestureRef.current = {
        type: "pinch",
        anchor: pointToLatLng(midpointBetween(first, second), node),
        startDistance: distance,
        startZoom: zoomRef.current,
      };
      return;
    }

    if (pointers.length === 1) {
      const [pointer] = pointers;
      gestureRef.current = {
        type: "pan",
        pointerId: pointer.pointerId,
        startX: pointer.clientX,
        startY: pointer.clientY,
        startCenterPixel: projectLatLngToWorldPixel(
          centerRef.current.lat,
          centerRef.current.lng,
          zoomRef.current,
        ),
        startZoom: zoomRef.current,
      };
      return;
    }

    gestureRef.current = null;
  }

  function applyPinchGesture(node: HTMLDivElement) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.type !== "pinch") return;

    const pointers = Array.from(activePointersRef.current.values());
    if (pointers.length < 2) return;

    const [first, second] = pointers;
    const distance = distanceBetween(first, second);
    if (distance < 8) return;

    const zoomDelta = zoomDeltaFromPinchDistance(distance, gesture.startDistance);
    const nextZoom = clampOsmZoom(gesture.startZoom + zoomDelta, MIN_MAP_ZOOM, MAX_MAP_ZOOM);
    const midpoint = midpointBetween(first, second);
    const midpointOffset = pointOffsetFromViewportCenter(midpoint, node);
    const anchorPixel = projectLatLngToWorldPixel(gesture.anchor.lat, gesture.anchor.lng, nextZoom);
    const nextCenterPixel = {
      x: anchorPixel.x - midpointOffset.x,
      y: anchorPixel.y - midpointOffset.y,
    };

    setMapCamera(
      unprojectWorldPixelToLatLng(nextCenterPixel.x, nextCenterPixel.y, nextZoom),
      nextZoom,
    );
    if (zoomDelta !== 0) {
      gestureRef.current = {
        type: "pinch",
        anchor: pointToLatLng(midpoint, node),
        startDistance: distance,
        startZoom: nextZoom,
      };
    }
  }

  function syncActiveTouches(touches: TouchList) {
    activePointersRef.current.clear();
    Array.from(touches).forEach((touch) => {
      activePointersRef.current.set(touch.identifier, touchPointFromTouch(touch));
    });
  }

  function pointToLatLng(point: PointerPoint, node: HTMLDivElement) {
    const offset = pointOffsetFromViewportCenter(point, node);
    const centerPixel = projectLatLngToWorldPixel(
      centerRef.current.lat,
      centerRef.current.lng,
      zoomRef.current,
    );

    return unprojectWorldPixelToLatLng(
      centerPixel.x + offset.x,
      centerPixel.y + offset.y,
      zoomRef.current,
    );
  }

  function pointOffsetFromViewportCenter(point: PointerPoint, node: HTMLDivElement) {
    const rect = node.getBoundingClientRect();
    const width = viewportRef.current.width || node.clientWidth;
    const height = viewportRef.current.height || node.clientHeight;

    return {
      x: point.clientX - rect.left - width / 2,
      y: point.clientY - rect.top - height / 2,
    };
  }

  return (
    <div className="relative h-full min-h-[28rem] overflow-hidden bg-[#dcece5]">
      <div
        ref={containerRef}
        aria-label="Carte OpenStreetMap des biens"
        data-testid="osm-map-panel"
        className="absolute inset-0 touch-none cursor-grab select-none active:cursor-grabbing"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onLostPointerCapture={handlePointerEnd}
        style={{ overscrollBehavior: "contain", touchAction: "none" }}
      >
        <div className="absolute inset-0">
          {camera.tiles.map((tile) => (
            <img
              key={tile.key}
              src={tile.url}
              alt=""
              aria-hidden
              draggable={false}
              loading="eager"
              decoding="async"
              referrerPolicy="strict-origin-when-cross-origin"
              onError={() => setTileError(true)}
              className="absolute h-64 w-64 max-w-none select-none"
              style={{
                left: tile.left,
                top: tile.top,
              }}
            />
          ))}
        </div>

        <div className="absolute inset-0">
          {markerPositions.map(({ hiddenCount, left, sale, top }) => (
            <PointMarker
              key={sale.id}
              active={sale.id === activeId}
              hiddenCount={hiddenCount}
              left={left}
              sale={sale}
              top={top}
              onHover={onHover}
              onSelect={() => {
                onSelect(sale.id);
                setSelectedPopupSale(sale);
              }}
            />
          ))}
        </div>

        {selectedPopupSale && selectedPopupPosition ? (
          <SalePopup
            left={selectedPopupPosition.left}
            sale={selectedPopupSale}
            top={selectedPopupPosition.top}
            onClose={() => setSelectedPopupSale(null)}
          />
        ) : null}
      </div>

      {tileError ? (
        <MapFallback message="Certaines tuiles OpenStreetMap n'ont pas pu être chargées." />
      ) : null}

      {isLoading ? (
        <div className="absolute inset-x-0 top-16 z-20 grid place-items-center pointer-events-none">
          <div className="inline-flex items-center gap-2 rounded-md border border-[#cbded8] bg-white px-4 py-3 text-sm font-bold text-[#132238] shadow-lg">
            <LoaderCircle className="h-4 w-4 animate-spin text-[#0f766e]" />
            Mise à jour de la carte
          </div>
        </div>
      ) : null}

      {!isLoading && sales.length === 0 ? (
        <div className="absolute left-4 top-4 z-20 max-w-xs rounded-md border border-[#cbded8] bg-white/95 p-3 text-sm font-semibold text-[#3d4b57] shadow-lg backdrop-blur">
          Aucune coordonnée disponible pour les résultats affichés.
        </div>
      ) : null}

      <div className="absolute left-4 top-4 z-30 flex max-w-[calc(100%-2rem)] flex-wrap items-center gap-2">
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

      <div className="absolute right-4 top-4 z-30 flex flex-col overflow-hidden rounded-md border border-[#d6e0dc] bg-white shadow-lg">
        <MapIconButton label="Zoomer" onClick={() => changeZoom(1)}>
          <Plus className="h-5 w-5" />
        </MapIconButton>
        <MapIconButton label="Dézoomer" onClick={() => changeZoom(-1)} separated>
          <Minus className="h-5 w-5" />
        </MapIconButton>
      </div>

      <div className="absolute right-4 top-32 z-30 flex flex-col gap-2">
        <MapControlButton icon={Navigation} label="Cadrer" onClick={fitVisibleSales} />
        <MapControlButton icon={MapIcon} label="France" onClick={centerOnFrance} />
      </div>

      <div className="absolute bottom-4 left-4 z-30 rounded-md border border-[#d6e0dc] bg-white/95 px-3 py-2 text-xs font-semibold text-[#3d4b57] shadow-lg backdrop-blur">
        {visibleMarkerItems.length.toLocaleString("fr-FR")} points visibles ·{" "}
        {sales.length.toLocaleString("fr-FR")} dossiers géocodés
      </div>

      <div className="absolute bottom-16 left-4 z-30 hidden rounded-md border border-[#d6e0dc] bg-white/95 px-2 py-2 shadow-lg backdrop-blur sm:block">
        <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[#667482]">
          DPE
        </div>
        <div className="flex gap-1">
          {DPE_CLASSES.map((dpeClass) => {
            const color = dpeColor(dpeClass);
            return (
              <span
                key={dpeClass}
                className="grid h-5 w-5 place-items-center rounded text-[10px] font-extrabold"
                style={{ backgroundColor: color?.background, color: color?.foreground }}
              >
                {dpeClass}
              </span>
            );
          })}
        </div>
      </div>

      <a
        href={OSM_COPYRIGHT_URL}
        target="_blank"
        rel="noreferrer"
        className="absolute bottom-4 right-4 z-30 rounded-md border border-[#d6e0dc] bg-white/95 px-2 py-1 text-[10px] font-semibold text-[#3d4b57] shadow-lg backdrop-blur transition-colors hover:text-[#0f766e]"
      >
        {OSM_ATTRIBUTION}
      </a>
    </div>
  );
}

function pointerPointFromEvent(event: React.PointerEvent<HTMLDivElement>): PointerPoint {
  return {
    pointerId: event.pointerId,
    clientX: event.clientX,
    clientY: event.clientY,
  };
}

function touchPointFromTouch(touch: Touch): PointerPoint {
  return {
    pointerId: touch.identifier,
    clientX: touch.clientX,
    clientY: touch.clientY,
  };
}

function distanceBetween(first: PointerPoint, second: PointerPoint) {
  return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
}

function midpointBetween(first: PointerPoint, second: PointerPoint): PointerPoint {
  return {
    pointerId: first.pointerId,
    clientX: (first.clientX + second.clientX) / 2,
    clientY: (first.clientY + second.clientY) / 2,
  };
}

function safelySetPointerCapture(node: HTMLDivElement, pointerId: number) {
  try {
    if (!node.hasPointerCapture(pointerId)) node.setPointerCapture(pointerId);
  } catch {
    // Synthetic pointer events do not always own a native capture target.
  }
}

function safelyReleasePointerCapture(node: HTMLDivElement, pointerId: number) {
  try {
    if (node.hasPointerCapture(pointerId)) node.releasePointerCapture(pointerId);
  } catch {
    // The pointer may already be released after cancel/lost-capture paths.
  }
}

function zoomDeltaFromPinchDistance(distance: number, startDistance: number) {
  const scale = distance / Math.max(startDistance, 1);
  const rawDelta = Math.log2(scale) / PINCH_ZOOM_STEP;
  if (rawDelta >= 1) return 1;
  if (rawDelta <= -1) return -1;
  return 0;
}

function defaultMapZoomForViewport(viewport: ViewportSize) {
  if (viewport.width > 0 && viewport.width < 640) return DEFAULT_MOBILE_MAP_ZOOM;
  return DEFAULT_MAP_ZOOM;
}

function MapFallback({ message }: { message: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-[#e7f4ef]/70 px-6 text-center">
      <div className="max-w-sm rounded-md border border-[#cbded8] bg-white p-5 shadow-lg">
        <MapPin className="mx-auto h-8 w-8 text-[#0f766e]" />
        <h2 className="mt-3 text-base font-bold text-[#132238]">
          Carte partiellement indisponible
        </h2>
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

function PointMarker({
  active,
  hiddenCount,
  left,
  sale,
  top,
  onHover,
  onSelect,
}: {
  active: boolean;
  hiddenCount: number;
  left: number;
  sale: AuctionSale & { latitude: number; longitude: number };
  top: number;
  onHover: (saleId: string | null) => void;
  onSelect: () => void;
}) {
  const markerSize = active ? POINT_MARKER_ACTIVE_SIZE : POINT_MARKER_SIZE;
  const clusterLabel = hiddenCount > 0 ? `+${Math.min(hiddenCount, 99)}` : null;
  const dpe = extractDpe(sale);
  const dpeTheme = dpeColor(dpe.class);
  const markerColor = active ? "#c2410c" : (dpeTheme?.background ?? "#0f766e");

  return (
    <button
      type="button"
      data-sale-id={sale.id}
      data-testid="osm-map-marker"
      aria-label={`${sale.title ?? propertyTypeLabel(sale.property_type)} · ${formatPrice(
        sale.starting_price_eur,
      )}`}
      onMouseEnter={() => onHover(sale.id)}
      onMouseLeave={() => onHover(null)}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      className="absolute grid cursor-pointer place-items-center rounded-full transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
      style={{
        height: POINT_MARKER_HIT_SIZE,
        left,
        top,
        transform: "translate(-50%, -50%)",
        width: POINT_MARKER_HIT_SIZE,
        zIndex: active ? 20 : 10,
      }}
      title={
        hiddenCount > 0
          ? `${sale.title ?? propertyTypeLabel(sale.property_type)} · ${hiddenCount} autre${
              hiddenCount > 1 ? "s" : ""
            } à proximité`
          : (sale.title ?? propertyTypeLabel(sale.property_type))
      }
    >
      <span
        aria-hidden
        className="grid rounded-full border-[3px] border-white shadow-[0_8px_18px_rgba(19,34,56,0.22)] transition-all"
        style={{ backgroundColor: markerColor, height: markerSize, width: markerSize }}
      >
        <span
          aria-hidden
          className={`m-auto rounded-full ${active ? "h-2.5 w-2.5 bg-white" : "h-1.5 w-1.5 bg-white/85"}`}
        />
      </span>
      {clusterLabel ? (
        <span
          className="absolute right-0 top-0 z-20 grid rounded-full border-2 border-white bg-[#132238] px-1 text-[10px] font-extrabold leading-none text-white shadow-md"
          style={{
            height: POINT_MARKER_CLUSTER_BADGE_SIZE,
            minWidth: POINT_MARKER_CLUSTER_BADGE_SIZE,
          }}
        >
          {clusterLabel}
        </span>
      ) : null}
    </button>
  );
}

function SalePopup({
  left,
  sale,
  top,
  onClose,
}: {
  left: number;
  sale: AuctionSale;
  top: number;
  onClose: () => void;
}) {
  const hasLocation = hasCoordinates(sale);
  const dpe = extractDpe(sale);
  const dpeTheme = dpeColor(dpe.class);

  return (
    <div
      className="absolute z-40 w-[min(18rem,calc(100%-2rem))] -translate-x-1/2 rounded-md border border-[#d6e0dc] bg-white p-3 text-left shadow-xl"
      style={{ left, top: top - POINT_MARKER_ACTIVE_SIZE - 12 }}
      role="dialog"
      aria-label={sale.title ?? "Dossier immobilier"}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full text-[#55626f] hover:bg-[#f4f7f9]"
        aria-label="Fermer"
      >
        ×
      </button>
      <strong className="block pr-8 text-base text-[#132238]">
        {formatPrice(sale.starting_price_eur)}
      </strong>
      <a
        href={`/sales/${encodeURIComponent(sale.id)}`}
        className="mt-1 block text-sm font-extrabold text-[#0f766e] hover:underline"
      >
        {sale.title ?? propertyTypeLabel(sale.property_type)}
      </a>
      <p className="mt-1 text-xs leading-relaxed text-[#55626f]">
        {[
          sale.city,
          sale.tribunal_city ?? sale.tribunal_name,
          sale.sale_date ? formatDate(sale.sale_date) : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {dpe.class ? (
        <span
          className="mt-3 inline-flex min-h-7 items-center rounded-md border px-2 text-xs font-extrabold"
          style={{
            backgroundColor: dpeTheme?.background,
            borderColor: dpeTheme?.border,
            color: dpeTheme?.foreground,
          }}
        >
          DPE {dpe.class}
        </span>
      ) : null}
      {hasLocation ? (
        <a
          href={openStreetMapUrl(sale.latitude, sale.longitude, 17)}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex text-xs font-bold uppercase tracking-[0.12em] text-[#0f766e] hover:text-[#134e4a]"
        >
          Ouvrir dans OSM
        </a>
      ) : null}
    </div>
  );
}

type MapTile = {
  key: string;
  left: number;
  top: number;
  url: string;
};

function buildCamera(center: LatLng, zoom: number, viewport: ViewportSize) {
  if (viewport.width <= 0 || viewport.height <= 0) {
    return { origin: { x: 0, y: 0 }, tiles: [] as MapTile[] };
  }

  const centerPixel = projectLatLngToWorldPixel(center.lat, center.lng, zoom);
  const origin = {
    x: centerPixel.x - viewport.width / 2,
    y: centerPixel.y - viewport.height / 2,
  };
  const startX = Math.floor(origin.x / TILE_SIZE);
  const endX = Math.floor((origin.x + viewport.width) / TILE_SIZE);
  const startY = Math.floor(origin.y / TILE_SIZE);
  const endY = Math.floor((origin.y + viewport.height) / TILE_SIZE);
  const maxTile = 2 ** zoom;
  const tiles: MapTile[] = [];

  for (let tileY = Math.max(0, startY); tileY <= Math.min(maxTile - 1, endY); tileY += 1) {
    for (let tileX = startX; tileX <= endX; tileX += 1) {
      tiles.push({
        key: `${zoom}-${tileX}-${tileY}`,
        left: tileX * TILE_SIZE - origin.x,
        top: tileY * TILE_SIZE - origin.y,
        url: osmTileUrlFromXYZ(zoom, tileX, tileY),
      });
    }
  }

  return { origin, tiles };
}

type VisibleMapMarkerItem = {
  sale: AuctionSale & { latitude: number; longitude: number };
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
    const projected = projectLatLngToWorldPixel(sale.latitude, sale.longitude, zoom);
    const box = {
      left: projected.x - POINT_MARKER_HIT_SIZE / 2 - POINT_MARKER_COLLISION_PADDING,
      right: projected.x + POINT_MARKER_HIT_SIZE / 2 + POINT_MARKER_COLLISION_PADDING,
      top: projected.y - POINT_MARKER_HIT_SIZE / 2 - POINT_MARKER_COLLISION_PADDING,
      bottom: projected.y + POINT_MARKER_HIT_SIZE / 2 + POINT_MARKER_COLLISION_PADDING,
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

function markerBoxesOverlap(a: MarkerCollisionBox, b: MarkerCollisionBox) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function fitSalesToViewport(
  sales: AuctionSale[],
  viewport: ViewportSize,
): {
  center: LatLng;
  zoom: number;
} {
  const points = sales.filter(hasCoordinates);

  if (points.length === 0) {
    return { center: DEFAULT_MAP_CENTER, zoom: defaultMapZoomForViewport(viewport) };
  }

  if (points.length === 1) {
    const [sale] = points;
    return { center: { lat: sale.latitude, lng: sale.longitude }, zoom: 12 };
  }

  const availableWidth =
    viewport.width - POINT_MARKER_FIT_PADDING.left - POINT_MARKER_FIT_PADDING.right;
  const availableHeight =
    viewport.height - POINT_MARKER_FIT_PADDING.top - POINT_MARKER_FIT_PADDING.bottom;

  for (let nextZoom = MAX_MAP_ZOOM; nextZoom >= MIN_MAP_ZOOM; nextZoom -= 1) {
    const bounds = projectedBounds(points, nextZoom);
    if (
      bounds.width <= Math.max(120, availableWidth) &&
      bounds.height <= Math.max(120, availableHeight)
    ) {
      return {
        center: unprojectWorldPixelToLatLng(bounds.centerX, bounds.centerY, nextZoom),
        zoom: nextZoom,
      };
    }
  }

  const bounds = projectedBounds(points, MIN_MAP_ZOOM);
  return {
    center: unprojectWorldPixelToLatLng(bounds.centerX, bounds.centerY, MIN_MAP_ZOOM),
    zoom: MIN_MAP_ZOOM,
  };
}

function projectedBounds(
  sales: Array<AuctionSale & { latitude: number; longitude: number }>,
  zoom: number,
) {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  sales.forEach((sale) => {
    const projected = projectLatLngToWorldPixel(sale.latitude, sale.longitude, zoom);
    minX = Math.min(minX, projected.x);
    maxX = Math.max(maxX, projected.x);
    minY = Math.min(minY, projected.y);
    maxY = Math.max(maxY, projected.y);
  });

  return {
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    height: maxY - minY,
    width: maxX - minX,
  };
}
