import {
  googleMapsAerial3dUrl,
  googleMapsQueryUrl,
  googleMapsStreetViewUrl,
  googleMapsUrl,
} from "@/lib/google-maps";
import type { AuctionSale } from "@/lib/types";

export type StreetFacadeStatus = "coordinates_ready" | "address_only" | "missing";

export type StreetFacadeAnalysis = {
  available: boolean;
  status: StreetFacadeStatus;
  label: string;
  locationQuality: "coordinates" | "address" | "missing";
  confidence: "high" | "medium" | "low";
  confidenceLabel: string;
  addressLabel: string | null;
  coordinates: {
    lat: number;
    lng: number;
  } | null;
  mapsUrl: string | null;
  streetViewUrl: string | null;
  aerial3dUrl: string | null;
  summary: string;
  decisionImpact: string;
  nextActions: string[];
  limitations: string[];
};

export function buildStreetFacadeAnalysis(sale: AuctionSale): StreetFacadeAnalysis {
  const coordinates = validCoordinates(sale.latitude, sale.longitude);
  const addressLabel = saleAddress(sale);
  const status = coordinates ? "coordinates_ready" : addressLabel ? "address_only" : "missing";
  const mapsUrl = coordinates
    ? googleMapsUrl(coordinates.lat, coordinates.lng, addressLabel)
    : addressLabel
      ? googleMapsQueryUrl(addressLabel)
      : null;

  return {
    available: status !== "missing",
    status,
    label: statusLabel(status),
    locationQuality: locationQuality(status),
    confidence: confidence(status),
    confidenceLabel: confidenceLabel(status),
    addressLabel,
    coordinates,
    mapsUrl,
    streetViewUrl: coordinates ? googleMapsStreetViewUrl(coordinates.lat, coordinates.lng) : null,
    aerial3dUrl: coordinates ? googleMapsAerial3dUrl(coordinates.lat, coordinates.lng) : null,
    summary: summary({ status, addressLabel }),
    decisionImpact: decisionImpact(status),
    nextActions: nextActions(status),
    limitations: limitations(status),
  };
}

function validCoordinates(lat: unknown, lng: unknown): StreetFacadeAnalysis["coordinates"] {
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    return null;
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function saleAddress(sale: AuctionSale): string | null {
  const parts = [sale.address, sale.postal_code, sale.city, sale.department]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function statusLabel(status: StreetFacadeStatus): string {
  const labels: Record<StreetFacadeStatus, string> = {
    coordinates_ready: "Vue façade et rue prête",
    address_only: "Adresse à ouvrir dans Maps",
    missing: "Localisation à géocoder",
  };
  return labels[status];
}

function locationQuality(status: StreetFacadeStatus): StreetFacadeAnalysis["locationQuality"] {
  if (status === "coordinates_ready") return "coordinates";
  if (status === "address_only") return "address";
  return "missing";
}

function confidence(status: StreetFacadeStatus): StreetFacadeAnalysis["confidence"] {
  if (status === "coordinates_ready") return "high";
  if (status === "address_only") return "medium";
  return "low";
}

function confidenceLabel(status: StreetFacadeStatus): string {
  if (status === "coordinates_ready") return "Coordonnées exploitables";
  if (status === "address_only") return "Adresse exploitable, coordonnées à confirmer";
  return "Coordonnées et adresse insuffisantes";
}

function summary({
  status,
  addressLabel,
}: {
  status: StreetFacadeStatus;
  addressLabel: string | null;
}): string {
  if (status === "coordinates_ready") {
    return "Street View, vue 3D et carte peuvent être ouverts depuis les coordonnées du bien.";
  }
  if (status === "address_only") {
    return `Recherche Maps disponible pour ${addressLabel ?? "l'adresse"}, Street View à confirmer.`;
  }
  return "Aucune localisation exploitable pour vérifier façade, rue ou environnement immédiat.";
}

function decisionImpact(status: StreetFacadeStatus): string {
  if (status === "coordinates_ready") {
    return "Contrôler façade, accès, rue, mitoyenneté et nuisances visibles avant de finaliser le plafond.";
  }
  if (status === "address_only") {
    return "Confirmer la position exacte avant d'exploiter la façade ou l'environnement visible.";
  }
  return "Sans localisation fiable, l'analyse de façade et de rue ne doit pas influencer la décision.";
}

function nextActions(status: StreetFacadeStatus): string[] {
  if (status === "coordinates_ready") {
    return [
      "Ouvrir Street View pour vérifier façade, accès, stationnement et état apparent de la rue.",
      "Comparer la vue 3D avec les photos et le PV descriptif.",
      "Noter toute nuisance visible à intégrer au plafond ou à la visite.",
    ];
  }
  if (status === "address_only") {
    return [
      "Géocoder l'adresse pour obtenir des coordonnées fiables.",
      "Vérifier que le résultat Maps correspond bien au bien vendu.",
      "Compléter ensuite le contrôle Street View ou visite sur place.",
    ];
  }
  return [
    "Rattacher une adresse ou des coordonnées avant toute lecture façade/rue.",
    "Utiliser le PV descriptif et les photos tant que la géolocalisation manque.",
  ];
}

function limitations(status: StreetFacadeStatus): string[] {
  const items = [
    "Les vues externes peuvent être anciennes, floutées, incomplètes ou ne pas montrer le lot exact.",
    "La vérification visuelle ne remplace pas la visite, les diagnostics et le PV descriptif.",
  ];
  if (status !== "coordinates_ready") {
    items.unshift(
      "La position exacte du bien n'est pas confirmée par des coordonnées exploitables.",
    );
  }
  return items;
}
