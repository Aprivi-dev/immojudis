/**
 * Browser-safe error primitives shared by the API layer. Nothing in this module may
 * import server-only code: it is also used by unit tests and by client helpers.
 */

/** Codes d'erreur de l'API ; la liste de `components.schemas.ApiError.code` d'openapi.yaml doit être identique. */
export const API_ERROR_CODES = [
  "AUTH_REQUIRED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "INVALID_REQUEST",
  "COURT_UNRESOLVED",
  "RATE_LIMITED",
  "CONFIGURATION_ERROR",
  "INTERNAL_ERROR",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Raised when a per-user or per-IP quota is exhausted. Mapped to HTTP 429 + Retry-After. */
export class RateLimitError extends Error {
  readonly retryAfterSeconds: number;
  /**
   * Message rendu tel quel à l'utilisateur à la place du « Trop de demandes. » générique (plafonds
   * journaliers : « Limite quotidienne atteinte, réessayez demain. »). Absent : message générique.
   */
  readonly publicMessage?: string;

  constructor(
    message = "Trop de demandes. Réessayez dans une minute.",
    retryAfterSeconds = 60,
    publicMessage?: string,
  ) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
    if (publicMessage) this.publicMessage = publicMessage;
  }
}

/**
 * An error whose message was written for the end user and may be returned verbatim, with the
 * HTTP status it maps to. Anything that is not a PublicApiError (or does not look like a French
 * business message, see `isPublicErrorMessage`) is replaced by a generic message at the edge.
 */
export class PublicApiError extends Error {
  readonly status: number;
  /** Code of the response; derived from the status when absent. */
  readonly code?: ApiErrorCode;

  constructor(
    message: string,
    status = 400,
    options: { code?: ApiErrorCode; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "PublicApiError";
    this.status = status;
    if (options.code) this.code = options.code;
  }
}

/** 403 : the account is authenticated but not allowed (role, offer, quota of resources). */
export class ForbiddenError extends PublicApiError {
  constructor(message = "Accès refusé.") {
    super(message, 403);
    this.name = "ForbiddenError";
  }
}

/** 403 for the routes and modules reserved to administrators. */
export class AdminRequiredError extends ForbiddenError {
  constructor() {
    super("Accès administrateur requis.");
    this.name = "AdminRequiredError";
  }
}

/** 404 : the resource does not exist or is not visible to this account. */
export class NotFoundError extends PublicApiError {
  constructor(message = "Ressource introuvable.") {
    super(message, 404);
    this.name = "NotFoundError";
  }
}

/**
 * 401 : no usable credential (missing or invalid session token, invalid API key). The message is
 * a detail for the logs; the response always says « Authentification requise. ».
 */
export class AuthRequiredError extends Error {
  constructor(detail: string, options?: ErrorOptions) {
    super(detail, options);
    this.name = "AuthRequiredError";
  }
}

/**
 * 503 : a dependency (database, provider) failed or timed out. The message is a detail for the logs;
 * the response carries the route's fallback message.
 */
export class ServiceUnavailableError extends Error {
  constructor(detail: string, options?: ErrorOptions) {
    super(detail, options);
    this.name = "ServiceUnavailableError";
  }
}

/**
 * 503 : a server-side setting (environment variable, client) is missing. The message is a detail
 * for the logs; the response says « Service temporairement indisponible. ».
 */
export class ConfigurationError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ConfigurationError";
  }
}
