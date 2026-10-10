"use client";

import "mapbox-gl/dist/mapbox-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";
import type mapboxgl from "mapbox-gl";
import type {
  CircleLayerSpecification,
  FillLayerSpecification,
  GeoJSONSource,
  LngLatBoundsLike,
  LineLayerSpecification,
  MapLayerMouseEvent,
  MapMouseEvent,
  SymbolLayerSpecification,
} from "mapbox-gl";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import LocateFixed from "lucide-react/dist/esm/icons/locate-fixed.js";
import MapIcon from "lucide-react/dist/esm/icons/map.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import Minus from "lucide-react/dist/esm/icons/minus.js";
import Navigation from "lucide-react/dist/esm/icons/navigation.js";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import { dpeColor, extractDpe } from "@/lib/dpe";
import { formatDate, formatPrice, formatPricePerM2, propertyTypeLabel } from "@/lib/format";
import { pricePerM2 } from "@/lib/geo";
import type { GeographicBoundary } from "@/lib/geographic-boundary";
import {
  MAPBOX_ATTRIBUTION,
  MAPBOX_COPYRIGHT_URL,
  disableMapboxTelemetry,
  getMapboxAccessToken,
  mapboxSatelliteImageUrl,
} from "@/lib/mapbox";
import {
  buildMapboxSaleFeatureCollection,
  type MapboxSaleFeatureCollection,
} from "@/lib/mapbox-sales";
import { firstPropertyImage } from "@/lib/sale-media";
import { saleDisplayTitle } from "@/lib/sale-title";
import { getDisplaySurface, getSaleSurface } from "@/lib/surface";
import { hasCoordinates } from "@/lib/search/search-filters";
import { clusterSalesLabel, framingPoints, isInMetropolitanFrance } from "@/lib/search/map-framing";
import type { ViewportBounds } from "@/lib/search/search-url-state";
import type { AuctionSale } from "@/lib/types";
import {
  AI_REVIEW_ENERGY_FIELD_KEYS,
  AI_REVIEW_FIELD_KEYS,
  AI_REVIEW_SURFACE_FIELD_KEYS,
  getAiReviewFieldResult,
  type AiReviewProjectionReadModel,
  type AiReviewRequestStatus,
} from "@/lib/ai-review-guard";
import { escapeHtml } from "@/lib/guards";

// Chargé à la demande par l'effet de création de la carte (import dynamique).
let mapboxRuntime: typeof mapboxgl | null = null;

const SALES_SOURCE_ID = "immojudis-sales";
const BOUNDARY_SOURCE_ID = "immojudis-search-boundary";
const BOUNDARY_FILL_LAYER_ID = "immojudis-search-boundary-fill";
const BOUNDARY_LINE_LAYER_ID = "immojudis-search-boundary-line";
const CLUSTER_LAYER_ID = "immojudis-sales-clusters";
const CLUSTER_COUNT_LAYER_ID = "immojudis-sales-cluster-count";
const SALE_POINT_LAYER_ID = "immojudis-sales-points";
const SALE_ACTIVE_LAYER_ID = "immojudis-sales-active";
const SALE_PRICE_LAYER_ID = "immojudis-sales-price";
const SALE_HIT_LAYER_ID = "immojudis-sales-hit";

const DEFAULT_MAP_CENTER: [number, number] = [1.7191, 46.7111];
const DEFAULT_MAP_ZOOM = 5.7;
const DEFAULT_MOBILE_MAP_ZOOM = 4.8;
const MIN_MAP_ZOOM = 4;
const MAX_MAP_ZOOM = 18;
const MAX_FIT_ZOOM = 13;
const EMPTY_ACTIVE_FILTER: MapboxFilter = ["==", ["get", "saleId"], "__none__"];
const FRANCE_BOUNDS: LngLatBoundsLike = [
  [-5.6, 41.0],
  [9.7, 51.5],
];
const FIT_PADDING = { top: 82, right: 70, bottom: 86, left: 70 };
const MOBILE_FIT_PADDING = { top: 88, right: 30, bottom: 120, left: 30 };
const EMPTY_BOUNDARY: Pick<GeographicBoundary, "type" | "features"> = {
  type: "FeatureCollection",
  features: [],
};

export type MapPanelProps = {
  locationCenter?: { lat: number; lng: number; zoom?: number } | null;
  geographicLabel?: string;
  totalCount?: number;
  preview?: boolean;
  showDpeLegend?: boolean;
  sales: AuctionSale[];
  hoveredSaleId: string | null;
  selectedSaleId: string | null;
  selectedSaleDetail?: AuctionSale | null;
  selectedSaleDetailLoading?: boolean;
  isLoading: boolean;
  searchAsMove: boolean;
  aiReviewBySaleId?: Readonly<Record<string, readonly AiReviewProjectionReadModel[]>>;
  aiReviewStatus?: AiReviewRequestStatus;
  onHover: (saleId: string | null) => void;
  onSelect: (saleId: string) => void;
  onViewportChange: (viewport: MapViewportChange) => void;
  onSearchAsMoveChange: (enabled: boolean) => void;
  onSearchViewport?: () => void;
};

export type MapViewportChange = {
  bounds: ViewportBounds;
  zoom: number;
};

