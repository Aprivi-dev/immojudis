import { isOccupiedOccupancyStatus, isVacantOccupancyStatus } from "@/lib/occupancy-status";

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

const UNTYPED_PROPERTY_LABEL = "Bien";
const UNQUALIFIED_PROPERTY_LABEL = "Bien à qualifier";

export function propertyTypeLabel(t: string | null | undefined): string {
  if (!t) return UNTYPED_PROPERTY_LABEL;
  const s = t.toLowerCase();
  if (s === "unknown" || s === "other") return UNQUALIFIED_PROPERTY_LABEL;
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
  return /^[a-z][a-z0-9_-]*$/.test(t) ? UNQUALIFIED_PROPERTY_LABEL : t;
}

/**
 * Le type de bien est qualifié quand `propertyTypeLabel` lui donne un vrai libellé : ni type absent
 * (« Bien »), ni `other`, `unknown` ou code interne sans libellé (« Bien à qualifier »). Accepte aussi
 * un libellé déjà calculé, celui qu'un rapport enregistré conserve : `propertyTypeLabel` rend chacun
 * de ses libellés tel quel.
 */
export function isQualifiedPropertyType(t: string | null | undefined): boolean {
  const label = propertyTypeLabel(t);
  return label !== UNTYPED_PROPERTY_LABEL && label !== UNQUALIFIED_PROPERTY_LABEL;
}
