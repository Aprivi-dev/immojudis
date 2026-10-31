// Règles d'occupation partagées (écart au marché, plafond, libellés). Module sans dépendance : les
// libellés et le plafond, chargés par des composants client, ne doivent pas tirer `market-gap-band`
// (seuils, bandes) pour deux prédicats.

/**
 * Vrai pour un bien occupé, loué, occupé par son propriétaire ou squatté. Miroir de
 * `app_private.is_occupied_occupancy_status` et de `normalizeOccupationStatus`
 * (`tribunal-listing-statistics.ts`, dont le test vérifie l'accord) : « libre » et « inconnu »
 * donnent faux.
 */
export function isOccupiedOccupancyStatus(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLocaleLowerCase("fr-FR");
  if (!normalized || normalized === "unknown") return false;
  if (normalized === "vacant" || /inoccup|libre/.test(normalized)) return false;
  if (normalized === "rented" || normalized === "tenant_occupied" || /lou[eé]/.test(normalized)) {
    return true;
  }
  return (
    normalized === "occupied" ||
    normalized === "owner_occupied" ||
    normalized === "squatted" ||
    /occup|proprietaire|propriétaire|squat/.test(normalized)
  );
}

/**
 * Vrai pour un bien libre, vacant ou inoccupé ; faux pour un bien occupé et pour une occupation
 * inconnue. Miroir de `app_private.is_vacant_occupancy_status` (migration 20261101190000) : seul un
 * bien libre reçoit une bande d'écart au marché.
 */
export function isVacantOccupancyStatus(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLocaleLowerCase("fr-FR");
  if (!normalized) return false;
  return normalized === "vacant" || /inoccup|libre/.test(normalized);
}
