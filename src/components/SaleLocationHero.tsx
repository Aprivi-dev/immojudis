import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import type { ReactNode } from "react";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import Navigation from "lucide-react/dist/esm/icons/navigation.js";
import type { AuctionSale } from "@/lib/types";
import { propertyTypeLabel } from "@/lib/format";
import { openStreetMapQueryUrl, openStreetMapUrl } from "@/lib/tiles";
import { MapThumbnail } from "@/components/MapThumbnail";

function saleAddress(sale: AuctionSale): string {
  return [sale.address, sale.postal_code, sale.city].filter(Boolean).join(", ");
}

export function SaleLocationHero({ sale }: { sale: AuctionSale }) {
  const lat = sale.latitude;
  const lng = sale.longitude;
  const address = saleAddress(sale);
  const title = sale.title ?? propertyTypeLabel(sale.property_type);
  const hasLocation = lat != null && lng != null;
  const mapUrl = hasLocation
    ? openStreetMapUrl(lat, lng, 17)
    : openStreetMapQueryUrl(address || sale.city || sale.department || "France");

  if (!hasLocation) {
    return (
      <div className="liquid-panel flex min-h-[220px] flex-col items-center justify-center rounded-lg p-8 text-center">
        <MapPin className="h-6 w-6 text-gold" />
        <p className="mt-3 text-sm font-medium text-foreground">Localisation non cartographiée</p>
        <p className="mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
          Les coordonnées précises ne sont pas encore disponibles pour ce bien.
        </p>
        <a
          href={mapUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gold-soft hover:text-gold"
        >
          Rechercher sur OpenStreetMap <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    );
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[1.7fr_1fr]">
      <div className="liquid-media relative min-h-[300px] overflow-hidden rounded-lg lg:min-h-[440px]">
        <MapThumbnail lat={lat} lng={lng} zoom={16} alt={`Carte de ${title}`} className="h-full" />
        <TileBadge>Carte OpenStreetMap</TileBadge>
      </div>

      <div className="liquid-panel flex min-h-[260px] flex-col justify-between rounded-lg p-6 lg:min-h-[440px]">
        <div>
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-gold/30 bg-gold/10 text-gold-soft">
            <Navigation className="h-5 w-5" />
          </span>
          <h2 className="mt-4 font-display text-2xl text-foreground">Localisation</h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            {address || "Adresse à confirmer dans les pièces du dossier."}
          </p>
          <dl className="mt-5 grid gap-3 text-sm">
            <div className="rounded-md border border-white/10 bg-white/5 p-3">
              <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gold-soft">
                Latitude
              </dt>
              <dd className="mt-1 font-medium text-foreground">{lat.toFixed(5)}</dd>
            </div>
            <div className="rounded-md border border-white/10 bg-white/5 p-3">
              <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gold-soft">
                Longitude
              </dt>
              <dd className="mt-1 font-medium text-foreground">{lng.toFixed(5)}</dd>
            </div>
          </dl>
        </div>
        <a
          href={mapUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-6 inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-gold/30 bg-gold/10 px-4 text-sm font-semibold text-gold-soft transition-colors hover:border-gold/60 hover:bg-gold/15 hover:text-gold"
        >
          Ouvrir dans OpenStreetMap <ExternalLink className="h-4 w-4" />
        </a>
      </div>
    </div>
  );
}

function TileBadge({ children }: { children: ReactNode }) {
  return (
    <span className="absolute left-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-background/70 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-gold-soft backdrop-blur">
      {children}
    </span>
  );
}
