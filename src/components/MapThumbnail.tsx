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
  if (lat == null || lng == null) {
    return (
      <div
        className={`flex items-center justify-center bg-muted text-xs text-muted-foreground ${className ?? ""}`}
      >
        Pas de localisation
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
        referrerPolicy="no-referrer"
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