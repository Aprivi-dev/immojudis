import { propertyTypeLabel } from "@/lib/format";
import { getSaleProcedure } from "@/lib/sale-procedure";
import type { AuctionSale } from "@/lib/types";

export function saleSeoTitle(sale: AuctionSale | null | undefined): string {
  if (!sale) return "Vente aux enchères immobilière — Immojudis";

  const procedure = getSaleProcedure(sale);
  const property = propertyTypeLabel(sale.property_type);
  const rooms = sale.rooms_count && sale.rooms_count > 0 ? ` T${sale.rooms_count}` : "";
  const city = sale.city ? ` ${sale.city}` : "";
  const tribunal =
    procedure.venueType === "tribunal"
      ? (sale.tribunal ?? sale.tribunal_name ?? sale.tribunal_city)
      : null;
  const price =
    sale.starting_price_eur != null ? ` — mise à prix ${seoPrice(sale.starting_price_eur)}` : "";

  return `${property}${rooms}${city} — ${saleTypeSeoLabel(procedure.venueType)}${
    tribunal ? ` ${tribunal}` : ""
  }${price}`;
}

function saleTypeSeoLabel(venueType: ReturnType<typeof getSaleProcedure>["venueType"]): string {
  return {
    tribunal: "vente judiciaire au tribunal",
    notary: "vente notariale",
    state: "vente domaniale",
    online: "vente aux enchères en ligne",
    unknown: "vente aux enchères immobilière",
  }[venueType];
}

function seoPrice(value: number): string {
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 })
    .format(value)
    .replaceAll("\u202f", " ")
    .replaceAll("\u00a0", " ")} €`;
}
