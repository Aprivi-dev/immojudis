import { buildCadastralAnalysis, type StructuredCadastralParcel } from "./cadastre-analysis";
import { sanitizeAuctionSaleForDisplay } from "./listing-data-cleanup";
import type { AuctionSale } from "./types";
import type { LandLocationInput, LandParcelReference } from "./land-report-types";

/** Do not derive cadastral references from an AI summary or a geocoded candidate. */
export function landLocationInputFromSale(
  originalSale: AuctionSale,
  storedParcels: StructuredCadastralParcel[] = [],
): LandLocationInput {
  const sale = sanitizeAuctionSaleForDisplay(originalSale);
  const textual = buildCadastralAnalysis(
    { ...sale, title: null, description: null, risks: [], documents_rich: [] },
    [],
  ).references;
  const codeInsee =
    storedParcels.find(
      (parcel) =>
        validInsee(parcel.codeInsee) && !/point|geocod|centroid/i.test(parcel.matchKind ?? ""),
    )?.codeInsee ?? null;
  const references: LandParcelReference[] = textual
    .filter((reference) => reference.section && reference.number)
    .map((reference) => ({
      codeInsee,
      section: reference.section!,
      number: reference.number!,
      prefix: reference.prefix ?? null,
      source: "listing",
    }));

  // The pipeline labels point-only matches explicitly. Such matches remain candidates.
  for (const parcel of storedParcels) {
    if (/point|geocod|centroid/i.test(parcel.matchKind ?? "")) continue;
    if (!parcel.section || !parcel.parcelNumber || !validInsee(parcel.codeInsee)) continue;
    const alreadyPresent = references.some(
      (reference) =>
        reference.section === parcel.section &&
        Number(reference.number) === Number(parcel.parcelNumber),
    );
    if (!alreadyPresent) {
      references.push({
        codeInsee: parcel.codeInsee,
        section: parcel.section,
        number: parcel.parcelNumber,
        source: "stored",
      });
    }
  }
  // Précision de la position (`location_precision`) : un centre de commune n'est pas la position du bien, il
  // compte comme une position absente (aucune coordonnée n'est transmise aux sources de risques).
  const locationPrecision =
    typeof sale.location_precision === "string" && sale.location_precision.trim()
      ? sale.location_precision.trim().toLowerCase()
      : null;
  const hasCoordinates =
    locationPrecision !== "municipality" &&
    typeof sale.latitude === "number" &&
    typeof sale.longitude === "number" &&
    Number.isFinite(sale.latitude) &&
    Number.isFinite(sale.longitude) &&
    Math.abs(sale.latitude) <= 90 &&
    Math.abs(sale.longitude) <= 180;
  return {
    address: sale.address,
    postalCode: sale.postal_code,
    city: sale.city,
    codeInsee,
    coordinates: hasCoordinates ? { latitude: sale.latitude!, longitude: sale.longitude! } : null,
    locationPrecision,
    references,
  };
}

function validInsee(value: unknown): value is string {
  return typeof value === "string" && /^(?:\d{5}|2[AB]\d{3})$/.test(value);
}
