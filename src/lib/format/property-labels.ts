import { occupancyClass } from "@/lib/occupancy-status";
import { propertyFamily, type PropertyFamily } from "@/lib/property-type-family";

/**
 * Libellé français de `occupancy_status` (contrainte SQL : vacant, occupied, rented, owner_occupied,
 * squatted, unknown), qui suit la classe de l'écart au marché et du plafond (`occupancyClass`) :
 * « inoccupé » est un bien libre, un bien squatté est « occupé sans droit ni titre », un bien loué
 * est « loué ».
 */
export function occupancyLabel(status: string | null | undefined): string {
  if (!status) return "Non renseigné";
  const s = status.trim().toLocaleLowerCase("fr-FR");
  if (s === "unknown" || s === "inconnu") return "À confirmer";
  const occupancy = occupancyClass(s);
  if (occupancy === "vacant" || s === "free") return "Libre";
  if (occupancy === null) return status;
  if (/squat/.test(s)) return "Occupé sans droit ni titre";
  if (occupancy === "rented") return "Loué";
  if (s === "owner_occupied" || /propri[eé]taire/.test(s)) return "Occupé par le propriétaire";
  return "Occupé";
}

const UNTYPED_PROPERTY_LABEL = "Bien";
const UNQUALIFIED_PROPERTY_LABEL = "Bien à qualifier";

const PROPERTY_FAMILY_LABELS: Record<Exclude<PropertyFamily, "other" | "unknown">, string> = {
  apartment: "Appartement",
  house: "Maison",
  building: "Immeuble",
  mixed: "Bien mixte",
  land: "Terrain",
  parking: "Garage / Parking",
  commercial: "Local commercial",
};

export function propertyTypeLabel(t: string | null | undefined): string {
  if (!t) return UNTYPED_PROPERTY_LABEL;
  const family = propertyFamily(t);
  if (family === "unknown") return UNQUALIFIED_PROPERTY_LABEL;
  if (family !== "other") return PROPERTY_FAMILY_LABELS[family];
  // An internal code that has no label yet must never reach a visitor; a human-written label that
  // no family recognises is shown as written.
  return t.trim().toLowerCase() === "other" || /^[a-z][a-z0-9_-]*$/.test(t)
    ? UNQUALIFIED_PROPERTY_LABEL
    : t;
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
