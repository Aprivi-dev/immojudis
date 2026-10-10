/**
 * Browser-safe error primitives shared by the API layer. Nothing in this module may
 * import server-only code: it is also used by unit tests and by client helpers.
 */

/** Raised when a per-user or per-IP quota is exhausted. Mapped to HTTP 429 + Retry-After. */
export class RateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(message = "Trop de demandes. Réessayez dans une minute.", retryAfterSeconds = 60) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

/**
 * An error whose message was written for the end user and may be returned verbatim.
 * Anything that is not a PublicApiError (or does not look like a French business
 * message, see `isPublicErrorMessage`) is replaced by a generic message at the edge.
 */
export class PublicApiError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "PublicApiError";
    this.status = status;
  }
}

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

/** Error text for server logs only. Never place the result in a response body. */
export function errorDetailForLog(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/** True for the authentication failures raised by the Supabase auth middleware. */
export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Unauthorized");
}
