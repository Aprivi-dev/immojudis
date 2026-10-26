import { dpeColor, extractDpe } from "@/lib/dpe";
import { formatPrice } from "@/lib/format";
import { saleDisplayTitle } from "@/lib/sale-title";
import { hasCoordinates } from "@/lib/search/search-filters";
import type { AuctionSale } from "@/lib/types";

export type MapboxSaleFeatureProperties = {
  saleId: string;
  title: string;
  priceLabel: string;
  markerColor: string;
  markerTextColor: string;
  dpeClass: string;
  city: string;
  tribunal: string;
  saleDate: string;
  priceValue: number;
  /** 1 : pépite publiable (anneau et glyphe sur la carte) ; 0 sinon. Numérique : `clusterProperties` l'additionne. */
  pepite: 0 | 1;
};

export type MapboxSaleFeature = {
  type: "Feature";
  geometry: {
    type: "Point";
    coordinates: [number, number];
  };
  properties: MapboxSaleFeatureProperties;
};

export type MapboxSaleFeatureCollection = {
  type: "FeatureCollection";
  features: MapboxSaleFeature[];
};

/**
 * `AuctionSale.pepite` marque les pépites (liste publique, lue une fois par page de résultats). Jamais un
 * montant : la carte ne reçoit que ce drapeau.
 */
export function buildMapboxSaleFeatureCollection(
  sales: AuctionSale[],
): MapboxSaleFeatureCollection {
  return {
    type: "FeatureCollection",
    features: sales.filter(hasCoordinates).map((sale) => {
      const dpe = extractDpe(sale);
      const theme = dpeColor(dpe.class);

      return {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [sale.longitude, sale.latitude],
        },
        properties: {
          saleId: sale.id,
          title: saleDisplayTitle(sale),
          priceLabel: formatMapboxMarkerPrice(sale.starting_price_eur),
          markerColor: theme?.background ?? "#0f766e",
          markerTextColor: theme?.foreground ?? "#ffffff",
          dpeClass: dpe.class ?? "",
          city: sale.city ?? "",
          tribunal: sale.tribunal_city ?? sale.tribunal_name ?? "",
          saleDate: sale.sale_date ?? "",
          priceValue: sale.starting_price_eur ?? 0,
          pepite: sale.pepite === true ? 1 : 0,
        },
      };
    }),
  };
}

export function formatMapboxMarkerPrice(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value <= 0) return "Prix";
  if (Math.abs(value) >= 1_000_000) {
    return `${new Intl.NumberFormat("fr-FR", {
      maximumFractionDigits: Math.abs(value) >= 10_000_000 ? 0 : 1,
    }).format(value / 1_000_000)}M€`;
  }
  if (Math.abs(value) >= 1_000) return `${Math.round(value / 1_000).toLocaleString("fr-FR")}K€`;
  return formatPrice(value);
}
