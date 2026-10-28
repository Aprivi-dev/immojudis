import type { AuctionSale } from "@/lib/types";
// `isInFrance` plutôt que `listingCoordinates` (sale-listing) : ce module est importé par les vignettes
// de la liste, qui ne doivent pas charger tout `sale-listing` (budgets de JavaScript).
import { isInFrance } from "@/lib/france-bounds";
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

type BuildingPositionSale = Pick<
  AuctionSale,
  "latitude" | "longitude" | "address" | "quality_flags"
> &
  Partial<Pick<AuctionSale, "location_precision">>;

type OrbitSale = BuildingPositionSale &
  Pick<AuctionSale, "postal_code" | "city"> &
  Partial<Pick<AuctionSale, "property_type">>;

/**
 * Position d'un bâtiment ou d'une parcelle assez sûre pour y poser un repère sur une image
 * aérienne : précision `address` ou `parcel` exigée (une précision de rue, de commune ou absente
 * ne désigne aucun bâtiment), point en France, adresse numérotée, aucun signalement de position
 * douteuse. Renvoie la précision retenue, ou null.
 */
function reliableBuildingPosition(sale: BuildingPositionSale): {
  precision: "address" | "parcel";
  lat: number;
  lng: number;
  street: string;
} | null {
  const precision =
    typeof sale.location_precision === "string" ? sale.location_precision.trim().toLowerCase() : "";
  if (precision !== "address" && precision !== "parcel") return null;
  const { latitude: lat, longitude: lng } = sale;
  if (lat == null || lng == null || !isInFrance(lat, lng)) return null;
  const street = sale.address?.trim();
  if (!street || !hasNumberedStreetAddress(street)) return null;
  const flags = Array.isArray(sale.quality_flags) ? sale.quality_flags : [];
  if (flags.some((flag) => typeof flag === "string" && DOUBTFUL_LOCATION_FLAGS.has(flag))) {
    return null;
  }
  return { precision, lat, lng, street };
}

/**
 * Vrai si le point de la vente désigne un bâtiment ou une parcelle de façon fiable : seule une
 * telle position justifie un repère sur une image satellite. Partagée par la vue 360° de la fiche
 * (`aerialOrbitTarget`) et par la vignette satellite de la liste.
 */
export function hasReliableBuildingPosition(sale: BuildingPositionSale): boolean {
  return reliableBuildingPosition(sale) !== null;
}

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
