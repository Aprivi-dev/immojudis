import { useEffect, useState } from "react";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import { osmTileUrl, osmTileMarkerPct } from "@/lib/tiles";

type Props = {
  lat: number | null | undefined;
  lng: number | null | undefined;
  zoom?: number;
  className?: string;
  alt?: string;
};

/**
 * Lightweight OSM single-tile thumbnail with an overlay pin.
 * No JS map, no API key — just an <img> + an absolutely positioned marker.
 */
export function MapThumbnail({ lat, lng, zoom = 15, className, alt }: Props) {
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    setErrored(false);
  }, [lat, lng, zoom]);

  if (lat == null || lng == null) {
    return (
      <div
        className={`flex items-center justify-center bg-muted text-xs text-muted-foreground ${className ?? ""}`}
      >
        Pas de localisation
      </div>
    );
  }

  if (errored) {
    return (
      <div
        className={`relative flex items-center justify-center overflow-hidden bg-[var(--surface)] ${className ?? ""}`}
      >
        <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(13,27,42,0.96),rgba(7,14,22,0.98)),radial-gradient(circle_at_35%_30%,rgba(212,160,23,0.2),transparent_34%)]" />
        <div
          aria-hidden
          className="absolute inset-0 opacity-20"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px)",
            backgroundSize: "28px 28px",
          }}
        />
        <div className="relative flex flex-col items-center gap-2 px-4 text-center">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-gold/40 bg-gold/15 text-gold">
            <MapPin className="h-4 w-4" />
          </span>
          <span className="text-xs font-medium text-foreground">
            Carte momentanément indisponible
          </span>
          <span className="text-[11px] text-muted-foreground">
            Coordonnées conservées : {lat.toFixed(4)}, {lng.toFixed(4)}
          </span>
        </div>
      </div>
    );
  }

  const url = osmTileUrl(lat, lng, zoom);
  const pos = osmTileMarkerPct(lat, lng, zoom);
  return (
    <div className={`relative overflow-hidden bg-muted ${className ?? ""}`}>
      <img
        src={url}
        alt={alt ?? "Carte"}
        loading="lazy"
        decoding="async"
        referrerPolicy="strict-origin-when-cross-origin"
        onError={() => setErrored(true)}
        className="h-full w-full object-cover"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-red-500 shadow-md"
        style={{ left: `${pos.left}%`, top: `${pos.top}%` }}
      />
    </div>
  );
}
