/** Nombre fini tiré d'un nombre ou d'une chaîne ; `null` si absent, vide ou non numérique. */
export function parseFiniteNumber(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
