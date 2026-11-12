/**
 * Server-side helpers around API errors: what may reach a browser, and the
 * check of a response against its own published schema. Kept out of `@/lib/api-errors`, whose error
 * classes are also shipped to the browser.
 */

// Markers of infrastructure or driver errors that must never reach a browser.
const TECHNICAL_MARKERS =
  /supabase|postgres|postgrest|pgrst|sqlstate|\bjwt\b|\brelation\b|violates|duplicate key|syntax error|permission denied|row-level|econn|enotfound|etimedout|fetch failed|undefined|\bnull\b|stack|\bat\s+\S+\s*\(|https?:\/\/|[{}[\]<>]|\\n|\bselect\b.*\bfrom\b|\bauth\.|\bpublic\.|app_private|\bstorage\.|\.(?:ts|js|mjs)\b|service[_ ]role|secret|password|token|api[_ ]?key\s*[:=]|stripe|resend|replicate|mapbox|openai|anthropic/i;

// Application messages are written in French; driver and runtime messages are English.
const FRENCH_MARKERS =
  /[àâäçéèêëîïôöùûüœ]|\b(?:le|la|les|un|une|des|du|de|d'|l'|est|n'|pas|vous|votre|vos|cette|ce|ces|pour|sans|aucun|aucune)\b|introuvable|invalide|requis|requise|inconnu|impossible|expir|indisponible|incomplet/i;

const MAX_PUBLIC_MESSAGE_LENGTH = 240;

/**
 * True when `message` is a short French business message ("Vente introuvable.")
 * rather than a driver, database or runtime error. Errors raised by our own code
 * are in French; everything else defaults to a generic response.
 */
export function isPublicErrorMessage(message: string | null | undefined): message is string {
  if (!message) return false;
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > MAX_PUBLIC_MESSAGE_LENGTH) return false;
  if (TECHNICAL_MARKERS.test(trimmed)) return false;
  return FRENCH_MARKERS.test(trimmed);
}

/**
 * Raised when what the server built does not match its own published response schema. It is a
 * server fault, not a client mistake: it is deliberately NOT a zod error (which the API edge turns
 * into a 400 « Requête invalide »), so the route answers 503 and logs it at error level.
 */
export class ResponseSchemaViolationError extends Error {
  constructor(cause?: unknown) {
    super("response_schema_violation", { cause });
    this.name = "ResponseSchemaViolationError";
  }
}

/** Validates a response body against its schema; a failure is a 503, never a 400 (see above). */
export function parseApiResponse<T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown };
  },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ResponseSchemaViolationError(result.error);
  return result.data;
}
