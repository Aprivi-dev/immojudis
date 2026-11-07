/** Horodatage en millisecondes d'une date ISO ; `null` si absente ou invalide. */
export function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}
