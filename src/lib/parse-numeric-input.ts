/** Nombre saisi au clavier (espaces et virgule décimale acceptés) ; `null` si vide ou invalide. */
export function parseNumericInput(value: string): number | null {
  const normalized = value
    .trim()
    .replace(/[\s\u00a0\u202f]/g, "")
    .replace(",", ".");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
