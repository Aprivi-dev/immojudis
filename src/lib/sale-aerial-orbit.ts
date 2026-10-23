import type { AuctionSale } from "@/lib/types";
import { listingCoordinates } from "@/lib/sale-listing";
import { STREET_TYPE_END, streetTypePattern } from "@/lib/street-types";

/**
 * Signalements du pipeline qui rendent le point de la vente douteux : une vue qui tourne autour
 * d'un repère affirme « c'est ce bâtiment-là », on ne l'affiche donc pas sur un point incertain.
 * `probable_duplicate` : la vente est probablement la copie d'une autre ligne du catalogue, et deux
 * copies peuvent porter des points différents.
 */
const DOUBTFUL_LOCATION_FLAGS = new Set([
  "implausible_coordinates",
  "unverified_source_coordinates",
  "geocode_outside_department",
  "missing_address",
  "probable_duplicate",
]);

/** Mots qui, juste avant un nombre, en font un numéro de lot, de local ou de parcelle, pas de rue. */
const NOT_A_STREET_NUMBER_BEFORE =
  "lots?|parcelles?|sections?|appartements?|appart|apt|app|b[âa]timents?|b[âa]t|[ée]tages?|escalier|esc|box|garage|cave|local|n[°o]|num[ée]ro";
/** « Grande Rue », « Petite Route », « Grand'Rue » : l'adjectif précède le type de voie. */
const STREET_ADJECTIVE =
  "(?:(?:grande?|petite?|vieille|vieux|nouvelle|nouveau|haute?|bas(?:se)?|ancienne?)\\s+|grand['’]\\s*)";
/** « 12 place de parking » est un emplacement de stationnement, pas une rue. */
const PARKING_AFTER_TYPE =
  "(?!\\s+(?:de\\s+|du\\s+|des\\s+)?(?:parkings?|stationnements?|garages?|caves?)\\b)";

/**
 * Un numéro (ou une plage « 12-14 ») suivi d'un type de voie (« 12 rue… », « 3 bis, avenue… »).
 * Sans numéro, le géocodage tombe au mieux sur la rue, souvent au centre de la commune : le repère
 * serait trompeur. Un nombre précédé de « lot », « appartement »… n'est pas un numéro de rue.
 */
const STREET_NUMBER_ADDRESS = new RegExp(
  `(?:^|[\\s,;(])(?<!\\b(?:${NOT_A_STREET_NUMBER_BEFORE})\\.?\\s*(?:n[°o]\\s*)?)` +
    "\\d{1,4}(?:\\s*[-–]\\s*\\d{1,4})?\\s*(?:bis|ter|quater|[a-d])?\\s*,?\\s+" +
    `${STREET_ADJECTIVE}?(?:${streetTypePattern()})${STREET_TYPE_END}${PARKING_AFTER_TYPE}`,
  "i",
);

/** Vrai si l'adresse commence une rue par un numéro (« 12 rue Foch », « 12-14 allées de… »). */
export function hasNumberedStreetAddress(address: string): boolean {
  return STREET_NUMBER_ADDRESS.test(address);
}

/**
 * Précisions de géocodage (`location_precision`, issue de `raw_payload.geo_precision` côté pipeline)
 * qui désignent un bâtiment ou une parcelle. Une précision de rue, de commune ou absente ne l'est
 * pas : la vue qui tourne autour d'un repère ne serait pas honnête.
 */
const BUILDING_LOCATION_PRECISIONS = new Set(["address", "parcel"]);

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

/**
 * Point autour duquel la fiche peut faire tourner la vue aérienne, ou null si la position n'est pas
 * assez sûre : précision `address` ou `parcel` exigée (absente = pas de vue), adresse numérotée,
 * aucun signalement de position douteuse, bien qui n'est ni un parking ni un terrain.
 */
export function aerialOrbitTarget(
  sale: Pick<
    AuctionSale,
    "latitude" | "longitude" | "address" | "postal_code" | "city" | "quality_flags"
  > &
    Partial<Pick<AuctionSale, "location_precision" | "property_type">>,
): AerialOrbitTarget | null {
  const precision =
    typeof sale.location_precision === "string" ? sale.location_precision.trim().toLowerCase() : "";
  if (!BUILDING_LOCATION_PRECISIONS.has(precision)) return null;
  const propertyType = typeof sale.property_type === "string" ? sale.property_type.trim() : "";
  if (NO_BUILDING_PROPERTY_TYPES.has(propertyType.toLowerCase())) return null;
  const coordinates = listingCoordinates(sale as AuctionSale);
  if (!coordinates) return null;
  const street = sale.address?.trim();
  if (!street || !hasNumberedStreetAddress(street)) return null;
  const flags = Array.isArray(sale.quality_flags) ? sale.quality_flags : [];
  if (flags.some((flag) => typeof flag === "string" && DOUBTFUL_LOCATION_FLAGS.has(flag))) {
    return null;
  }
  // L'adresse des sources contient souvent déjà le code postal et la commune.
  const lower = street.toLowerCase();
  const extras = [sale.postal_code, sale.city]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part && !lower.includes(part.toLowerCase()));
  const address = [street, ...extras].join(", ");
  return { ...coordinates, address, accuracyMeters: ACCURACY_METERS[precision] };
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
