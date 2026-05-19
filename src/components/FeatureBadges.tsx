import type { AuctionSale } from "@/lib/types";

const FEATURES: Array<[keyof AuctionSale, string]> = [
  ["has_garden", "Jardin"],
  ["has_terrace", "Terrasse"],
  ["has_garage", "Garage"],
  ["has_pool", "Piscine"],
  ["has_air_conditioning", "Clim"],
  ["has_double_glazing", "Double vitrage"],
];

export function FeatureBadges({ sale, max }: { sale: AuctionSale; max?: number }) {
  const items = FEATURES.filter(([k]) => sale[k] === true).map(([, label]) => label);
  const shown = max ? items.slice(0, max) : items;
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((l) => (
        <span key={l} className="inline-flex items-center rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {l}
        </span>
      ))}
      {max && items.length > max && (
        <span className="text-[10px] text-muted-foreground">+{items.length - max}</span>
      )}
    </div>
  );
}