type MapboxMap = mapboxgl.Map;
type GeoJSONData = Parameters<GeoJSONSource["setData"]>[0];
type MapboxFilter = NonNullable<Parameters<MapboxMap["setFilter"]>[1]>;
type QueriedMapFeature = {
  geometry?: {
    type?: string;
    coordinates?: unknown;
  };
  properties?: Record<string, unknown>;
};

type PopupAccess = { preview: boolean; analysisLocked: boolean; detailLoading: boolean };

function saleForMapReview(
  sale: AuctionSale,
  projections: readonly AiReviewProjectionReadModel[] | undefined,
  requestStatus: AiReviewRequestStatus,
  preview: boolean,
): AuctionSale {
  // Public preview has its existing display contract. Authenticated map data
  // follows the same fail-closed guard as cards and fiches.
  if (preview || requestStatus === "disabled") return sale;

  const review = (fieldKey: (typeof AI_REVIEW_FIELD_KEYS)[number]) =>
    getAiReviewFieldResult(projections, fieldKey, requestStatus);
  const typeBlocked = review("property.property_type").blocked;
  const cityBlocked = review("property.city").blocked;
  const dateBlocked = review("sale.sale_date").blocked;
  const priceBlocked = review("sale.starting_price_eur").blocked;
  const surfaceBlocked = AI_REVIEW_SURFACE_FIELD_KEYS.some((fieldKey) => review(fieldKey).blocked);
  const occupancyBlocked = review("property.occupancy_status").blocked;
  const roomsBlocked = review("property.rooms_count").blocked;
  const parkingBlocked = review("property.parking_count").blocked;
  const energyBlocked = AI_REVIEW_ENERGY_FIELD_KEYS.some((fieldKey) => review(fieldKey).blocked);
  const anyReviewedFieldBlocked = AI_REVIEW_FIELD_KEYS.some((fieldKey) => review(fieldKey).blocked);

  if (
    !typeBlocked &&
    !cityBlocked &&
    !dateBlocked &&
    !priceBlocked &&
    !surfaceBlocked &&
    !occupancyBlocked &&
    !roomsBlocked &&
    !parkingBlocked &&
    !energyBlocked
  ) {
    return sale;
  }

  return {
    ...sale,
    title: anyReviewedFieldBlocked ? "Vente à confirmer" : sale.title,
    property_type: typeBlocked ? null : sale.property_type,
    city: cityBlocked ? null : sale.city,
    department: cityBlocked ? null : sale.department,
    postal_code: cityBlocked ? null : sale.postal_code,
    address: cityBlocked ? null : sale.address,
    tribunal_city: cityBlocked ? null : sale.tribunal_city,
    latitude: cityBlocked ? null : sale.latitude,
    longitude: cityBlocked ? null : sale.longitude,
    sale_date: dateBlocked ? null : sale.sale_date,
    starting_price_eur: priceBlocked ? null : sale.starting_price_eur,
    occupancy_status: occupancyBlocked ? null : sale.occupancy_status,
    rooms_count: roomsBlocked ? null : sale.rooms_count,
    bedrooms_count: roomsBlocked ? null : sale.bedrooms_count,
    parking_count: parkingBlocked ? null : sale.parking_count,
    ...(surfaceBlocked
      ? {
          habitable_surface_m2: null,
          carrez_surface_m2: null,
          land_surface_m2: null,
          app_surface_m2: null,
          app_surface_kind: null,
          surface_scope: null,
          surface_source: null,
          surface_confidence: null,
          surface_evidence: null,
        }
      : {}),
    ...(energyBlocked
      ? {
          source_blocks: null,
          source_blocks_by_source: null,
          documents_rich: null,
        }
      : {}),
  };
}

