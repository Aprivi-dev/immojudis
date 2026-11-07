/** Empreinte d'un libellé (sans accents, minuscules, alphanumérique) pour comparer des noms. */
export function labelFingerprint(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr-FR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
