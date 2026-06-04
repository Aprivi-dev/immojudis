import { Link } from "@tanstack/react-router";
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
import { ScoreBadge } from "./ScoreBadge";
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
  const occTone =
    occLabel === "Libre"
      ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200"
      : occLabel === "Occupé" || occLabel === "Loué"
        ? "bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200"
        : "bg-secondary text-secondary-foreground";
  return (
    <article
      className={`flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm transition hover:shadow-md ${
        viewed ? "opacity-70" : ""
      }`}
    >
      <div className="relative h-32 w-full bg-muted">
        <MapThumbnail lat={sale.latitude} lng={sale.longitude} className="h-full w-full" />
        {viewed && (
          <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-background/90 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground backdrop-blur">
            <Eye className="h-3 w-3" /> Vu
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-1.5">
              {fresh && (
                <span className="inline-flex items-center rounded-md bg-primary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-foreground">
                  Nouveau
                </span>
              )}
              <SaleCountdown date={sale.sale_date} />
            </div>
            <h3 className="line-clamp-2 text-base font-semibold leading-snug text-foreground">
              {sale.title ?? propertyTypeLabel(sale.property_type)}
            </h3>
            <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              <MapPin className="h-3 w-3" />
              <span className="truncate">
                {sale.city ?? "—"}
                {sale.department ? ` (${sale.department})` : ""}
              </span>
            </div>
          </div>
          <ScoreBadge score={sale.investment_score} confidence={sale.score_confidence} />
        </div>

        <div className="flex items-end justify-between">
          <div>
            <div className="text-2xl font-bold tabular-nums text-foreground">
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
          <div className="text-right text-xs text-muted-foreground">
            <div>{propertyTypeLabel(sale.property_type)}</div>
            {surface && <div className="font-medium text-foreground">{formatSurface(surface)}</div>}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium ${occTone}`}
          >
            Occupation : {occLabel}
          </span>
          <FeatureBadges sale={sale} max={4} />
          {riskCount > 0 && (
            <span className="inline-flex items-center rounded-md bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
              {riskCount} risque{riskCount > 1 ? "s" : ""}
            </span>
          )}
        </div>

        <Link
          to="/sales/$id"
          params={{ id: sale.id }}
          className="mt-auto inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
        >
          Voir le détail
        </Link>
      </div>
    </article>
  );
}
