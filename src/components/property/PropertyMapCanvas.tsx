import { useState } from "react";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import Minus from "lucide-react/dist/esm/icons/minus.js";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import type { Property } from "@/lib/property-types";
import { openStreetMapUrl } from "@/lib/tiles";
import { MapThumbnail } from "@/components/MapThumbnail";

const INITIAL_MAP_ZOOM = 15;

export function PropertyMapCanvas({ property }: { property: Property }) {
  const location = property.location;
  const [zoom, setZoom] = useState(INITIAL_MAP_ZOOM);

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

  const openUrl = openStreetMapUrl(location.lat, location.lng, zoom);

  return (
    <div className="relative min-h-[22rem] overflow-hidden rounded-md border border-border bg-muted">
      <MapThumbnail
        lat={location.lat}
        lng={location.lng}
        zoom={zoom}
        alt={`Carte de ${property.address}`}
        className="h-[22rem] w-full"
      />
      <div className="absolute right-3 top-3 grid gap-2">
        <button
          type="button"
          onClick={() => setZoom((value) => Math.min(value + 1, 18))}
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