export function MapPanel({
  locationCenter,
  geographicLabel,
  totalCount,
  preview = false,
  showDpeLegend = true,
  sales,
  hoveredSaleId,
  selectedSaleId,
  selectedSaleDetail = null,
  selectedSaleDetailLoading = false,
  isLoading,
  searchAsMove,
  aiReviewBySaleId,
  aiReviewStatus = "disabled",
  onHover,
  onSelect,
  onViewportChange,
  onSearchAsMoveChange,
  onSearchViewport,
}: MapPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const popupRef = useRef<mapboxgl.Popup | null>(null);
  const popupSaleIdRef = useRef<string | null>(null);
  const selectedSaleDetailRef = useRef<AuctionSale | null>(selectedSaleDetail);
  const aiReviewBySaleIdRef = useRef(aiReviewBySaleId);
  const aiReviewStatusRef = useRef(aiReviewStatus);
  const previewRef = useRef(preview);
  const popupAccessRef = useRef<PopupAccess>({
    preview,
    analysisLocked: !showDpeLegend,
    detailLoading: selectedSaleDetailLoading,
  });
  const onHoverRef = useRef(onHover);
  const onSelectRef = useRef(onSelect);
  const onViewportChangeRef = useRef(onViewportChange);
  const salesByIdRef = useRef<Map<string, AuctionSale>>(new Map());
  const hasUserInteractedRef = useRef(false);
  const mapGestureRef = useRef(false);
  const boundaryLabelRef = useRef<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [boundary, setBoundary] = useState<GeographicBoundary | null>(null);
  const [boundaryLoading, setBoundaryLoading] = useState(false);
  const [viewportDirty, setViewportDirty] = useState(false);
  const accessToken = useMemo(() => getMapboxAccessToken(), []);
  const mapStyle = useMemo(() => "mapbox://styles/mapbox/streets-v12", []);
  const displaySales = useMemo(
    () =>
      sales.map((sale) =>
        saleForMapReview(sale, aiReviewBySaleId?.[sale.id], aiReviewStatus, preview),
      ),
    [aiReviewBySaleId, aiReviewStatus, preview, sales],
  );
  const featureCollection = useMemo(
    () => buildMapboxSaleFeatureCollection(displaySales),
    [displaySales],
  );
  const geocodedSales = useMemo(() => displaySales.filter(hasCoordinates), [displaySales]);
  const canToggleSearchAsMove = !preview && mapReady && (geocodedSales.length > 0 || searchAsMove);
  const activeId = hoveredSaleId ?? selectedSaleId;

  function markUserInteracted() {
    hasUserInteractedRef.current = true;
  }

  useEffect(() => {
    onHoverRef.current = onHover;
  }, [onHover]);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    onViewportChangeRef.current = onViewportChange;
  }, [onViewportChange]);

  useEffect(() => {
    salesByIdRef.current = new Map(displaySales.map((sale) => [sale.id, sale]));
  }, [displaySales]);

  useEffect(() => {
    selectedSaleDetailRef.current = selectedSaleDetail;
    aiReviewBySaleIdRef.current = aiReviewBySaleId;
    aiReviewStatusRef.current = aiReviewStatus;
    previewRef.current = preview;
  }, [aiReviewBySaleId, aiReviewStatus, preview, selectedSaleDetail]);

  useEffect(() => {
    const label = geographicLabel?.trim() ?? "";
    boundaryLabelRef.current = null;
    setViewportDirty(false);

    if (!label) {
      setBoundary(null);
      setBoundaryLoading(false);
      return;
    }

    const controller = new AbortController();
    setBoundaryLoading(true);
    setBoundary(null);

    fetch(`/api/geographic-boundary?label=${encodeURIComponent(label)}`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    })
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as { boundary?: GeographicBoundary | null };
      })
      .then((payload) => {
        if (!controller.signal.aborted) setBoundary(payload?.boundary ?? null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setBoundary(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBoundaryLoading(false);
      });

    return () => controller.abort();
  }, [geographicLabel]);

  useEffect(() => {
    popupAccessRef.current = {
      preview,
      analysisLocked: !showDpeLegend,
      detailLoading: selectedSaleDetailLoading,
    };
  }, [preview, selectedSaleDetailLoading, showDpeLegend]);

  useEffect(() => {
    if (!containerRef.current || !accessToken) return;
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    // Mapbox (plusieurs centaines de Ko) ne se charge que lorsque la carte s'affiche.
    void import("mapbox-gl").then((module) => {
      if (cancelled || !containerRef.current) return;
      mapboxRuntime = module.default;
      disableMapboxTelemetry(module.default);
      cleanup = startMap(module.default);
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };

    function startMap(runtime: typeof mapboxgl): (() => void) | undefined {
      if (!containerRef.current) return undefined;
      runtime.accessToken = accessToken;
      let map: MapboxMap;
      try {
        map = new runtime.Map({
          accessToken,
          container: containerRef.current,
          style: mapStyle,
          language: "fr",
          center: DEFAULT_MAP_CENTER,
          zoom: defaultMapZoomForViewport(containerRef.current),
          minZoom: MIN_MAP_ZOOM,
          maxZoom: MAX_MAP_ZOOM,
          attributionControl: true,
          pitchWithRotate: false,
          dragRotate: false,
          cooperativeGestures: false,
        });
      } catch {
        setMapError("La carte n’a pas pu démarrer sur cet appareil.");
        return;
      }

      mapRef.current = map;
      const loadTimeout = window.setTimeout(() => {
        setMapError("Le chargement de la carte prend trop de temps.");
      }, 12_000);

      const emitViewport = () => {
        onViewportChangeRef.current({
          bounds: boundsFromMap(map),
          zoom: Number(map.getZoom().toFixed(2)),
        });
      };

      const handleMapError = (event: mapboxgl.ErrorEvent) => {
        if (event.error?.message) setMapError(event.error.message);
      };

      map.on("load", () => {
        window.clearTimeout(loadTimeout);
        setMapError(null);
        addSalesLayers(map, featureCollection);
        addBoundaryLayers(map, boundary);
        if (!hasUserInteractedRef.current) centerMapOnFrance(map, false, containerRef.current);
        emitViewport();
        setMapReady(true);
      });
      map.on("moveend", () => {
        emitViewport();
        if (mapGestureRef.current) {
          setViewportDirty(true);
          mapGestureRef.current = false;
        }
      });
      map.on("zoomend", emitViewport);
      map.on("error", handleMapError);

      const handlePointEnter = (event: MapLayerMouseEvent) => {
        map.getCanvas().style.cursor = "pointer";
        const saleId = saleIdFromFeature(event.features?.[0]);
        if (saleId) onHoverRef.current(saleId);
      };

      const handlePointLeave = () => {
        map.getCanvas().style.cursor = "";
        onHoverRef.current(null);
      };

      const handlePointClick = (event: MapLayerMouseEvent) => {
        markUserInteracted();
        const saleId = saleIdFromFeature(event.features?.[0]);
        if (!saleId) return;
        const sale = salesByIdRef.current.get(saleId);
        if (!sale || !hasCoordinates(sale)) return;
        event.preventDefault();
        onSelectRef.current(saleId);
        popupSaleIdRef.current = saleId;
        const detailSale =
          selectedSaleDetailRef.current?.id === saleId ? selectedSaleDetailRef.current : null;
        const popupSale = detailSale
          ? saleForMapReview(
              detailSale,
              aiReviewBySaleIdRef.current?.[saleId],
              aiReviewStatusRef.current,
              previewRef.current,
            )
          : sale;
        popupRef.current = showSalePopup(
          map,
          { ...popupSale, latitude: sale.latitude, longitude: sale.longitude },
          popupRef.current,
          popupAccessRef.current,
        );
      };

      const handleClusterEnter = () => {
        map.getCanvas().style.cursor = "pointer";
      };

      const handleClusterLeave = () => {
        map.getCanvas().style.cursor = "";
      };

      const handleClusterClick = (event: MapMouseEvent) => {
        markUserInteracted();
        const features = map.queryRenderedFeatures(event.point, { layers: [CLUSTER_LAYER_ID] });
        const feature = features[0] as QueriedMapFeature | undefined;
        const clusterId = Number(feature?.properties?.cluster_id);
        if (!Number.isFinite(clusterId)) return;
        const source = map.getSource(SALES_SOURCE_ID) as GeoJSONSource | undefined;
        source?.getClusterExpansionZoom(clusterId, (error, zoom) => {
          if (error || zoom == null) return;
          const coordinates =
            feature?.geometry?.type === "Point" && Array.isArray(feature.geometry.coordinates)
              ? feature.geometry.coordinates
              : null;
          if (!coordinates) return;
          map.easeTo({
            center: [Number(coordinates[0]), Number(coordinates[1])],
            zoom: Math.min(zoom + 0.4, MAX_MAP_ZOOM),
            duration: 420,
          });
        });
      };

      map.on("mouseenter", SALE_HIT_LAYER_ID, handlePointEnter);
      map.on("mouseleave", SALE_HIT_LAYER_ID, handlePointLeave);
      map.on("click", SALE_HIT_LAYER_ID, handlePointClick);
      map.on("mouseenter", CLUSTER_LAYER_ID, handleClusterEnter);
      map.on("mouseleave", CLUSTER_LAYER_ID, handleClusterLeave);
      map.on("click", CLUSTER_LAYER_ID, handleClusterClick);

      const canvas = map.getCanvas();
      const handleDirectMapInteraction = () => {
        markUserInteracted();
        mapGestureRef.current = true;
      };
      canvas.addEventListener("pointerdown", handleDirectMapInteraction, { passive: true });
      canvas.addEventListener("wheel", handleDirectMapInteraction, { passive: true });
      canvas.addEventListener("touchstart", handleDirectMapInteraction, { passive: true });

      const observer = new ResizeObserver(() => {
        map.resize();
        emitViewport();
      });
      observer.observe(containerRef.current!);

      return () => {
        window.clearTimeout(loadTimeout);
        observer.disconnect();
        canvas.removeEventListener("pointerdown", handleDirectMapInteraction);
        canvas.removeEventListener("wheel", handleDirectMapInteraction);
        canvas.removeEventListener("touchstart", handleDirectMapInteraction);
        popupRef.current?.remove();
        popupRef.current = null;
        popupSaleIdRef.current = null;
        map.remove();
        mapRef.current = null;
        setMapReady(false);
      };
    }
    // Mapbox owns the imperative instance; data and callbacks are updated through refs/effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, mapStyle]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const source = map.getSource(SALES_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(featureCollection as GeoJSONData);
  }, [featureCollection, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const source = map.getSource(BOUNDARY_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData((boundary ?? EMPTY_BOUNDARY) as GeoJSONData);
  }, [boundary, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    updateActiveLayer(map, activeId);
  }, [activeId, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (!selectedSaleId) {
      popupRef.current?.remove();
      popupRef.current = null;
      popupSaleIdRef.current = null;
      return;
    }
    const sale = salesByIdRef.current.get(selectedSaleId);
    if (!sale || !hasCoordinates(sale)) {
      popupRef.current?.remove();
      popupRef.current = null;
      popupSaleIdRef.current = null;
      return;
    }

    markUserInteracted();
    const zoom = Math.max(map.getZoom(), 12);
    map.easeTo({
      center: [sale.longitude, sale.latitude],
      zoom,
      duration: 360,
    });
    popupSaleIdRef.current = selectedSaleId;
    popupRef.current = showSalePopup(map, sale, popupRef.current, popupAccessRef.current);
  }, [mapReady, selectedSaleId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (selectedSaleId && salesByIdRef.current.has(selectedSaleId)) return;
    popupRef.current?.remove();
    popupRef.current = null;
    popupSaleIdRef.current = null;
  }, [displaySales, mapReady, selectedSaleId]);

  useEffect(() => {
    if (!mapRef.current || !mapReady || !selectedSaleId) return;
    if (popupSaleIdRef.current !== selectedSaleId || !popupRef.current) return;

    const popup = popupRef.current;
    const isOpen =
      typeof (popup as mapboxgl.Popup & { isOpen?: () => boolean }).isOpen === "function"
        ? (popup as mapboxgl.Popup & { isOpen: () => boolean }).isOpen()
        : true;
    if (!isOpen) return;

    const baseSale = salesByIdRef.current.get(selectedSaleId);
    if (!baseSale || !hasCoordinates(baseSale)) return;
    const detailSale = selectedSaleDetail?.id === selectedSaleId ? selectedSaleDetail : null;
    const reviewedSale = saleForMapReview(
      detailSale ?? baseSale,
      aiReviewBySaleId?.[selectedSaleId],
      aiReviewStatus,
      preview,
    );
    popup.setHTML(
      buildPopupHtml(
        { ...reviewedSale, latitude: baseSale.latitude, longitude: baseSale.longitude },
        popupAccessRef.current,
      ),
    );
  }, [
    aiReviewBySaleId,
    aiReviewStatus,
    mapReady,
    preview,
    selectedSaleDetail,
    selectedSaleDetailLoading,
    selectedSaleId,
    showDpeLegend,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (locationCenter && isInMetropolitanFrance(locationCenter.lat, locationCenter.lng))
      map.easeTo({
        center: [locationCenter.lng, locationCenter.lat],
        zoom: locationCenter.zoom ?? 10,
        duration: 500,
      });
    else centerMapOnFrance(map, true, containerRef.current);
  }, [locationCenter, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !boundary || !geographicLabel?.trim()) return;
    const boundaryKey = `${geographicLabel.trim()}:${boundary.label}:${boundary.level}`;
    if (boundaryLabelRef.current === boundaryKey) return;
    boundaryLabelRef.current = boundaryKey;
    map.fitBounds(boundary.bbox, {
      duration: hasUserInteractedRef.current ? 420 : 0,
      maxZoom: boundary.level === "commune" ? 13 : boundary.level === "department" ? 9 : 7,
      padding: isMobileMap(containerRef.current) ? MOBILE_FIT_PADDING : FIT_PADDING,
    });
    setViewportDirty(false);
  }, [boundary, geographicLabel, mapReady]);

  function zoomIn() {
    markUserInteracted();
    mapGestureRef.current = true;
    mapRef.current?.zoomIn({ duration: 240 });
  }

  function zoomOut() {
    markUserInteracted();
    mapGestureRef.current = true;
    mapRef.current?.zoomOut({ duration: 240 });
  }

  function fitVisibleSales() {
    markUserInteracted();
    mapGestureRef.current = true;
    const map = mapRef.current;
    if (!map) return;
    fitSalesOnMap(map, geocodedSales, true, containerRef.current);
  }

  function centerOnFrance() {
    markUserInteracted();
    mapGestureRef.current = true;
    const map = mapRef.current;
    if (!map) return;
    centerMapOnFrance(map, true, containerRef.current);
  }

  if (!accessToken) {
    return (
      <div className="relative h-full min-h-[28rem] overflow-hidden bg-surface-tint">
        <MapFallback message="La carte est indisponible. Vous pouvez continuer à consulter les annonces dans la liste." />
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-[28rem] overflow-hidden bg-surface-tint">
      <div
        ref={containerRef}
        aria-label="Carte Mapbox des biens Immojudis"
        data-testid="mapbox-map-panel"
        className="!absolute !inset-0 !h-full !w-full"
      />

      {mapError ? (
        <MapFallback message="La carte n’a pas pu charger. Les annonces restent accessibles dans la liste." />
      ) : null}

      {!mapError && (isLoading || !mapReady) ? (
        <div className="pointer-events-none absolute inset-x-0 top-16 z-20 grid place-items-center">
          <div className="inline-flex items-center gap-2 rounded-md border border-line bg-white px-4 py-3 text-sm font-bold text-brand-navy shadow-lg">
            <LoaderCircle className="h-4 w-4 animate-spin text-brand-navy" />
            {!mapReady ? "Chargement de la carte" : "Mise à jour de la carte"}
          </div>
        </div>
      ) : null}

      {!isLoading && mapReady && geocodedSales.length === 0 ? (
        <div className="absolute left-4 top-16 z-20 max-w-xs rounded-md border border-line bg-white/95 p-3 text-sm font-semibold text-ink-strong shadow-lg backdrop-blur">
          Aucune coordonnée disponible pour les résultats affichés.
        </div>
      ) : null}

      <div className="absolute left-4 top-4 z-30 flex max-w-[calc(100%-6rem)] flex-wrap items-center gap-2">
        {boundary ? (
          <div
            className="inline-flex items-center gap-2 rounded-md border border-line bg-white/95 px-3 py-2 text-xs font-bold text-brand-navy shadow-lg backdrop-blur"
            data-testid="map-boundary-label"
          >
            <MapPin className="h-3.5 w-3.5 text-brand-navy" />
            <span>{boundary.label}</span>
            <span className="font-medium text-ink-soft">
              {" · "}
              {boundary.level === "commune"
                ? "commune"
                : boundary.level === "department"
                  ? "département"
                  : "région"}
            </span>
            <a
              href={boundary.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-brand-navy underline underline-offset-2"
            >
              source officielle
            </a>
          </div>
        ) : boundaryLoading ? (
          <span className="rounded-md border border-line-soft bg-white/95 px-3 py-2 text-xs font-semibold text-ink-soft shadow-lg backdrop-blur">
            Recherche du contour officiel…
          </span>
        ) : null}
        {!preview ? (
          <>
            <button
              type="button"
              onClick={() => {
                if (!canToggleSearchAsMove) return;
                markUserInteracted();
                onSearchAsMoveChange(!searchAsMove);
                setViewportDirty(false);
              }}
              disabled={!canToggleSearchAsMove}
              aria-pressed={searchAsMove}
              className={`inline-flex h-10 items-center gap-2 rounded-md border px-3 text-sm font-extrabold shadow-lg backdrop-blur transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:cursor-not-allowed disabled:opacity-60 ${
                searchAsMove
                  ? "border-brand-navy bg-brand-navy text-white"
                  : "border-line-soft bg-white/95 text-brand-navy hover:border-gold disabled:hover:border-line-soft"
              }`}
            >
              <LocateFixed className="h-4 w-4" />
              {searchAsMove
                ? "Actualisation automatique activée"
                : "Actualiser en déplaçant la carte"}
            </button>
            {onSearchViewport && !searchAsMove && viewportDirty ? (
              <button
                type="button"
                data-testid="search-map-viewport"
                onClick={() => {
                  onSearchViewport();
                  setViewportDirty(false);
                }}
                className="inline-flex h-10 items-center gap-2 rounded-md border border-brand-navy bg-brand-navy px-3 text-sm font-extrabold text-white shadow-lg transition-colors hover:bg-brand-navy-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
              >
                <MapIcon className="h-4 w-4" />
                Rechercher dans cette zone
              </button>
            ) : null}
          </>
        ) : (
          <span className="rounded-md border border-line-soft bg-white/95 px-3 py-2 text-xs font-bold text-ink-strong shadow-lg">
            Positions approximatives · annonces de cette page
          </span>
        )}
      </div>

      <div className="absolute right-4 top-4 z-30 flex flex-col overflow-hidden rounded-md border border-line-soft bg-white shadow-lg">
        <MapIconButton label="Zoomer" onClick={zoomIn}>
          <Plus className="h-5 w-5" />
        </MapIconButton>
        <MapIconButton label="Dézoomer" onClick={zoomOut} separated>
          <Minus className="h-5 w-5" />
        </MapIconButton>
      </div>

      <div className="absolute right-4 top-32 z-30 flex flex-col gap-2">
        <MapControlButton icon={Navigation} label="Cadrer les biens" onClick={fitVisibleSales} />
        <MapControlButton icon={MapIcon} label="Voir la France" onClick={centerOnFrance} />
      </div>

      <div className="absolute bottom-10 left-4 z-30 max-w-[calc(100%-2rem)] rounded-md bg-white/95 px-3 py-2 text-xs text-ink-soft">
        {geocodedSales.length.toLocaleString("fr-FR")} annonces situées
        {totalCount != null && totalCount > geocodedSales.length
          ? ` sur ${totalCount.toLocaleString("fr-FR")} résultats${preview ? " · positions approximatives de cette page" : ""}`
          : ""}
        <span className="sr-only">
          {" "}
          Les ronds dorés regroupent plusieurs ventes ({clusterSalesLabel(2)} ou plus) ; zoomez pour
          les séparer.
        </span>
      </div>

      <a
        href={MAPBOX_COPYRIGHT_URL}
        target="_blank"
        rel="noreferrer"
        className="absolute bottom-4 right-4 z-30 hidden rounded-md border border-line-soft bg-white/95 px-2 py-1 text-[10px] font-semibold text-ink-strong shadow-lg backdrop-blur transition-colors hover:text-brand-navy md:inline-flex"
      >
        {MAPBOX_ATTRIBUTION}
      </a>
    </div>
  );
}

function addBoundaryLayers(map: MapboxMap, boundary: GeographicBoundary | null) {
  if (map.getSource(BOUNDARY_SOURCE_ID)) return;

  map.addSource(BOUNDARY_SOURCE_ID, {
    type: "geojson",
    data: (boundary ?? EMPTY_BOUNDARY) as GeoJSONData,
  });

  const fillLayer: FillLayerSpecification = {
    id: BOUNDARY_FILL_LAYER_ID,
    type: "fill",
    source: BOUNDARY_SOURCE_ID,
    paint: {
      "fill-color": "#132238",
      "fill-opacity": 0.06,
    },
  };
  const lineLayer: LineLayerSpecification = {
    id: BOUNDARY_LINE_LAYER_ID,
    type: "line",
    source: BOUNDARY_SOURCE_ID,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#132238",
      "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.5, 10, 2.5, 14, 3.5],
      "line-opacity": 0.88,
      "line-dasharray": [2, 1.5],
    },
  };
  const beforeLayer = map.getLayer(CLUSTER_LAYER_ID) ? CLUSTER_LAYER_ID : undefined;
  map.addLayer(fillLayer, beforeLayer);
  map.addLayer(lineLayer, beforeLayer);
}

function addSalesLayers(map: MapboxMap, data: MapboxSaleFeatureCollection) {
  if (map.getSource(SALES_SOURCE_ID)) return;

  map.addSource(SALES_SOURCE_ID, {
    type: "geojson",
    data: data as GeoJSONData,
    cluster: true,
    clusterMaxZoom: 13,
    clusterRadius: 54,
    generateId: true,
  });

  const clusterLayer: CircleLayerSpecification = {
    id: CLUSTER_LAYER_ID,
    type: "circle",
    source: SALES_SOURCE_ID,
    filter: ["has", "point_count"],
    paint: {
      // Or : un groupe de ventes se distingue d'une vente isolée (pastille marine avec son prix).
      "circle-color": "#c98d45",
      "circle-radius": ["step", ["get", "point_count"], 18, 10, 24, 30, 30],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 3,
      "circle-opacity": 0.96,
    },
  };

  const clusterCountLayer: SymbolLayerSpecification = {
    id: CLUSTER_COUNT_LAYER_ID,
    type: "symbol",
    source: SALES_SOURCE_ID,
    filter: ["has", "point_count"],
    layout: {
      "text-field": ["get", "point_count_abbreviated"],
      "text-size": 12,
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": "#132238",
      "text-halo-width": 0,
    },
  };

  const salePointLayer: CircleLayerSpecification = {
    id: SALE_POINT_LAYER_ID,
    type: "circle",
    source: SALES_SOURCE_ID,
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": "#132238",
      // The price label sits inside this dark capsule-like circle. Keeping a
      // generous radius at national zoom makes short prices readable without
      // the detached grey text halo that the old map used.
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 20, 9, 24, 14, 29],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
      "circle-opacity": 0.98,
    },
  };

  const activeLayer: CircleLayerSpecification = {
    id: SALE_ACTIVE_LAYER_ID,
    type: "circle",
    source: SALES_SOURCE_ID,
    filter: EMPTY_ACTIVE_FILTER,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 21, 9, 28, 16, 34],
      "circle-color": "rgba(201,141,69,0.2)",
      "circle-stroke-color": "#c98d45",
      "circle-stroke-width": 2,
    },
  };

  const salePriceLayer: SymbolLayerSpecification = {
    id: SALE_PRICE_LAYER_ID,
    type: "symbol",
    source: SALES_SOURCE_ID,
    filter: ["!", ["has", "point_count"]],
    layout: {
      "text-field": ["get", "priceLabel"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 4, 10, 9, 11, 14, 12],
      "text-anchor": "center",
      "text-offset": [0, 0],
      "text-padding": 2,
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": "#ffffff",
      "text-halo-color": "rgba(19,34,56,0.28)",
      "text-halo-width": 1,
      "text-halo-blur": 0,
    },
  };

  const hitLayer: CircleLayerSpecification = {
    id: SALE_HIT_LAYER_ID,
    type: "circle",
    source: SALES_SOURCE_ID,
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-radius": 24,
      "circle-color": "#132238",
      "circle-opacity": 0.01,
    },
  };

  map.addLayer(clusterLayer);
  map.addLayer(clusterCountLayer);
  map.addLayer(activeLayer);
  map.addLayer(salePointLayer);
  map.addLayer(salePriceLayer);
  map.addLayer(hitLayer);
}

