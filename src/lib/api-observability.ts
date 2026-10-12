import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { PublicApiError, RateLimitError, isPublicErrorMessage } from "@/lib/api-errors";
import { resolveRequestId } from "@/lib/request-id";

export type ApiErrorCode =
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_REQUEST"
  | "RATE_LIMITED"
  | "CONFIGURATION_ERROR"
  | "INTERNAL_ERROR";

export type ApiRequestContext = {
  requestId: string;
  scope: string;
  startedAt: number;
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
   * Return short French business messages ("Vente introuvable.") verbatim and map
   * "introuvable" to 404. Enabled by `apiRouteError`; the versioned /api/v1 routes keep
   * their historical generic fallbacks.
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

export function withApiHeaders<T extends Response>(response: T, context: ApiRequestContext): T {
  response.headers.set("x-request-id", context.requestId);
  if (!response.headers.has("cache-control")) response.headers.set("cache-control", "no-store");
  logApiCompletion(context, response.status);
  return response;
}

export function apiJson<T>(
  body: T,
  context: ApiRequestContext,
  init?: ResponseInit,
): NextResponse<T> {
  return withApiHeaders(NextResponse.json(body, init), context);
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
    { ...body, ok: false, error: "Trop de demandes.", code: "RATE_LIMITED" satisfies ApiErrorCode },
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

/**
 * Maps any thrown value to a status and a client-safe message. Only messages that
 * look like French business messages (or come from a PublicApiError) are returned
 * verbatim; database, driver and runtime details stay in the logs.
 */
export function classifyApiError(
  error: unknown,
  options: Pick<ApiErrorOptions, "fallbackMessage" | "fallbackStatus" | "exposeBusinessMessages">,
): ClassifiedApiError {
  const message = error instanceof Error ? error.message : "";

  if (error instanceof RateLimitError) {
    return {
      code: "RATE_LIMITED",
      status: 429,
      message: "Trop de demandes.",
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }
  if (error instanceof PublicApiError) {
    return {
      code:
        error.status === 404
          ? "NOT_FOUND"
          : error.status === 403
            ? "FORBIDDEN"
            : error.status === 409
              ? "CONFLICT"
              : "INVALID_REQUEST",
      status: error.status,
      message: error.message,
    };
  }
  if (message.startsWith("Unauthorized")) {
    return { code: "AUTH_REQUIRED", status: 401, message: "Authentification requise." };
  }
  if (message.startsWith("Trop de demandes") || message.includes("Rate limit")) {
    return {
      code: "RATE_LIMITED",
      status: 429,
      message: "Trop de demandes.",
      retryAfterSeconds: 60,
    };
  }
  if (
    message.includes("réservé") ||
    message.includes("réservée") ||
    message.startsWith("Forbidden") ||
    /^Limite de \d+/.test(message)
  ) {
    return {
      code: "FORBIDDEN",
      status: 403,
      message: isPublicErrorMessage(message) ? message : "Accès refusé.",
    };
  }
  if (
    message.startsWith("NotFound") ||
    (options.exposeBusinessMessages &&
      /introuvable/i.test(message) &&
      isPublicErrorMessage(message))
  ) {
    return {
      code: "NOT_FOUND",
      status: 404,
      message: isPublicErrorMessage(message) ? message : "Ressource introuvable.",
    };
  }
  if (
    error instanceof ZodError ||
    error instanceof SyntaxError ||
    message.startsWith("Requête invalide")
  ) {
    return {
      code: "INVALID_REQUEST",
      status: 400,
      message: message.startsWith("Requête invalide") ? message : "Requête invalide.",
    };
  }
  if (message.toLowerCase().includes("configur")) {
    return {
      code: "CONFIGURATION_ERROR",
      status: 503,
      message: "Service temporairement indisponible.",
    };
  }
  if (options.exposeBusinessMessages && isPublicErrorMessage(message)) {
    return { code: "INVALID_REQUEST", status: 400, message };
  }

  const status = options.fallbackStatus ?? 500;
  return {
    code: status >= 500 ? "INTERNAL_ERROR" : "INVALID_REQUEST",
    status,
    message: options.fallbackMessage,
  };
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
