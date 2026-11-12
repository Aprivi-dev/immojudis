import { NextResponse } from "next/server";
// Classe de base des erreurs de zod 4 : couvre les ZodError de zod et celles levées par les
// schémas zod/mini (partagés avec le navigateur), qui ne sont pas des instances de ZodError.
import { $ZodError } from "zod/v4/core";
import {
  type ApiErrorCode,
  AuthRequiredError,
  ConfigurationError,
  PublicApiError,
  RateLimitError,
  ResponseSchemaViolationError,
  isPublicErrorMessage,
} from "@/lib/api-errors";
import { resolveRequestId } from "@/lib/request-id";

export type ApiRequestContext = {
  requestId: string;
  scope: string;
  startedAt: number;
  /** Quota du compte après cet appel (`enforceUserRateLimit` avec ce contexte) : `RateLimit-*`. */
  rateLimit?: { limit: number; remaining: number };
};

const completedRequests = new WeakSet<ApiRequestContext>();

export type ApiErrorOptions = {
  fallbackMessage: string;
  fallbackStatus?: number;
  headers?: HeadersInit;
  /**
   * Static fields merged into the error body for clients that expect the success
   * shape (for example `{ favorites: [] }`). Never put error details in here.
   */
  extra?: Record<string, unknown>;
  /**
   * Return short French business messages thrown as plain errors verbatim (400) instead of the
   * fallback. Enabled by `apiRouteError`; the versioned /api/v1 routes keep their generic
   * fallbacks. Typed errors (`@/lib/api-errors`) are returned verbatim either way.
   */
  exposeBusinessMessages?: boolean;
};

export function createApiRequestContext(request: Request, scope: string): ApiRequestContext {
  return {
    requestId: resolveRequestId(request.headers.get("x-request-id")),
    scope,
    startedAt: Date.now(),
  };
}

export type ApiHeadersOptions = {
  /**
   * `false` : l'identifiant de requête n'est pas répercuté dans la réponse. Pour les réponses
   * publiques gardées par un CDN, qui seraient sinon servies à d'autres visiteurs avec
   * l'identifiant de la première requête (il reste dans le journal). Vrai par défaut.
   */
  echoRequestId?: boolean;
};

export function withApiHeaders<T extends Response>(
  response: T,
  context: ApiRequestContext,
  options: ApiHeadersOptions = {},
): T {
  if (options.echoRequestId !== false) response.headers.set("x-request-id", context.requestId);
  if (context.rateLimit) {
    response.headers.set("ratelimit-limit", String(context.rateLimit.limit));
    response.headers.set("ratelimit-remaining", String(context.rateLimit.remaining));
  }
  if (!response.headers.has("cache-control")) response.headers.set("cache-control", "no-store");
  logApiCompletion(context, response.status);
  return response;
}

export function apiJson<T>(
  body: T,
  context: ApiRequestContext,
  init?: ResponseInit,
  headerOptions?: ApiHeadersOptions,
): NextResponse<T> {
  return withApiHeaders(NextResponse.json(body, init), context, headerOptions);
}

export function apiError(error: unknown, context: ApiRequestContext, options: ApiErrorOptions) {
  const classified = classifyApiError(error, options);
  logApiCompletion(context, classified.status, {
    code: classified.code,
    error: error instanceof Error ? error.message : String(error),
  });

  const headers = new Headers(classified.status === 429 ? options.headers : undefined);
  if (options.exposeBusinessMessages) {
    // First-party routes answer per-user requests: never let a shared cache keep an error.
    headers.set("cache-control", "private, no-store");
    headers.set("vary", "authorization");
  }
  if (classified.retryAfterSeconds)
    headers.set("retry-after", String(classified.retryAfterSeconds));

  return apiJson(
    {
      ...options.extra,
      ok: false,
      error: classified.message,
      code: classified.code,
      requestId: context.requestId,
    },
    context,
    { status: classified.status, headers },
  );
}

/**
 * 429 response for routes that do not use apiError (public proxies with their own
 * response shape). `body` carries the empty success shape the client expects.
 */
export function rateLimitResponse(error: RateLimitError, body: Record<string, unknown> = {}) {
  return NextResponse.json(
    {
      ...body,
      ok: false,
      error: error.publicMessage ?? "Trop de demandes.",
      code: "RATE_LIMITED" satisfies ApiErrorCode,
    },
    {
      status: 429,
      headers: {
        "retry-after": String(error.retryAfterSeconds),
        "cache-control": "no-store",
      },
    },
  );
}

/** Error response for the first-party (non-versioned) API routes. */
export function apiRouteError(
  error: unknown,
  request: Request,
  scope: string,
  options: ApiErrorOptions,
) {
  return apiError(error, createApiRequestContext(request, scope), {
    ...options,
    exposeBusinessMessages: true,
  });
}

export type ClassifiedApiError = {
  code: ApiErrorCode;
  status: number;
  message: string;
  retryAfterSeconds?: number;
};

const STATUS_CODES: Record<number, ApiErrorCode> = {
  401: "AUTH_REQUIRED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  429: "RATE_LIMITED",
};

function codeForStatus(status: number): ApiErrorCode {
  return STATUS_CODES[status] ?? (status >= 500 ? "INTERNAL_ERROR" : "INVALID_REQUEST");
}

/**
 * Maps any thrown value to a status and a client-safe message. The status comes from the error
 * type (see `@/lib/api-errors`), never from its text. Only messages that come from a
 * PublicApiError, or that look like French business messages on first-party routes, are returned
 * verbatim; database, driver and runtime details stay in the logs.
 */
export function classifyApiError(
  error: unknown,
  options: Pick<ApiErrorOptions, "fallbackMessage" | "fallbackStatus" | "exposeBusinessMessages">,
): ClassifiedApiError {
  if (error instanceof RateLimitError) {
    return {
      code: "RATE_LIMITED",
      status: 429,
      message: error.publicMessage ?? "Trop de demandes.",
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }
  if (error instanceof PublicApiError) {
    return {
      code: error.code ?? codeForStatus(error.status),
      status: error.status,
      message: error.message,
    };
  }
  if (error instanceof AuthRequiredError) {
    return { code: "AUTH_REQUIRED", status: 401, message: "Authentification requise." };
  }
  if (error instanceof $ZodError || error instanceof SyntaxError) {
    return { code: "INVALID_REQUEST", status: 400, message: "Requête invalide." };
  }
  if (error instanceof ResponseSchemaViolationError) {
    // The server broke its own published contract: a server fault, logged at error level.
    return { code: "INTERNAL_ERROR", status: 503, message: options.fallbackMessage };
  }
  if (error instanceof ConfigurationError) {
    return {
      code: "CONFIGURATION_ERROR",
      status: 503,
      message: "Service temporairement indisponible.",
    };
  }
  const message = error instanceof Error ? error.message : "";
  if (options.exposeBusinessMessages && isPublicErrorMessage(message)) {
    return { code: "INVALID_REQUEST", status: 400, message };
  }

  const status = options.fallbackStatus ?? 500;
  return { code: codeForStatus(status), status, message: options.fallbackMessage };
}

function logApiCompletion(
  context: ApiRequestContext,
  status: number,
  fields: Record<string, unknown> = {},
): void {
  if (completedRequests.has(context)) return;
  completedRequests.add(context);

  const line = JSON.stringify({
    scope: context.scope,
    requestId: context.requestId,
    timestamp: new Date().toISOString(),
    status,
    durationMs: Date.now() - context.startedAt,
    ...fields,
  });

  if (status >= 500) console.error(line);
  else if (status >= 400) console.warn(line);
  else console.info(line);
}
