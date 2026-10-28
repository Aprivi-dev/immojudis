/**
 * Codes d'erreur Postgres d'une écriture bloquée par un verrou, et non d'une ligne invalide : 57014 (requête annulée
 * au délai, ce que devient une attente de verrou sous PostgREST), 55P03 (verrou indisponible) et 40P01 (interblocage).
 * Une écriture refusée pour ce motif n'est pas rejouée par moitiés (chaque niveau attendrait le délai complet) : elle
 * est différée et reprend à la passe suivante. Une autre erreur (contrainte, type) désigne une ligne invalide.
 */
const BUSY_WRITE_CODES: ReadonlySet<string> = new Set(["57014", "55P03", "40P01"]);

export function isBusyWriteError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && BUSY_WRITE_CODES.has(code);
}
