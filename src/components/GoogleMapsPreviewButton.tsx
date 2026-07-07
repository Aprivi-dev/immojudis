"use client";

import { useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  getGoogleMapsApiKey,
  getGoogleMapsMapId,
  googleMapsAerial3dEmbedUrl,
  googleMapsAerial3dUrl,
  googleMapsStreetViewEmbedUrl,
  googleMapsStreetViewUrl,
  loadGoogleMaps,
} from "@/lib/google-maps";

const STREET_VIEW_RADIUS_M = 90;
const AERIAL_RANGE_M = 350;
const AERIAL_TILT_DEG = 60;
const MARKER_ALTITUDE_M = 45;
const ORBIT_DURATION_MS = 60000;
const FALLBACK_ORBIT_DEG_PER_S = 4.5;

export type GoogleMapsPreviewMode = "aerial3d" | "streetView";

type PreviewStatus = "idle" | "loading" | "ready" | "missing" | "error" | "unconfigured";
type PreviewCleanup = () => void;

type GoogleMapsPreviewButtonProps = {
  mode: GoogleMapsPreviewMode;
  lat?: number | null;
  lng?: number | null;
  label: string;
  title: string;
  description: string;
  ariaLabel: string;
  icon: ComponentType<{ className?: string }>;
  className?: string;
};

export function GoogleMapsPreviewButton({
  mode,
  lat,
  lng,
  label,
  title,
  description,
  ariaLabel,
  icon: Icon,
  className,
}: GoogleMapsPreviewButtonProps) {
  const [open, setOpen] = useState(false);
  const mapsUrl =
    lat != null && lng != null
      ? mode === "aerial3d"
        ? googleMapsAerial3dUrl(lat, lng)
        : googleMapsStreetViewUrl(lat, lng)
      : undefined;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          data-google-maps-url={mapsUrl}
          className={className}
        >
          <Icon className="h-3.5 w-3.5" />
          <span>{label}</span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-5xl gap-0 overflow-hidden p-0 sm:rounded-lg">
        <DialogHeader className="border-b border-border px-4 py-3 pr-12 text-left sm:px-5">
          <DialogTitle className="text-base">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <GoogleMapsPreviewCanvas active={open} mode={mode} lat={lat} lng={lng} title={title} />
      </DialogContent>
    </Dialog>
  );
}

