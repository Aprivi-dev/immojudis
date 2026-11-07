/** Date tirée d'une chaîne ; `null` si absente ou invalide. */
export function parseDateOrNull(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
