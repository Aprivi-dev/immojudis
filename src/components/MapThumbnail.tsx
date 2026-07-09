import { useEffect, useState } from "react";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import { MAPBOX_ATTRIBUTION, MAPBOX_COPYRIGHT_URL, mapboxStaticImageUrl } from "@/lib/mapbox";
import { OSM_ATTRIBUTION, OSM_COPYRIGHT_URL, osmTileMarkerPct, osmTileUrl } from "@/lib/tiles";

type Props = {
  lat: number | null | undefined;
  lng: number | null | undefined;
  zoom?: number;
  className?: string;
  alt?: string;
};

export function MapThumbnail({ lat, lng, zoom = 15, className, alt }: Props) {
  const mapboxUrl =
    lat != null && lng != null
      ? mapboxStaticImageUrl({ lat, lng, zoom, width: 720, height: 420 })
      : "";
  const osmUrl = lat != null && lng != null ? osmTileUrl(lat, lng, zoom) : "";
  const [provider, setProvider] = useState<"mapbox" | "osm" | "fallback">(
    mapboxUrl ? "mapbox" : "osm",
  );

  useEffect(() => {
    setProvider(mapboxUrl ? "mapbox" : "osm");
  }, [mapboxUrl, osmUrl]);

  if (lat == null || lng == null) {
    return (
      <div
        className={`flex items-center justify-center bg-muted text-xs text-muted-foreground ${className ?? ""}`}
      >
        Pas de localisation
      </div>
    );
  }

  if (provider === "fallback") {
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

  const usingMapbox = provider === "mapbox" && Boolean(mapboxUrl);
  const src = usingMapbox ? mapboxUrl : osmUrl;
  const pos = osmTileMarkerPct(lat, lng, zoom);
  const attributionHref = usingMapbox ? MAPBOX_COPYRIGHT_URL : OSM_COPYRIGHT_URL;
  const attributionLabel = usingMapbox ? MAPBOX_ATTRIBUTION : OSM_ATTRIBUTION;

  return (
    <div className={`relative overflow-hidden bg-muted ${className ?? ""}`}>
      <img
        src={src}
        alt={alt ?? "Carte"}
        loading="lazy"
        decoding="async"
        referrerPolicy="strict-origin-when-cross-origin"
        onError={() =>
          setProvider((current) => (current === "mapbox" && osmUrl ? "osm" : "fallback"))
        }
        className="h-full w-full object-cover"
      />
      {!usingMapbox ? (
        <span
          aria-hidden
          className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-red-500 shadow-md"
          style={{ left: `${pos.left}%`, top: `${pos.top}%` }}
        />
      ) : null}
      <a
        href={attributionHref}
        target="_blank"
        rel="noreferrer"
        className="absolute bottom-1 right-1 rounded bg-white/85 px-1.5 py-0.5 text-[9px] font-semibold text-[#1f2937] shadow-sm"
      >
        {attributionLabel}
      </a>
    </div>
  );
}
