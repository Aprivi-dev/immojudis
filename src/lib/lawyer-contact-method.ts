/** Libellé du moyen de contact préféré d'une demande de mise en relation (email par défaut). */
export function contactMethodLabel(value: string | null | undefined): string {
  if (value === "phone") return "Téléphone";
  if (value === "either") return "Email ou téléphone";
  return "Email";
}
