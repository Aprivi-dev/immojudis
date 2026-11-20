import { propertyFamily } from "@/lib/property-type-family";

/**
 * Volume schématique de la « Maquette 3D » de la fiche : il illustre le type de bien, jamais le bien
 * lui-même (ni sa forme, ni son étage, ni son environnement ne sont connus).
 */
export type MaquetteKind = "apartment" | "building" | "house" | "land";

/**
 * Le volume qui illustre un type de bien, tiré de sa famille. `null` : aucun volume ne le
 * représenterait honnêtement (local, parking, type non reconnu ou absent), la maquette n'est pas
 * proposée.
 */
export function maquetteKind(propertyType: string | null | undefined): MaquetteKind | null {
  const family = propertyFamily(propertyType);
  if (family === "apartment" || family === "house" || family === "land") return family;
  // Un immeuble mixte (logements et activité) reste un immeuble entier.
  if (family === "building" || family === "mixed") return "building";
  return null;
}