function updateActiveLayer(map: MapboxMap, activeId: string | null | undefined) {
  if (!map.getLayer(SALE_ACTIVE_LAYER_ID)) return;
  const filter: MapboxFilter = activeId ? ["==", ["get", "saleId"], activeId] : EMPTY_ACTIVE_FILTER;
  map.setFilter(SALE_ACTIVE_LAYER_ID, filter);
}

function centerMapOnFrance(map: MapboxMap, animate: boolean, container: HTMLDivElement | null) {
  map.fitBounds(FRANCE_BOUNDS, {
    duration: animate ? 480 : 0,
    padding: isMobileMap(container) ? 18 : 28,
  });
}

function fitSalesOnMap(
  map: MapboxMap,
  sales: AuctionSale[],
  animate: boolean,
  container: HTMLDivElement | null,
) {
  // Seuls les points plausiblement en métropole servent au cadrage (jamais l'Afrique du Nord).
  const points = framingPoints(sales.filter(hasCoordinates));
  const duration = animate ? 520 : 0;
  const padding = isMobileMap(container) ? MOBILE_FIT_PADDING : FIT_PADDING;

  if (points.length === 0) {
    centerMapOnFrance(map, animate, container);
    return;
  }

  if (points.length === 1) {
    const [sale] = points;
    map.easeTo({
      center: [sale.longitude, sale.latitude],
      zoom: 12,
      duration,
    });
    return;
  }

  const bounds = new mapboxRuntime!.LngLatBounds();
  points.forEach((sale) => bounds.extend([sale.longitude, sale.latitude]));
  map.fitBounds(bounds, {
    duration,
    maxZoom: MAX_FIT_ZOOM,
    padding,
  });
}