function GoogleMapsPreviewCanvas({
  active,
  mode,
  lat,
  lng,
  title,
}: {
  active: boolean;
  mode: GoogleMapsPreviewMode;
  lat?: number | null;
  lng?: number | null;
  title: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<PreviewStatus>("idle");
  const apiKey = getGoogleMapsApiKey();
  const embedUrl =
    lat != null && lng != null
      ? mode === "aerial3d"
        ? googleMapsAerial3dEmbedUrl(lat, lng)
        : googleMapsStreetViewEmbedUrl(lat, lng)
      : "";

  useEffect(() => {
    const container = containerRef.current;
    if (!active || !container || !apiKey) return;

    if (lat == null || lng == null) {
      setStatus("missing");
      return;
    }

    let cancelled = false;
    let cleanupPreview: PreviewCleanup | undefined;
    container.replaceChildren();
    setStatus("loading");

    void (async () => {
      try {
        const g = await loadGoogleMaps(apiKey);
        if (cancelled) return;

        if (mode === "aerial3d") {
          cleanupPreview = await renderAerial3dPreview(g, container, { lat, lng }, title);
          if (cancelled) {
            cleanupPreview();
            return;
          }
        } else {
          const found = await renderStreetViewPreview(g, container, { lat, lng });
          if (cancelled) return;
          if (!found) {
            setStatus("missing");
            return;
          }
        }

        if (!cancelled) setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      cleanupPreview?.();
      container.replaceChildren();
    };
  }, [active, apiKey, lat, lng, mode, title]);

  if (lat == null || lng == null) {
    return <GoogleMapsPreviewStatus mode={mode} status="missing" />;
  }

  if (!apiKey) {
    return (
      <div className="relative h-[68vh] min-h-[22rem] bg-[#101418]">
        <iframe
          src={embedUrl}
          title={title}
          loading="eager"
          referrerPolicy="no-referrer-when-downgrade"
          className="h-full w-full border-0"
        />
      </div>
    );
  }

  return (
    <div className="relative h-[68vh] min-h-[22rem] bg-[#101418]">
      <div ref={containerRef} className="h-full w-full" aria-hidden={status !== "ready"} />
      {status !== "ready" && <GoogleMapsPreviewStatus mode={mode} status={status} overlay />}
    </div>
  );
}

function GoogleMapsPreviewStatus({
  mode,
  status,
  overlay = false,
}: {
  mode: GoogleMapsPreviewMode;
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

async function renderAerial3dPreview(
  googleApi: typeof google,
  container: HTMLDivElement,
  center: google.maps.LatLngLiteral,
  title: string,
): Promise<PreviewCleanup> {
  try {
    const { Map3DElement, Marker3DElement, MapMode, AltitudeMode } =
      await googleApi.maps.importLibrary("maps3d");
    const altitude = await getElevation(googleApi, center);
    const map3d = new Map3DElement({
      center: { ...center, altitude },
      defaultUIHidden: true,
      heading: 0,
      mode: MapMode.HYBRID,
      range: AERIAL_RANGE_M,
      tilt: AERIAL_TILT_DEG,
    });

    map3d.defaultUIHidden = true;
    map3d.style.height = "100%";
    map3d.style.width = "100%";
    container.appendChild(map3d);
    map3d.append(
      new Marker3DElement({
        altitudeMode: AltitudeMode.RELATIVE_TO_GROUND,
        extruded: true,
        label: title,
        position: { ...center, altitude: MARKER_ALTITUDE_M },
      }),
    );
    return startMap3dOrbit(map3d, center, AltitudeMode.RELATIVE_TO_GROUND);
  } catch {
    container.replaceChildren();
  }

  const map = new googleApi.maps.Map(container, {
    backgroundColor: "#101418",
    center,
    clickableIcons: false,
    disableDefaultUI: true,
    fullscreenControl: false,
    gestureHandling: "greedy",
    heading: 34,
    keyboardShortcuts: false,
    mapId: getGoogleMapsMapId() || undefined,
    mapTypeId: "satellite",
    rotateControl: true,
    streetViewControl: false,
    tilt: 45,
    zoom: 18,
    zoomControl: true,
  });
  new googleApi.maps.Marker({ map, position: center, title });
  return startTiltedMapOrbit(map);
}

function startMap3dOrbit(
  map3d: google.maps.maps3d.Map3DElement,
  center: google.maps.LatLngLiteral,
  altitudeMode: google.maps.maps3d.AltitudeMode,
): PreviewCleanup {
  const orbit = () => {
    map3d.flyCameraAround({
      camera: {
        altitudeMode,
        center: { ...center, altitude: 0 },
        heading: 0,
        range: AERIAL_RANGE_M,
        tilt: AERIAL_TILT_DEG,
      },
      durationMillis: ORBIT_DURATION_MS,
      repeatCount: 1,
    });
  };

  orbit();
  map3d.addEventListener("gmp-animationend", orbit);

  return () => {
    map3d.removeEventListener("gmp-animationend", orbit);
    map3d.stopCameraAnimation();
  };
}

function startTiltedMapOrbit(map: google.maps.Map): PreviewCleanup {
  let frameId = 0;
  let previous = performance.now();

  const animate = (now: number) => {
    const delta = Math.min((now - previous) / 1000, 0.08);
    previous = now;
    const heading = map.getHeading() ?? 0;
    map.setHeading((heading + delta * FALLBACK_ORBIT_DEG_PER_S) % 360);
    frameId = window.requestAnimationFrame(animate);
  };

  frameId = window.requestAnimationFrame(animate);
  return () => window.cancelAnimationFrame(frameId);
}

async function renderStreetViewPreview(
  googleApi: typeof google,
  container: HTMLDivElement,
  location: google.maps.LatLngLiteral,
) {
  const data = await new Promise<google.maps.StreetViewPanoramaData | null>((resolve) => {
    new googleApi.maps.StreetViewService().getPanorama(
      {
        location,
        preference: googleApi.maps.StreetViewPreference.NEAREST,
        radius: STREET_VIEW_RADIUS_M,
        source: googleApi.maps.StreetViewSource.OUTDOOR,
      },
      (result, status) => {
        resolve(status === googleApi.maps.StreetViewStatus.OK ? result : null);
      },
    );
  });

  const position = data?.location?.latLng;
  if (!position) return false;

  new googleApi.maps.StreetViewPanorama(container, {
    addressControl: false,
    clickToGo: true,
    disableDefaultUI: false,
    fullscreenControl: false,
    imageDateControl: true,
    linksControl: true,
    motionTracking: false,
    motionTrackingControl: false,
    panControl: true,
    position,
    pov: { heading: 0, pitch: 0 },
    scrollwheel: true,
    showRoadLabels: true,
    visible: true,
    zoomControl: true,
  });
  return true;
}

async function getElevation(googleApi: typeof google, location: google.maps.LatLngLiteral) {
  try {
    const { ElevationService } = await googleApi.maps.importLibrary("elevation");
    const { results } = await new ElevationService().getElevationForLocations({
      locations: [location],
    });
    return results?.[0]?.elevation ?? 0;
  } catch {
    return 0;
  }
}

function statusLabel(status: PreviewStatus, mode: GoogleMapsPreviewMode) {
  if (status === "loading") {
    return mode === "aerial3d" ? "Chargement de la vue 3D..." : "Chargement de Street View...";
  }
  if (status === "missing") return "Aperçu indisponible";
  if (status === "unconfigured") return "Google Maps n'est pas configuré";
  if (status === "error") return "Google Maps n'a pas pu être chargé";
  return "Préparation de l'aperçu...";
}

function statusDescription(status: PreviewStatus) {
  if (status === "missing") {
    return "Les coordonnées ou le panorama le plus proche ne sont pas disponibles pour cette annonce.";
  }
  if (status === "unconfigured") {
    return "L'encart utilise le repli Google Maps intégré tant que la clé publique n'est pas disponible.";
  }
  if (status === "error") {
    return "Veuillez réessayer dans quelques instants ou vérifier la configuration Google Maps.";
  }
  return "L'encart s'affiche ici sans ouvrir de nouvel onglet.";
}
