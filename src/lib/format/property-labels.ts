import { isOccupiedOccupancyStatus, isVacantOccupancyStatus } from "@/lib/market-gap-band";

/**
 * Libellé français de `occupancy_status` (contrainte SQL : vacant, occupied, rented, owner_occupied,
 * squatted, unknown), qui suit les mêmes règles que l'écart au marché et le plafond
 * (`isVacantOccupancyStatus`, `isOccupiedOccupancyStatus`) : « inoccupé » est un bien libre, un bien
 * squatté est « occupé sans droit ni titre », un bien loué est « loué ».
 */
export function occupancyLabel(status: string | null | undefined): string {
  if (!status) return "Non renseigné";
  const s = status.trim().toLocaleLowerCase("fr-FR");
  if (s === "unknown" || s === "inconnu") return "À confirmer";
  if (isVacantOccupancyStatus(s) || s === "free") return "Libre";
  if (isOccupiedOccupancyStatus(s)) {
    if (/squat/.test(s)) return "Occupé sans droit ni titre";
    if (s === "rented" || s === "tenant_occupied" || /lou[eé]/.test(s)) return "Loué";
    if (s === "owner_occupied" || /propri[eé]taire/.test(s)) return "Occupé par le propriétaire";
    return "Occupé";
  }
  return status;
}

export function propertyTypeLabel(t: string | null | undefined): string {
  if (!t) return "Bien";
  const s = t.toLowerCase();
  if (s === "unknown" || s === "other") return "Bien à qualifier";
  if (s === "mixed" || s.includes("mixte")) return "Bien mixte";
  if (s.includes("apart") || s.includes("apt")) return "Appartement";
  if (s === "studio" || s.includes("studio")) return "Appartement";
  if (s.includes("house") || s.includes("maison")) return "Maison";
  if (s.includes("building") || s.includes("immeuble")) return "Immeuble";
  if (s.includes("land") || s.includes("terrain")) return "Terrain";
  if (s.includes("garage") || s.includes("park")) return "Garage / Parking";
  if (s.includes("commerce") || s.includes("commercial") || s.includes("local")) {
    return "Local commercial";
  }
  // An internal code that has no label yet must never reach a visitor.
  return /^[a-z][a-z0-9_-]*$/.test(t) ? "Bien à qualifier" : t;
}

export function saleStatusLabel(status: string | null | undefined): string | null {
  if (!status) return null;
  const s = status.toLowerCase();
  const labels: Record<string, string> = {
    upcoming: "Vente à venir",
    active: "Vente active",
    unknown: "Statut à confirmer",
    past: "Vente passée",
    adjudicated: "Adjugée",
    postponed: "Vente reportée",
    cancelled: "Annulée",
    withdrawn: "Retirée",
  };
  return labels[s] ?? status;
}

export function surfaceSourceLabel(source: string | null | undefined): string | null {
  if (!source) return null;
  const s = source.toLowerCase();
  const labels: Record<string, string> = {
    llm: "extraction documentaire",
    llm_extraction: "extraction documentaire",
    pdf: "document PDF",
    document: "document PDF",
    docling: "extraction PDF",
    source_listing: "page de l'annonce",
    listing: "page de l'annonce",
    surface_m2_fallback: "surface déclarée",
    built_surface_text: "texte du dossier",
    habitable_surface_m2: "surface habitable",
    carrez_surface_m2: "surface Carrez",
    land_surface_m2: "surface terrain",
  };
  return labels[s] ?? source.replaceAll("_", " ");
}
