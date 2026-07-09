import type { AuctionSale } from "@/lib/types";
import {
  formatDate,
  formatPrice,
  formatSurface,
  occupancyLabel,
  propertyTypeLabel,
} from "./format";

function clean(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

export function getSaleAiDescription(sale: AuctionSale): string | null {
  return clean(sale.llm_display_description);
}

function getSaleFallbackDescription(sale: AuctionSale): string | null {
  return clean(sale.about_description) ?? clean(sale.source_description) ?? clean(sale.description);
}

export function getSaleDisplayDescription(sale: AuctionSale): string {
  return (
    getSaleAiDescription(sale) ??
    getSaleFallbackDescription(sale) ??
    buildStructuredDescription(sale)
  );
}

export function hasSaleAiDescription(sale: AuctionSale): boolean {
  return getSaleAiDescription(sale) !== null;
}

function buildStructuredDescription(sale: AuctionSale): string {
  const location = [sale.city, sale.department].filter(Boolean).join(", ");
  const court = sale.tribunal ?? sale.tribunal_name ?? sale.tribunal_city;
  const facts = [
    propertyTypeLabel(sale.property_type),
    saleSurfaceLabel(sale),
    sale.rooms_count ? `${sale.rooms_count} pièce${sale.rooms_count > 1 ? "s" : ""}` : null,
    occupancyLabel(sale.occupancy_status),
  ].filter((fact): fact is string => Boolean(fact && fact !== "Non renseigné"));

  return [
    `Ce bien${location ? ` situé à ${location}` : ""} est présenté en vente judiciaire avec une mise à prix de ${formatPrice(
      sale.starting_price_eur,
    )}.`,
    `L'audience est prévue le ${formatDate(sale.sale_date)}${court ? ` auprès de ${court}` : ""}.`,
    facts.length
      ? `Les informations disponibles indiquent : ${facts.join(", ")}.`
      : "Les caractéristiques détaillées restent à vérifier dans les pièces du dossier.",
  ].join(" ");
}

function saleSurfaceLabel(sale: AuctionSale): string | null {
  if (sale.app_surface_m2 != null) return `surface retenue ${formatSurface(sale.app_surface_m2)}`;
  if (sale.habitable_surface_m2 != null)
    return `surface habitable ${formatSurface(sale.habitable_surface_m2)}`;
  if (sale.carrez_surface_m2 != null)
    return `surface Carrez ${formatSurface(sale.carrez_surface_m2)}`;
  if (sale.land_surface_m2 != null) return `terrain ${formatSurface(sale.land_surface_m2)}`;
  return null;
}
