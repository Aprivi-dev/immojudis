import { Link } from "@tanstack/react-router";
import { MapPin, Calendar } from "lucide-react";
import type { AuctionSale } from "@/lib/types";
import { formatPrice, formatDate, formatSurface, occupancyLabel, propertyTypeLabel } from "@/lib/format";
import { ScoreBadge } from "./ScoreBadge";
import { FeatureBadges } from "./FeatureBadges";

export function SaleCard({ sale }: { sale: AuctionSale }) {
  const surface = sale.app_surface_m2 ?? sale.habitable_surface_m2 ?? sale.carrez_surface_m2;
  const riskCount = sale.risks?.length ?? 0;
  return (
    <article className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-sm transition hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
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
        <ScoreBadge score={sale.investment_score} />
      </div>

      <div className="flex items-end justify-between">
        <div>
          <div className="text-2xl font-bold tabular-nums text-foreground">
            {formatPrice(sale.starting_price_eur)}
          </div>
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
        <span className="inline-flex items-center rounded-md bg-secondary px-2 py-0.5 text-[10px] font-medium text-secondary-foreground">
          {occupancyLabel(sale.occupancy_status)}
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
    </article>
  );
}