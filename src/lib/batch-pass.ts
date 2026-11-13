import { errorDetailForLog } from "@/lib/error-detail-for-log";

/** Erreurs gardées au plus dans le bilan d'une passe : les suivantes ne sont que comptées. */
export const MAX_REPORTED_ERRORS = 5;

/**
 * Bilan des échecs d'une passe planifiée (palier de complétude, pépites) : `count` évaluations
 * comptées en échec, le message de l'erreur gardé tant que le bilan en a moins de cinq.
 */
export function recordBatchFailure(
  result: { failed: number; errors: string[] },
  count: number,
  error: unknown,
): void {
  result.failed += count;
  if (result.errors.length < MAX_REPORTED_ERRORS) result.errors.push(errorDetailForLog(error));
}

/** Ordre de reprise des évaluations déjà faites : la plus ancienne d'abord, l'identifiant départage. */
export function byEvaluationDate(
  left: { id: string; evaluatedAt: number },
  right: { id: string; evaluatedAt: number },
): number {
  return left.evaluatedAt - right.evaluatedAt || left.id.localeCompare(right.id);
}
