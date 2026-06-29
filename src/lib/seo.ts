import { propertyTypeLabel } from "@/lib/format";
import type { AuctionSale } from "@/lib/types";

export function saleSeoTitle(sale: AuctionSale | null | undefined): string {
  if (!sale) return "Vente judiciaire immobilière — Immojudis";

  const property = propertyTypeLabel(sale.property_type);
  const rooms = sale.rooms_count && sale.rooms_count > 0 ? ` T${sale.rooms_count}` : "";
  const city = sale.city ? ` ${sale.city}` : "";
  const tribunal = sale.tribunal ?? sale.tribunal_name ?? sale.tribunal_city;
  const price =
    sale.starting_price_eur != null ? ` — mise à prix ${seoPrice(sale.starting_price_eur)}` : "";

  return `${property}${rooms}${city} — vente judiciaire${tribunal ? ` ${tribunal}` : ""}${price}`;
}

function seoPrice(value: number): string {
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 })
    .format(value)
    .replaceAll("\u202f", " ")
    .replaceAll("\u00a0", " ")} €`;
}
