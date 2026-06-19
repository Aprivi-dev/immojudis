import { useEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";
import ArrowUpRight from "lucide-react/dist/esm/icons/arrow-up-right.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import X from "lucide-react/dist/esm/icons/x.js";
import type { AuctionMapPin } from "@/lib/types";
import { formatPrice, formatPricePerM2, occupancyLabel, propertyTypeLabel } from "@/lib/format";
import { pricePerM2 } from "@/lib/geo";
import { getDisplaySurface, getSaleSurface } from "@/lib/surface";
import { SaleCountdown } from "@/components/SaleCountdown";

function occupancyChipClass(label: string): string {
  if (label === "Libre") return "chip-opportunity";
  if (label === "Occupé" || label === "Loué") return "chip-watch";
  return "chip-neutral";
}

export function MapSaleCard({
  sale,
  selected = false,
  hovered = false,
  onSelect,
  onHover,
  onClose,
  floating = false,
}: {
  sale: AuctionMapPin;
  selected?: boolean;
  hovered?: boolean;
  onSelect?: (id: string | null) => void;
  onHover?: (id: string | null) => void;
  onClose?: () => void;
  floating?: boolean;
}) {
  const surfaceInfo = getSaleSurface(sale);
  const displaySurface = getDisplaySurface(sale);
  const surface = surfaceInfo.value;
  const ppm = pricePerM2(sale.starting_price_eur, surface);
  const occ = occupancyLabel(sale.occupancy_status);

  return (
    <article
      data-sale-id={sale.id}
      onMouseEnter={onHover ? () => onHover(sale.id) : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
      onClick={onSelect ? () => onSelect(sale.id) : undefined}
      className={`group relative cursor-pointer rounded-lg border p-3.5 transition ${
        floating ? "liquid-panel shadow-[0_18px_44px_rgb(0_0_0/_45%)]" : "liquid-panel-soft"
      } ${
        selected
          ? "border-gold/70 bg-gold/[0.07] ring-1 ring-gold/40"
          : hovered
            ? "border-gold/30 bg-white/[0.04]"
            : "border-white/10 hover:border-gold/25"
      }`}
    >
      {onClose && (
        <button
          type="button"
          aria-label="Fermer"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      )}

      <div className="flex items-center justify-between gap-2 pr-6">
        <span className="truncate text-[10px] font-semibold uppercase tracking-[0.16em] text-gold">
          {propertyTypeLabel(sale.property_type)}
        </span>
        <SaleCountdown date={sale.sale_date} />
      </div>

      <h3 className="mt-1.5 line-clamp-1 text-sm font-semibold leading-snug text-foreground">
        {sale.title ?? propertyTypeLabel(sale.property_type)}
      </h3>

      <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <MapPin className="h-3.5 w-3.5 shrink-0 text-gold" />
        <span className="truncate">
          {sale.city ?? "—"}
          {sale.department ? ` (${sale.department})` : ""}
        </span>
      </div>

      <div className="mt-2.5 flex items-end justify-between gap-3 border-t border-white/10 pt-2.5">
        <div>
          <div className="font-display text-xl tabular-nums leading-none text-foreground">
            {formatPrice(sale.starting_price_eur)}
          </div>
          {ppm != null && (
            <div className="mt-1 text-[11px] tabular-nums text-muted-foreground">
              {formatPricePerM2(Math.round(ppm))}
              {surfaceInfo.estimated ? " · est." : ""}
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {displaySurface.value
              ? `${displaySurface.metricLabel} ${displaySurface.label}`
              : "Surface —"}
          </span>
          <span className={`chip ${occupancyChipClass(occ)} text-[10px]`}>
            <span aria-hidden className="chip-dot" />
            {occ}
          </span>
        </div>
      </div>

      <Link
        to="/sales/$id"
        params={{ id: sale.id }}
        onClick={(e) => e.stopPropagation()}
        className="mt-3 inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-gold-soft transition-colors hover:text-gold"
      >
        Voir le détail <ArrowUpRight className="h-3.5 w-3.5" />
      </Link>
    </article>
  );
}

export function MapResultsRail({
  sales,
  isLoading = false,
  selectedId,
  hoveredId,
  onSelect,
  onHover,
}: {
  sales: AuctionMapPin[];
  isLoading?: boolean;
  selectedId: string | null;
  hoveredId: string | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll de la carte sélectionnée dans le rail (sélection venant de la carte).
  useEffect(() => {
    if (!selectedId || !scrollRef.current) return;
    const el = scrollRef.current.querySelector<HTMLElement>(`[data-sale-id="${selectedId}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedId]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gold-soft">
          {isLoading ? "Chargement…" : `${sales.length} annonce${sales.length > 1 ? "s" : ""}`}
        </div>
        <div className="text-[11px] text-muted-foreground">Survolez pour situer</div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
        {isLoading && sales.length === 0 ? (
          <RailSkeleton />
        ) : sales.length === 0 ? (
          <div className="mt-10 px-4 text-center text-sm leading-relaxed text-muted-foreground">
            Aucune annonce géolocalisée pour ces critères. Élargissez la zone ou assouplissez les
            filtres.
          </div>
        ) : (
          sales.map((sale) => (
            <MapSaleCard
              key={sale.id}
              sale={sale}
              selected={sale.id === selectedId}
              hovered={sale.id === hoveredId}
              onSelect={onSelect}
              onHover={onHover}
            />
          ))
        )}
      </div>
    </div>
  );
}

function RailSkeleton() {
  return (
    <div className="space-y-2.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="liquid-panel-soft h-28 animate-pulse rounded-lg border border-white/10"
        />
      ))}
    </div>
  );
}
