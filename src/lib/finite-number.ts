/** Nombre fini tiré d'un nombre ou d'une chaîne ; `null` si absent, vide ou non numérique. */
export function parseFiniteNumber(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function finiteNumberFromNumberOrText(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}
