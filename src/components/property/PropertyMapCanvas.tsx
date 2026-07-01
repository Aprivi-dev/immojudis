import { useEffect, useRef, useState } from "react";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import Minus from "lucide-react/dist/esm/icons/minus.js";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import type { Property } from "@/lib/property-types";
import {
  getGoogleMapsApiKey,
  getGoogleMapsMapId,
  googleMapsUrl,
  loadGoogleMaps,
} from "@/lib/google-maps";
import { MapThumbnail } from "@/components/MapThumbnail";

const INITIAL_MAP_ZOOM = 15;
const MAP_STYLES: Array<Record<string, unknown>> = [
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "simplified" }] },
];

type PropertyMarker = google.maps.Marker | google.maps.marker.AdvancedMarkerElement;

export function PropertyMapCanvas({ property }: { property: Property }) {
  const location = property.location;
  const mapRef = useRef<HTMLDivElement>(null);
  const mapObj = useRef<google.maps.Map | null>(null);
  const markerObj = useRef<PropertyMarker | null>(null);
  const [zoom, setZoom] = useState(INITIAL_MAP_ZOOM);
  const [state, setState] = useState<"loading" | "ready" | "fallback">("loading");

  useEffect(() => {
    if (!location || !mapRef.current) return;
    const apiKey = getGoogleMapsApiKey();
    if (!apiKey) {
      setState("fallback");
      return;
    }

    const mapId = getGoogleMapsMapId();
    let cancelled = false;
    void (async () => {
      try {
        const google = await loadGoogleMaps(apiKey);
        if (cancelled || !mapRef.current) return;
        const center = { lat: location.lat, lng: location.lng };
        const map = new google.maps.Map(mapRef.current, {
          center,
          zoom: INITIAL_MAP_ZOOM,
          ...(mapId ? { mapId } : { styles: MAP_STYLES }),
          disableDefaultUI: true,
          clickableIcons: false,
          gestureHandling: "cooperative",
        });
        const marker = mapId
          ? await createAdvancedMarker(google, map, center, property.title)
          : new google.maps.Marker({
              position: center,
              map,
              title: property.title,
            });
        mapObj.current = map;
        markerObj.current = marker;
        setState("ready");
      } catch {
        if (!cancelled) setState("fallback");
      }
    })();

    return () => {
      cancelled = true;
      clearPropertyMarker(markerObj.current);
      markerObj.current = null;
      mapObj.current = null;
    };
  }, [location, property.title]);

  useEffect(() => {
    mapObj.current?.setZoom(zoom);
  }, [zoom]);

  if (!location) {
    return (
      <div className="flex min-h-[22rem] items-center justify-center rounded-md border border-border bg-muted/40 text-center">
        <div className="max-w-sm px-5">
          <span className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full border border-border bg-white text-muted-foreground">
            <MapPin className="h-6 w-6" />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-foreground">Coordonnees absentes</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            La carte sera affichee lorsque la latitude et la longitude seront disponibles.
          </p>
        </div>
      </div>
    );
  }

  const openUrl = googleMapsUrl(
    location.lat,
    location.lng,
    `${property.address}, ${property.city}`,
  );

  return (
    <div className="relative min-h-[22rem] overflow-hidden rounded-md border border-border bg-muted">
      {state === "fallback" ? (
        <MapThumbnail
          lat={location.lat}
          lng={location.lng}
          zoom={zoom}
          alt={`Carte de ${property.address}`}
          className="h-[22rem] w-full"
        />
      ) : (
        <div ref={mapRef} className="h-[22rem] w-full" aria-label={`Carte de ${property.title}`} />
      )}
      {state === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/72 text-sm font-semibold text-muted-foreground">
          Chargement de la carte
        </div>
      )}
      <div className="absolute right-3 top-3 grid gap-2">
        <button
          type="button"
          onClick={() => setZoom((value) => Math.min(value + 1, 20))}
          aria-label="Zoomer"
          className="inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-md border border-border bg-white text-foreground shadow-sm transition-colors hover:text-gold-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => setZoom((value) => Math.max(value - 1, 9))}
          aria-label="Dezoomer"
          className="inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-md border border-border bg-white text-foreground shadow-sm transition-colors hover:text-gold-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
        >
          <Minus className="h-4 w-4" />
        </button>
      </div>
      <a
        href={openUrl}
        target="_blank"
        rel="noreferrer"
        className="absolute bottom-3 left-3 inline-flex min-h-10 cursor-pointer items-center justify-center rounded-md border border-border bg-white px-3 text-sm font-semibold text-foreground shadow-sm transition-colors hover:border-gold/50 hover:text-gold-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
      >
        Ouvrir la carte
      </a>
    </div>
  );
}

async function createAdvancedMarker(
  google: typeof globalThis.google,
  map: google.maps.Map,
  position: google.maps.LatLngLiteral,
  title: string,
) {
  const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
  return new AdvancedMarkerElement({
    map,
    position,
    title,
  });
}

function clearPropertyMarker(marker: PropertyMarker | null) {
  if (!marker) return;
  if ("setMap" in marker) {
    marker.setMap(null);
    return;
  }
  marker.map = null;
}
