import { useState } from "react";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import {
  MAPBOX_ATTRIBUTION,
  MAPBOX_COPYRIGHT_URL,
  mapboxSatelliteImageUrl,
  mapboxStaticImageUrl,
} from "@/lib/mapbox";

type Props = {
  lat: number | null | undefined;
  lng: number | null | undefined;
  zoom?: number;
  className?: string;
  alt?: string;
  variant?: "streets" | "satellite";
};

export function MapThumbnail({ lat, lng, zoom = 15, className, alt, variant = "streets" }: Props) {
  const mapboxUrl =
    lat != null && lng != null
      ? variant === "satellite"
        ? mapboxSatelliteImageUrl({ lat, lng, zoom, width: 720, height: 420 })
        : mapboxStaticImageUrl({ lat, lng, zoom, width: 720, height: 420 })
      : "";
  const [failedUrl, setFailedUrl] = useState("");

  if (lat == null || lng == null) {
    return (
      <div
        className={`flex items-center justify-center bg-muted text-xs text-muted-foreground ${className ?? ""}`}
      >
        Pas de localisation
      </div>
    );
  }

  if (!mapboxUrl || failedUrl === mapboxUrl) {
    return (
      <div
        className={`relative flex items-center justify-center overflow-hidden bg-[var(--surface)] ${className ?? ""}`}
      >
        <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(21,19,17,0.96),rgba(8,8,10,0.98)),radial-gradient(circle_at_35%_30%,rgba(242,196,135,0.2),transparent_34%)]" />
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
          <span className="text-xs font-medium text-foreground">Aperçu Mapbox indisponible</span>
          <span className="text-[11px] text-muted-foreground">
            Coordonnées conservées : {lat.toFixed(4)}, {lng.toFixed(4)}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={`relative overflow-hidden bg-muted ${className ?? ""}`}>
      <img
        src={mapboxUrl}
        alt={alt ?? (variant === "satellite" ? "Vue aérienne" : "Carte")}
        loading="lazy"
        decoding="async"
        referrerPolicy="strict-origin-when-cross-origin"
        onError={() => setFailedUrl(mapboxUrl)}
        className="h-full w-full object-cover"
      />
      <a
        href={MAPBOX_COPYRIGHT_URL}
        target="_blank"
        rel="noreferrer"
        className="absolute bottom-1 right-1 rounded bg-white/85 px-1.5 py-0.5 text-[9px] font-semibold text-[#1f2937] shadow-sm"
      >
        {MAPBOX_ATTRIBUTION}
      </a>
    </div>
  );
}
