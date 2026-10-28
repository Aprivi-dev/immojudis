import type { AuctionSale } from "@/lib/types";
import { reliableBuildingPosition, type BuildingPositionSale } from "@/lib/building-position";

export { hasNumberedStreetAddress, hasReliableBuildingPosition } from "@/lib/building-position";

/**
 * Rayon d'incertitude, en mètres, selon la précision : un point d'adresse (numéro interpolé le long
 * de la voie) peut être décalé de quelques dizaines de mètres, le centre d'une parcelle cadastrale
 * désigne le terrain à une quinzaine de mètres près.
 */
const ACCURACY_METERS: Record<string, number> = { address: 30, parcel: 15 };

/** Types de bien pour lesquels « le bâtiment » n'a pas de sens : un emplacement ou un terrain nu. */
const NO_BUILDING_PROPERTY_TYPES = new Set(["parking", "land"]);

export type AerialOrbitTarget = {
  lat: number;
  lng: number;
  address: string;
  /** Rayon, en mètres, du cercle d'incertitude autour du repère. */
  accuracyMeters: number;
};

type OrbitSale = BuildingPositionSale &
  Pick<AuctionSale, "postal_code" | "city"> &
  Partial<Pick<AuctionSale, "property_type">>;

/**
 * Point autour duquel la fiche peut faire tourner la vue aérienne, ou null si la position n'est pas
 * assez sûre : position fiable d'un bâtiment (voir `hasReliableBuildingPosition`), bien qui n'est
 * ni un parking ni un terrain.
 */
export function aerialOrbitTarget(sale: OrbitSale): AerialOrbitTarget | null {
  const position = reliableBuildingPosition(sale);
  if (!position) return null;
  const propertyType = typeof sale.property_type === "string" ? sale.property_type.trim() : "";
  if (NO_BUILDING_PROPERTY_TYPES.has(propertyType.toLowerCase())) return null;
  // L'adresse des sources contient souvent déjà le code postal et la commune.
  const lower = position.street.toLowerCase();
  const extras = [sale.postal_code, sale.city]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part && !lower.includes(part.toLowerCase()));
  const address = [position.street, ...extras].join(", ");
  return {
    lat: position.lat,
    lng: position.lng,
    address,
    accuracyMeters: ACCURACY_METERS[position.precision],
  };
}

/**
 * La carte animée (un chargement facturé et environ 2,6 Mo) attend un geste sur mobile (largeur
 * inférieure à 768 px), avec l'économiseur de données et sur un réseau 2G ou 3G.
 */
export function mapLoadNeedsGesture(): boolean {
  const connection = (
    navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }
  ).connection;
  return (
    (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 767px)").matches) ||
    connection?.saveData === true ||
    /^(?:slow-)?[23]g$/.test(connection?.effectiveType ?? "")
  );
}
