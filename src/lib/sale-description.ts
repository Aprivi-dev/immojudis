import type { AuctionSale } from "@/lib/types";
import { atTribunal } from "@/lib/seo";
import { getSaleProcedure, saleVenueLabel } from "./sale-procedure";
import { formatDate, formatPrice, formatSurface, propertyTypeLabel } from "./format";
import {
  INTERRUPTED_SALE_STATUSES,
  listingOccupation,
  listingValuationConflict,
  listingSaleStatus,
} from "./listing-evidence";
import { saleSession, saleWindow } from "./sale-window";
import { listingDate, listingVisits } from "./sale-listing";
import { extractDpe } from "./dpe";
import { landSurface, roomsPhrase, saleAmenities } from "./public-sale-description";

export function buildStructuredDescription(sale: AuctionSale, now = new Date()): string {
  const location = [sale.city, sale.department].filter(Boolean).join(", ");
  const procedure = getSaleProcedure(sale);
  const venue = procedure.venueName;
  const price =
    sale.starting_price_eur != null &&
    Number.isFinite(sale.starting_price_eur) &&
    sale.starting_price_eur > 0
      ? ` avec une mise à prix de ${formatPrice(sale.starting_price_eur)}`
      : ", avec une mise à prix à confirmer";
  const saleDate = formatDate(sale.sale_date);
  const window = saleWindow(sale);
  const session = saleSession(sale);
  const valuationConflict = listingValuationConflict(sale);
  const status = listingSaleStatus(sale, now);
  const withdrawn = INTERRUPTED_SALE_STATUSES.includes(sale.status ?? "");
  const past = status?.startsWith("Date de vente passée") ?? false;
  const occupation = listingOccupation(sale);
  const surfaceLabel = valuationConflict ? "surface à vérifier" : saleSurfaceLabel(sale);
  const land = valuationConflict ? null : landSurface(sale);
  const facts = [
    valuationConflict ? "type de bien à confirmer" : propertyTypeLabel(sale.property_type),
    surfaceLabel,
    roomsPhrase(sale),
    // Le terrain n'est ajouté que s'il n'est pas déjà la surface du bien (terrain à bâtir, « terrain 400 m² »).
    land && sale.property_type !== "land" && !surfaceLabel?.startsWith("terrain")
      ? `terrain de ${land}`
      : null,
    ["Non renseignée", "À confirmer"].includes(occupation) ? null : occupation,
  ].filter((fact): fact is string => Boolean(fact && fact !== "Non renseigné"));
  const amenities = saleAmenities(sale).map((item) => item.charAt(0).toLowerCase() + item.slice(1));
  const dpe = extractDpe(sale).class;
  // Visites : seulement pour une vente encore à venir, et au plus trois créneaux.
  const visits = withdrawn || past ? [] : listingVisits(sale).slice(0, 3);

  return [
    `Ce bien${location ? ` situé à ${location}` : ""}${withdrawn || past ? " figure dans un dossier de vente" : " est proposé à la vente"}${price}.`,
    `${saleVenueLabel(procedure.venueType)}.`,
    status ? `${status}.` : "",
    withdrawn
      ? "La date précédemment annoncée ne vaut pas rendez-vous confirmé."
      : past
        ? saleDate !== "Date à confirmer"
          ? `Date annoncée dans le dossier : ${saleDate}.`
          : "La date exacte reste à confirmer."
        : window
          ? `Les enchères ouvrent le ${listingDate(window.opens_at)} et clôturent le ${listingDate(window.closes_at)}.`
          : session
            ? `La séance est annoncée du ${listingDate(session.opens_at)} au ${listingDate(session.closes_at)}. L’heure de passage du lot reste à confirmer.`
            : saleDate !== "Date à confirmer"
              ? `La vente est prévue le ${saleDate}${venueSentence(procedure.venueType, venue)}.`
              : "La date de vente reste à confirmer.",
    facts.length
      ? `Les informations disponibles indiquent : ${facts.join(", ")}.`
      : "Les caractéristiques détaillées restent à vérifier dans les pièces du dossier.",
    amenities.length ? `Équipements mentionnés : ${amenities.join(", ")}.` : "",
    dpe ? `Diagnostic de performance énergétique : classe ${dpe}.` : "",
    visits.length ? `Visites annoncées : ${visits.join(" ; ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** " au tribunal judiciaire de Bordeaux" / " auprès de Me Dupont": never "auprès de Tribunal judiciaire…". */
function venueSentence(venueType: string, venue: string | null): string {
  if (!venue) return "";
  return venueType === "tribunal" ? ` ${atTribunal(venue)}` : ` auprès de ${venue}`;
}

function saleSurfaceLabel(sale: AuctionSale): string | null {
  if (sale.app_surface_m2 != null) return `surface retenue ${formatSurface(sale.app_surface_m2)}`;
  if (sale.habitable_surface_m2 != null) {
    const label = ["apartment", "house"].includes(sale.property_type ?? "")
      ? "surface habitable"
      : "surface renseignée";
    return `${label} ${formatSurface(sale.habitable_surface_m2)}`;
  }
  if (sale.carrez_surface_m2 != null)
    return `surface Carrez ${formatSurface(sale.carrez_surface_m2)}`;
  if (sale.land_surface_m2 != null) return `terrain ${formatSurface(sale.land_surface_m2)}`;
  return null;
}
