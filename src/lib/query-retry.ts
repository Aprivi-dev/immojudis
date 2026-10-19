/**
 * Règle de relance des requêtes (`retry` de React Query) : une panne est retentée une fois, une
 * demande refusée par le serveur (400, par exemple une page hors bornes : `SearchRejectedError`)
 * jamais, puisque la réponse serait la même. Reconnue par son statut et non par sa classe : ce
 * module est chargé par toutes les pages (`providers.tsx`) et ne doit rien tirer d'autre avec lui.
 */
export function retryUnlessRefused(failureCount: number, error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status !== 400 && failureCount < 1;
}
