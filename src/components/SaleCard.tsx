import { Link } from "@tanstack/react-router";
import ArrowUpRight from "lucide-react/dist/esm/icons/arrow-up-right.js";
import Calendar from "lucide-react/dist/esm/icons/calendar.js";
import Eye from "lucide-react/dist/esm/icons/eye.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import type { AuctionSale } from "@/lib/types";
import {
  formatPrice,
  formatDate,
  formatSurface,
  occupancyLabel,
  propertyTypeLabel,
} from "@/lib/format";
import { pricePerM2 } from "@/lib/geo";
import { FeatureBadges } from "./FeatureBadges";
import { SaleCountdown, isNew } from "./SaleCountdown";
import { MapThumbnail } from "./MapThumbnail";
import { useViewedSales } from "@/hooks/use-viewed-sales";

export function SaleCard({ sale }: { sale: AuctionSale }) {
  const surface = sale.app_surface_m2 ?? sale.habitable_surface_m2 ?? sale.carrez_surface_m2;
  const riskCount = sale.risks?.length ?? 0;
  const fresh = isNew(sale.created_at);
  const ppm = pricePerM2(sale.starting_price_eur, surface);
  const { isViewed } = useViewedSales();
  const viewed = isViewed(sale.id);
  const occLabel = occupancyLabel(sale.occupancy_status);
  const occChip =
    occLabel === "Libre"
      ? "chip-opportunity"
      : occLabel === "Occupé" || occLabel === "Loué"
        ? "chip-watch"
        : "chip-neutral";
  return (
    <article
      className={`liquid-panel group flex min-h-[26rem] flex-col overflow-hidden rounded-lg transition duration-200 hover:-translate-y-0.5 hover:border-gold/35 ${
        viewed ? "opacity-75" : ""
      }`}
    >
      <div className="relative h-40 w-full overflow-hidden bg-[var(--surface)]">
        <MapThumbnail lat={sale.latitude} lng={sale.longitude} className="h-full w-full" />
        <div className="absolute inset-0 bg-gradient-to-t from-background/88 via-background/12 to-transparent" />
        <div className="absolute left-3 top-3 flex flex-wrap gap-2">
          {fresh && (
            <span className="inline-flex items-center rounded-full border border-gold/35 bg-gold/20 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-gold-soft backdrop-blur">
              Nouveau
            </span>
          )}
          <SaleCountdown date={sale.sale_date} />
        </div>
        {viewed && (
          <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full border border-white/10 bg-background/80 px-2.5 py-1 text-[10px] font-medium text-muted-foreground backdrop-blur">
            <Eye className="h-3 w-3" /> Vu
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-4 p-4">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-gold">
            <span className="h-px w-5 bg-gold" />
            {propertyTypeLabel(sale.property_type)}
          </div>
          <h3 className="line-clamp-2 min-h-[2.75rem] text-base font-semibold leading-snug text-foreground">
            {sale.title ?? propertyTypeLabel(sale.property_type)}
          </h3>
          <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <MapPin className="h-3.5 w-3.5 text-gold" />
            <span className="truncate">
              {sale.city ?? "—"}
              {sale.department ? ` (${sale.department})` : ""}
            </span>
          </div>
        </div>

        <div className="flex items-end justify-between gap-4 border-t border-white/10 pt-4">
          <div>
            <div className="font-display text-3xl tabular-nums text-foreground">
              {formatPrice(sale.starting_price_eur)}
            </div>
            {ppm != null && (
              <div className="mt-0.5 text-xs font-medium tabular-nums text-muted-foreground">
                {Math.round(ppm).toLocaleString("fr-FR")} €/m²
              </div>
            )}
            <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
              <Calendar className="h-3 w-3" />
              <span>{formatDate(sale.sale_date)}</span>
            </div>
          </div>
          <div className="grid min-w-24 gap-2 text-right text-xs text-muted-foreground">
            <CardMetric label="Surface" value={surface ? formatSurface(surface) : "—"} />
            <CardMetric
              label="Pièces"
              value={sale.rooms_count != null ? String(sale.rooms_count) : "—"}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className={`chip ${occChip}`}>
            <span aria-hidden className="chip-dot" />
            {occLabel}
          </span>
          {riskCount > 0 ? (
            <span className={`chip ${riskCount >= 3 ? "chip-risk" : "chip-watch"}`}>
              <span aria-hidden className="chip-dot" />
              {riskCount} point{riskCount > 1 ? "s" : ""} à vérifier
            </span>
          ) : (
            <span className="chip chip-verified">
              <span aria-hidden className="chip-dot" />
              Aucun point bloquant détecté
            </span>
          )}
          <FeatureBadges sale={sale} max={2} />
        </div>

        <Link
          to="/sales/$id"
          params={{ id: sale.id }}
          className="liquid-button mt-auto inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-bold uppercase tracking-[0.16em] text-background transition hover:brightness-105"
        >
          Voir le détail <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </article>
  );
}

function CardMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 font-medium tabular-nums text-foreground">{value}</div>
    </div>
  );
}
