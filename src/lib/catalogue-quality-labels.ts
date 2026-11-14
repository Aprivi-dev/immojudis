/**
 * Libellés des contrôles qualité du catalogue (`catalogue.quality.<contrôle>`), dans l'ordre d'affichage :
 * les invariants, les seuils, puis les tendances. Seule table : le panneau de Qualité des données et les
 * libellés des alertes d'exploitation la lisent. Module sans dépendance.
 */
export const CATALOGUE_QUALITY_LABELS: Readonly<Record<string, string>> = {
  bedrooms_ge_rooms: "Chambres ≥ pièces (plus d’une pièce)",
  land_with_rooms: "Terrains avec un nombre de pièces",
  licitor_lot_mismatch: "Lots Licitor discordants avec leur carte",
  price_per_m2_implausible: "Prix au m² invraisemblable",
  missing_postal_code_ratio: "Ventes sans code postal",
  documents_incomplete: "Pièces jointes bloquées « incomplete »",
  dwelling_without_surface_ratio: "Maisons et appartements sans surface",
  occupancy_unknown_ratio: "Occupation inconnue",
};
