/**
 * Référence de suivi d'un dossier, montrée dans l'email (« Référence de suivi ») et sur la page de dépôt :
 * la même des deux côtés pour que le professionnel reconnaisse son dossier.
 */
export function informationAgentCaseReference(caseId: string): string {
  return `IJ-${caseId.replaceAll("-", "").slice(0, 8).toUpperCase()}`;
}
