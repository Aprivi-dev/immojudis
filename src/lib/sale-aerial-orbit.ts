import type { AuctionSale } from "@/lib/types";
import { listingCoordinates } from "@/lib/sale-listing";

/**
 * Signalements du pipeline qui rendent le point de la vente douteux : une vue qui tourne autour
 * d'un repère affirme « c'est ce bâtiment-là », on ne l'affiche donc pas sur un point incertain.
 */
const DOUBTFUL_LOCATION_FLAGS = new Set([
  "implausible_coordinates",
  "unverified_source_coordinates",
  "geocode_outside_department",
  "missing_address",
]);

/**
 * Un numéro suivi d'un type de voie (« 12 rue… », « 3 bis, avenue… »). Sans numéro, le géocodage
 * tombe au mieux sur la rue, souvent au centre de la commune : le repère serait trompeur.
 */
const STREET_NUMBER_ADDRESS =
  /(?:^|[\s,])\d{1,4}\s*(?:bis|ter|quater|[a-d])?\s*,?\s+(?:rue|avenue|av\.?|boulevard|bd|chemin|place|all[ée]e|impasse|route|quai|cours|square|passage|voie|sentier|faubourg|rond-point|r[ée]sidence|hameau|lotissement|cit[ée]|villa|mail|esplanade|promenade|parvis|mont[ée]e|traverse|clos|lieu-dit|chauss[ée]e|ruelle|venelle)\b/i;

export type AerialOrbitTarget = { lat: number; lng: number; address: string };

/**
 * Point autour duquel la fiche peut faire tourner la vue aérienne, ou null si la position n'est pas
 * assez sûre. Le niveau de précision du géocodage (`geo_precision`) reste dans le pipeline et
 * n'arrive pas au navigateur : on s'appuie sur l'adresse et les signalements de la vente.
 */
export function aerialOrbitTarget(
  sale: Pick<
    AuctionSale,
    "latitude" | "longitude" | "address" | "postal_code" | "city" | "quality_flags"
  >,
): AerialOrbitTarget | null {
  const coordinates = listingCoordinates(sale as AuctionSale);
  if (!coordinates) return null;
  const street = sale.address?.trim();
  if (!street || !STREET_NUMBER_ADDRESS.test(street)) return null;
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
  return { ...coordinates, address };
}