function boundsFromMap(map: MapboxMap): ViewportBounds {
  const bounds = map.getBounds();
  if (!bounds) {
    return { north: 51.5, south: 41, east: 9.7, west: -5.6 };
  }

  return {
    north: bounds.getNorth(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    west: bounds.getWest(),
  };
}

function saleIdFromFeature(feature: unknown) {
  const raw = (feature as QueriedMapFeature | undefined)?.properties?.saleId;
  return typeof raw === "string" && raw ? raw : null;
}

function showSalePopup(
  map: MapboxMap,
  sale: AuctionSale & { latitude: number; longitude: number },
  currentPopup: mapboxgl.Popup | null,
  access: PopupAccess,
) {
  currentPopup?.remove();
  return new mapboxRuntime!.Popup({
    closeButton: true,
    closeOnClick: true,
    className: "immo-mapbox-popup",
    maxWidth: "340px",
    offset: 18,
  })
    .setLngLat([sale.longitude, sale.latitude])
    .setHTML(buildPopupHtml(sale, access))
    .addTo(map);
}

function buildPopupHtml(
  sale: AuctionSale & { latitude: number; longitude: number },
  access: PopupAccess,
) {
  const saleTitle = access.preview
    ? [propertyTypeLabel(sale.property_type), sale.city ? `à ${sale.city}` : null]
        .filter(Boolean)
        .join(" ")
    : saleDisplayTitle(sale);
  const dpe = extractDpe(sale);
  const dpeTheme = dpeColor(dpe.class);
  const surface = getSaleSurface(sale).value;
  const displaySurface = getDisplaySurface(sale);
  const pricePerSquareMeter = pricePerM2(sale.starting_price_eur, surface);
  const score =
    sale.investment_score == null ? "À auditer" : `${Math.round(sale.investment_score)}`;
  const riskCount = sale.risks?.length ?? 0;
  const riskLabel =
    riskCount > 1 ? `${riskCount} alertes` : riskCount === 1 ? "1 alerte" : "À vérifier";
  const imageUrl = access.preview
    ? firstPropertyImage(sale.media)
    : mapboxSatelliteImageUrl({
        lat: sale.latitude,
        lng: sale.longitude,
        zoom: 15,
        width: 420,
        height: 250,
      }) || firstPropertyImage(sale.media);
  const detailUrl = `/sales/${encodeURIComponent(sale.id)}`;
  const location = [sale.city, sale.tribunal_city ?? sale.tribunal_name]
    .filter(Boolean)
    .join(" · ");

  return `
    <article class="immo-mapbox-popup-card">
      ${
        imageUrl
          ? `<img class="immo-mapbox-popup-image" src="${escapeAttribute(
              imageUrl,
            )}" alt="" loading="lazy" decoding="async" referrerpolicy="strict-origin-when-cross-origin" />`
          : ""
      }
      <div class="immo-mapbox-popup-body">
        <strong class="immo-mapbox-popup-price">${escapeHtml(
          formatPrice(sale.starting_price_eur),
        )}</strong>
        <a class="immo-mapbox-popup-title" href="${escapeAttribute(detailUrl)}">${escapeHtml(
          saleTitle,
        )}</a>
        <p class="immo-mapbox-popup-location">${escapeHtml(location)}</p>
        <div class="immo-mapbox-popup-metrics">
          <span>${escapeHtml(displaySurface.label)}</span>
          <span>${escapeHtml(formatPricePerM2(pricePerSquareMeter))}</span>
          <span>Score ${escapeHtml(access.analysisLocked ? "Analyse" : score)}</span>
          <span>Risque ${escapeHtml(access.analysisLocked ? "Analyse" : riskLabel)}</span>
        </div>
        <div class="immo-mapbox-popup-tags">
          <span>${escapeHtml(propertyTypeLabel(sale.property_type))}</span>
          ${sale.sale_date ? `<span>${escapeHtml(formatDate(sale.sale_date))}</span>` : ""}
          ${
            !access.analysisLocked && dpe.class
              ? `<span style="background:${escapeAttribute(
                  dpeTheme?.background ?? "#eef3f5",
                )};border-color:${escapeAttribute(
                  dpeTheme?.border ?? "transparent",
                )};color:${escapeAttribute(dpeTheme?.foreground ?? "#132238")}">DPE ${escapeHtml(
                  dpe.class,
                )}</span>`
              : ""
          }
        </div>
        ${
          access.detailLoading
            ? '<p class="immo-mapbox-popup-location">Chargement des informations complémentaires…</p>'
            : ""
        }
        ${access.preview ? '<p class="immo-mapbox-popup-location">Position approximative · fiche complète avec un compte gratuit</p>' : ""}
        <a class="immo-mapbox-popup-link" href="${escapeAttribute(detailUrl)}">Voir le détail</a>
      </div>
    </article>
  `;
}

function defaultMapZoomForViewport(node: HTMLDivElement) {
  if (node.clientWidth > 0 && node.clientWidth < 640) return DEFAULT_MOBILE_MAP_ZOOM;
  return DEFAULT_MAP_ZOOM;
}

function isMobileMap(node: HTMLDivElement | null) {
  return node != null && node.clientWidth > 0 && node.clientWidth < 640;
}

function MapFallback({ message }: { message: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-surface-tint/80 px-6 text-center">
      <div className="max-w-sm rounded-md border border-line bg-white p-5 shadow-lg">
        <MapPin className="mx-auto h-8 w-8 text-brand-navy" />
        <h2 className="mt-3 text-base font-bold text-brand-navy">Carte Mapbox indisponible</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">{message}</p>
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
      className={`grid h-11 w-11 cursor-pointer place-items-center text-brand-navy transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold ${
        separated ? "border-t border-line-soft" : ""
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
      className="grid h-11 w-11 cursor-pointer place-items-center rounded-md border border-line-soft bg-white text-brand-navy shadow-lg transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
      aria-label={label}
      title={label}
    >
      <Icon className="h-5 w-5" />
    </button>
  );
}

function escapeAttribute(value: string) {
  return escapeHtml(value);
}
