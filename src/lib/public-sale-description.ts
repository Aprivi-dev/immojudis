import { seoPropertyLabel, seoSurface } from "@/lib/seo";
import type { AuctionSale } from "@/lib/types";

/** Property types whose land surface describes the property itself (not a co-ownership parcel). */
const LAND_TYPES = new Set(["house", "land", "building", "mixed"]);

const AMENITIES: Array<[keyof AuctionSale, string]> = [
  ["has_garden", "Jardin"],
  ["has_terrace", "Terrasse"],
  ["has_pool", "Piscine"],
  ["has_garage", "Garage"],
  ["has_air_conditioning", "Climatisation"],
  ["has_double_glazing", "Double vitrage"],
];

function plural(count: number, word: string): string {
  return `${count} ${word}${count > 1 ? "s" : ""}`;
}

/** « 3 pièces dont 2 chambres », « 2 chambres » ou `null` : seulement ce que l'annonce indique. */
export function roomsPhrase(sale: AuctionSale): string | null {
  const rooms = sale.rooms_count != null && sale.rooms_count > 0 ? sale.rooms_count : null;
  const bedrooms =
    sale.bedrooms_count != null && sale.bedrooms_count > 0 ? sale.bedrooms_count : null;
  if (rooms)
    return `${plural(rooms, "pièce")}${bedrooms ? ` dont ${plural(bedrooms, "chambre")}` : ""}`;
  return bedrooms ? plural(bedrooms, "chambre") : null;
}

/** Surface du terrain quand elle décrit le bien lui-même (maison, terrain, immeuble), sinon `null`. */
export function landSurface(sale: AuctionSale): string | null {
  return LAND_TYPES.has(sale.property_type ?? "") && sale.land_surface_m2 != null
    ? seoSurface(Number(sale.land_surface_m2))
    : null;
}

/**
 * Équipements que l'annonce mentionne (« Jardin », « 2 places de stationnement »). Une mention absente
 * n'est pas une absence : rien n'est dit de ce que l'annonce tait.
 */
export function saleAmenities(sale: AuctionSale): string[] {
  const amenities = AMENITIES.filter(([key]) => sale[key] === true).map(([, text]) => text);
  const parking = sale.parking_count != null ? Number(sale.parking_count) : 0;
  if (parking > 0 && !amenities.includes("Garage")) {
    amenities.push(plural(parking, "place") + " de stationnement");
  }
  return amenities;
}

/**
 * A factual, generated description of the property for the signed-out page,
 * built only from structured facts (never the source listing text). Amenities
 * are listed only when the listing says so: a missing mention is not an absence.
 */
export function publicSaleDescription(sale: AuctionSale): {
  sentence: string;
  amenities: string[];
} {
  const surface = seoSurface(sale.app_surface_m2);
  const rooms = roomsPhrase(sale);
  const land = landSurface(sale);

  let sentence = seoPropertyLabel(sale.property_type);
  if (surface) sentence += ` de ${surface}`;
  if (rooms) sentence += `, ${rooms}`;
  if (land) sentence += `, sur un terrain de ${land}`;
  const place = [sale.city, sale.department ? `(${sale.department})` : null]
    .filter(Boolean)
    .join(" ");
  if (place) sentence += `, à ${place}`;
  sentence += ".";
  return { sentence, amenities: saleAmenities(sale) };
}

/** What the free account reveals on this sale, counted without exposing it. */
export function publicDossierContents(sale: AuctionSale): string[] {
  const photos = sale.photo_count ?? 0;
  const documents = sale.document_count ?? 0;
  return [
    photos > 1 ? `${photos} photos du bien` : null,
    sale.has_visit_dates ? "Les dates et le lieu des visites" : null,
    "L’adresse et la carte du quartier",
    "L’occupation du bien et le contact de l’avocat ou de l’étude",
    documents > 0
      ? `${plural(documents, "pièce")} au dossier (cahier des conditions, diagnostics…), lisibles avec l’offre Analyse`
      : null,
  ].filter((item): item is string => item !== null);
}
