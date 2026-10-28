import { extractDpe } from "@/lib/dpe";
import { isInFrance } from "@/lib/france-bounds";
import { formatPrice } from "@/lib/format";
import { saleDisplayTitle } from "@/lib/sale-title";
import { hasCoordinates } from "@/lib/search/search-filters";
import type { AuctionSale } from "@/lib/types";

export type MapboxSaleFeatureProperties = {
  saleId: string;
  title: string;
  priceLabel: string;
  dpeClass: string;
  city: string;
  tribunal: string;
  saleDate: string;
  priceValue: number;
  /** 1 : pépite publiable (anneau et glyphe sur la carte) ; 0 sinon. Numérique : `clusterProperties` l'additionne. */
  pepite: 0 | 1;
  /** 1 : centre de commune ou point douteux, dessiné en pointillé (voir `isApproximatePosition`) ; 0 sinon. */
  approx: 0 | 1;
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

/** Signalement du pipeline : la source place la vente à plus de 12 km du centre de sa commune. */
const UNVERIFIED_SOURCE_COORDINATES_FLAG = "unverified_source_coordinates";

/**
 * Vrai si le point n'est pas une adresse : centre de la commune (précision `municipality`) ou
 * coordonnées de la source non vérifiées. La carte le dessine en pointillé plutôt que comme une
 * adresse. Une précision de rue, de parcelle, d'adresse ou inconnue ne le rend pas approximatif.
 */
export function isApproximatePosition(
  sale: Pick<AuctionSale, "quality_flags"> & Partial<Pick<AuctionSale, "location_precision">>,
): boolean {
  if (isMunicipalityCenter(sale)) return true;
  return (
    Array.isArray(sale.quality_flags) &&
    sale.quality_flags.includes(UNVERIFIED_SOURCE_COORDINATES_FLAG)
  );
}

/** Vrai si le point est celui du centre de la commune (texte de la fenêtre de la carte). */
export function isMunicipalityCenter(sale: Partial<Pick<AuctionSale, "location_precision">>) {
  return (
    typeof sale.location_precision === "string" &&
    sale.location_precision.trim().toLowerCase() === "municipality"
  );
}

/**
 * `AuctionSale.pepite` marque les pépites (liste publique, lue une fois par page de résultats). Jamais un
 * montant : la carte ne reçoit que ce drapeau.
 */
export function buildMapboxSaleFeatureCollection(
  sales: AuctionSale[],
): MapboxSaleFeatureCollection {
  return {
    type: "FeatureCollection",
    // Comme la fiche (`listingCoordinates`) : un point (0, 0), inversé ou hors de France n'est pas tracé.
    features: sales.filter(hasMapPosition).map((sale) => {
      const dpe = extractDpe(sale);

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
          dpeClass: dpe.class ?? "",
          city: sale.city ?? "",
          tribunal: sale.tribunal_city ?? sale.tribunal_name ?? "",
          saleDate: sale.sale_date ?? "",
          priceValue: sale.starting_price_eur ?? 0,
          pepite: sale.pepite === true ? 1 : 0,
          approx: isApproximatePosition(sale) ? 1 : 0,
        },
      };
    }),
  };
}

function hasMapPosition(
  sale: AuctionSale,
): sale is AuctionSale & { latitude: number; longitude: number } {
  return hasCoordinates(sale) && isInFrance(sale.latitude, sale.longitude);
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
