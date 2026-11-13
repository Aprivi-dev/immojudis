import type { KeyFact } from "@/lib/fact-reliability";

/**
 * Clés de champ (déjà normalisées) sous lesquelles chaque fait clé est relevé : colonnes de la vente,
 * clés de la table des faits (`field_key`), champs des conflits et des contrôles de source. La fiche
 * (`fact-reliability`) les compare, et les workflows serveur (`auction-fact-claims`) ne lisent que
 * les faits relevés sous ces clés : une clé ajoutée ici est lue des deux côtés.
 */
export const KEY_FACT_FIELDS: Record<KeyFact, readonly string[]> = {
  sale_date: ["sale_date", "sale.sale_date", "date", "event_date", "auction_date"],
  starting_price_eur: [
    "starting_price_eur",
    "sale.starting_price_eur",
    "starting_price",
    "price",
    "mise_a_prix",
  ],
  surface: [
    "surface",
    "surface_m2",
    "property.surface_m2",
    "app_surface_m2",
    "property.app_surface_m2",
    "habitable_surface_m2",
    "property.habitable_surface_m2",
    "carrez_surface_m2",
    "property.carrez_surface_m2",
    "land_surface_m2",
    "property.land_surface_m2",
  ],
  occupancy_status: ["occupancy_status", "property.occupancy_status", "occupancy", "occupation"],
};

/** Forme comparable d'une clé ou d'un code : sans accents ni casse, espaces et tirets en `_`. */
export function normalizeFactKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("fr-FR")
    .replace(/[\s-]+/g, "_")
    .trim();
}
