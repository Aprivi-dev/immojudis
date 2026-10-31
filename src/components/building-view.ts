import type { AuctionSale } from "@/lib/types";

/** Vrai si la précision laisse espérer un bâtiment : sinon inutile de charger la vérification complète. */
export function precisionMayBeBuilding(precision: AuctionSale["location_precision"]): boolean {
  const value = typeof precision === "string" ? precision.trim().toLowerCase() : "";
  return value === "address" || value === "parcel";
}

/**
 * Une vue aérienne du bâtiment est possible pour cette vente (position d'adresse ou de parcelle) :
 * la vérification complète, chargée à la demande par `SaleVisual`, dira si elle est fiable. Faux :
 * sans photo, la vignette sera forcément l'illustration du type de bien, et la carte peut lui
 * réserver une hauteur réduite sans que rien ne bouge ensuite (voir `listingMediaFrameClass`).
 * Fichier à part : il ne charge ni Mapbox ni le visuel, et la liste des ventes le lit sans eux.
 */
export function mayShowBuildingView(
  sale: Partial<Pick<AuctionSale, "latitude" | "longitude" | "location_precision">>,
): boolean {
  return (
    sale.latitude != null &&
    sale.longitude != null &&
    precisionMayBeBuilding(sale.location_precision)
  );
}
