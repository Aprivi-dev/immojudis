"use client";

import { useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import mapboxgl from "mapbox-gl";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { getMapboxAccessToken } from "@/lib/mapbox";
import {
  mapboxPreviewCamera,
  mapboxPreviewLoadingLabel,
  mapboxPreviewModeLabel,
  type MapboxPreviewMode,
} from "@/lib/mapbox-preview";

type PreviewStatus = "idle" | "loading" | "ready" | "missing" | "error" | "unconfigured";

type MapboxPreviewButtonProps = {
  mode: MapboxPreviewMode;
  lat?: number | null;
  lng?: number | null;
  label: string;
  title: string;
  description: string;
  ariaLabel: string;
  icon: ComponentType<{ className?: string }>;
  className?: string;
};

export function MapboxPreviewButton({
  mode,
  lat,
  lng,
  label,
  title,
  description,
  ariaLabel,
  icon: Icon,
  className,
}: MapboxPreviewButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" aria-label={ariaLabel} data-mapbox-mode={mode} className={className}>
          <Icon className="h-3.5 w-3.5" />
          <span>{label}</span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-5xl gap-0 overflow-hidden p-0 sm:rounded-lg">
        <DialogHeader className="border-b border-border px-4 py-3 pr-12 text-left sm:px-5">
          <DialogTitle className="text-base">{title || mapboxPreviewModeLabel(mode)}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <MapboxPreviewCanvas active={open} mode={mode} lat={lat} lng={lng} title={title} />
      </DialogContent>
    </Dialog>
  );
}

function MapboxPreviewCanvas({
  active,
  mode,
  lat,
  lng,
  title,
}: {
  active: boolean;
  mode: MapboxPreviewMode;
  lat?: number | null;
  lng?: number | null;
  title: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<PreviewStatus>("idle");
  const token = getMapboxAccessToken();

  useEffect(() => {
    const container = containerRef.current;
    if (!active || !container) return;

    if (!token) {
      setStatus("unconfigured");
      return;
    }

    if (lat == null || lng == null) {
      setStatus("missing");
      return;
    }

    let frameId = 0;
    let previous = performance.now();
    const camera = mapboxPreviewCamera(mode);
    mapboxgl.accessToken = token;
    setStatus("loading");

    const map = new mapboxgl.Map({
      accessToken: token,
      antialias: true,
      bearing: camera.bearing,
      center: [lng, lat],
      container,
      dragRotate: true,
      pitch: camera.pitch,
      pitchWithRotate: true,
      style: camera.style,
      zoom: camera.zoom,
    });

    const markerElement = document.createElement("span");
    markerElement.className =
      "block h-4 w-4 rounded-full border-2 border-white bg-[#0f766e] shadow-[0_0_0_8px_rgba(15,118,110,0.18)]";

    const marker = new mapboxgl.Marker({ element: markerElement, anchor: "center" })
      .setLngLat([lng, lat])
      .setPopup(new mapboxgl.Popup({ offset: 18, closeButton: false }).setText(title))
      .addTo(map);

    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");

    const handleLoad = () => {
      if (camera.terrain && !map.getSource("immojudis-mapbox-preview-dem")) {
        map.addSource("immojudis-mapbox-preview-dem", {
          type: "raster-dem",
          url: "mapbox://mapbox.mapbox-terrain-dem-v1",
          tileSize: 512,
          maxzoom: 14,
        });
        map.setTerrain({ source: "immojudis-mapbox-preview-dem", exaggeration: 1.15 });
      }

      if (mode === "aerial3d") {
        const animate = (now: number) => {
          const delta = Math.min((now - previous) / 1000, 0.08);
          previous = now;
          map.rotateTo((map.getBearing() + delta * 3.5) % 360, { duration: 0 });
          frameId = window.requestAnimationFrame(animate);
        };
        frameId = window.requestAnimationFrame(animate);
      }

      setStatus("ready");
    };

    const handleError = () => setStatus("error");

    map.on("load", handleLoad);
    map.on("error", handleError);

    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      marker.remove();
      map.remove();
      setStatus("idle");
    };
  }, [active, lat, lng, mode, title, token]);

  if (lat == null || lng == null) {
    return <MapboxPreviewStatus mode={mode} status="missing" />;
  }

  return (
    <div className="relative h-[68vh] min-h-[22rem] bg-[#101418]">
      <div
        ref={containerRef}
        className="h-full w-full"
        aria-label={mapboxPreviewModeLabel(mode)}
        aria-hidden={status !== "ready"}
      />
      {status !== "ready" && <MapboxPreviewStatus mode={mode} status={status} overlay />}
    </div>
  );
}

function MapboxPreviewStatus({
  mode,
  status,
  overlay = false,
}: {
  mode: MapboxPreviewMode;
  status: PreviewStatus;
  overlay?: boolean;
}) {
  return (
    <div
      className={
        overlay
          ? "absolute inset-0 flex items-center justify-center bg-[#101418] px-6 text-center text-white"
          : "relative flex h-[68vh] min-h-[22rem] items-center justify-center bg-[#101418] px-6 text-center text-white"
      }
    >
      <div className="max-w-sm">
        <p className="text-sm font-semibold">{statusLabel(status, mode)}</p>
        <p className="mt-2 text-xs leading-relaxed text-white/70">{statusDescription(status)}</p>
      </div>
    </div>
  );
}

function statusLabel(status: PreviewStatus, mode: MapboxPreviewMode) {
  if (status === "loading") return mapboxPreviewLoadingLabel(mode);
  if (status === "missing") return "Aperçu indisponible";
  if (status === "unconfigured") return "Mapbox n'est pas configuré";
  if (status === "error") return "Mapbox n'a pas pu être chargé";
  return "Préparation de l'aperçu...";
}

function statusDescription(status: PreviewStatus) {
  if (status === "missing") {
    return "Les coordonnées ne sont pas disponibles pour cette annonce.";
  }
  if (status === "unconfigured") {
    return "Ajoutez NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN pour charger cet aperçu.";
  }
  if (status === "error") {
    return "Veuillez réessayer dans quelques instants ou vérifier la configuration Mapbox.";
  }
  return "L'encart s'affiche ici sans ouvrir de nouvel onglet.";
}
