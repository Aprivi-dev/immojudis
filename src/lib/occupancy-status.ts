// Règles d'occupation partagées (écart au marché, plafond, libellés, statistiques des tribunaux).
// Module sans dépendance : les libellés et le plafond, chargés par des composants client, ne doivent
// pas tirer `market-gap-band` (seuils, bandes) pour deux prédicats.

/**
 * Classe d'occupation d'une valeur `occupancy_status` : bien libre, occupé ou loué ; `null` pour une
 * occupation inconnue ou illisible. Miroir de `app_private.is_occupied_occupancy_status` et
 * `app_private.is_vacant_occupancy_status` (migration 20261101190000, dont un test vérifie les
 * motifs). Elle accepte le vocabulaire de la base (vacant, occupied, rented, owner_occupied,
 * squatted, unknown), celui du graphe des résultats (tenant_occupied, occupied_other) et les mots
 * français (« libre », « inoccupé », « loué », « occupé par le propriétaire », « squatté »).
 */
export function occupancyClass(
  value: string | null | undefined,
): "vacant" | "occupied" | "rented" | null {
  const normalized = value?.trim().toLocaleLowerCase("fr-FR");
  if (!normalized || normalized === "unknown") return null;
  if (normalized === "vacant" || /inoccup|libre/.test(normalized)) return "vacant";
  if (normalized === "rented" || normalized === "tenant_occupied" || /lou[eé]/.test(normalized)) {
    return "rented";
  }
  if (
    normalized === "occupied" ||
    normalized === "owner_occupied" ||
    normalized === "squatted" ||
    /occup|proprietaire|propriétaire|squat/.test(normalized)
  ) {
    return "occupied";
  }
  return null;
}

/** Vrai pour un bien occupé, loué, occupé par son propriétaire ou squatté. */
export function isOccupiedOccupancyStatus(value: string | null | undefined): boolean {
  const occupancy = occupancyClass(value);
  return occupancy === "occupied" || occupancy === "rented";
}

/**
 * Vrai pour un bien libre, vacant ou inoccupé ; faux pour un bien occupé et pour une occupation
 * inconnue : seul un bien libre reçoit une bande d'écart au marché.
 */
export function isVacantOccupancyStatus(value: string | null | undefined): boolean {
  return occupancyClass(value) === "vacant";
}
