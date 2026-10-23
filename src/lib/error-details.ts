/**
 * Message et code lisibles d'une erreur quelconque. Le client Supabase rejette ou renvoie des
 * objets `{ message, code, details, hint }` qui ne sont pas des `Error` : sans cette lecture, le
 * motif d'un échec (délai dépassé, droit refusé) se perd derrière un message générique.
 */
export type ErrorDetails = {
  message: string;
  code: string | null;
};

const MAX_ERROR_DETAILS_LENGTH = 300;

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function errorDetails(error: unknown, fallback = "Erreur inconnue"): ErrorDetails {
  let message: string | null = null;
  let code: string | null = null;

  if (typeof error === "string") {
    message = clean(error);
  } else if (error instanceof Error) {
    message = clean(error.message);
    code = clean((error as { code?: unknown }).code);
  } else if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const parts = [record.message, record.details, record.hint]
      .map(clean)
      .filter((value): value is string => value !== null);
    message = parts.length ? [...new Set(parts)].join(" · ") : null;
    code = clean(record.code);
  }

  const text = message ?? fallback;
  return {
    message:
      text.length > MAX_ERROR_DETAILS_LENGTH ? `${text.slice(0, MAX_ERROR_DETAILS_LENGTH)}…` : text,
    code,
  };
}

/** `message (code)` sur une ligne, pour un journal ou un résumé d'exécution. */
export function errorSummary(error: unknown, fallback?: string): string {
  const { message, code } = errorDetails(error, fallback);
  return code && !message.includes(code) ? `${message} (${code})` : message;
}
