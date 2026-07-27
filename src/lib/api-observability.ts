import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { resolveRequestId } from "@/lib/request-id";

export type ApiErrorCode =
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "INVALID_REQUEST"
  | "RATE_LIMITED"
  | "CONFIGURATION_ERROR"
  | "INTERNAL_ERROR";

export type ApiRequestContext = {
  requestId: string;
  scope: string;
  startedAt: number;
};

type ApiErrorOptions = {
  fallbackMessage: string;
  fallbackStatus?: number;
  headers?: HeadersInit;
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
  const log = JSON.stringify({
    scope: context.scope,
    requestId: context.requestId,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - context.startedAt,
    status: classified.status,
    code: classified.code,
    error: error instanceof Error ? error.message : String(error),
  });
  if (classified.status >= 500) console.error(log);
  else console.warn(log);

  return apiJson(
    {
      ok: false,
      error: classified.message,
      code: classified.code,
      requestId: context.requestId,
    },
    context,
    {
      status: classified.status,
      headers: classified.status === 429 ? options.headers : undefined,
    },
  );
}

function classifyApiError(error: unknown, options: ApiErrorOptions) {
  const message = error instanceof Error ? error.message : "";

  if (message.startsWith("Unauthorized")) {
    return { code: "AUTH_REQUIRED" as const, status: 401, message: "Authentification requise." };
  }
  if (message.startsWith("Trop de demandes") || message.includes("Rate limit")) {
    return { code: "RATE_LIMITED" as const, status: 429, message: "Trop de demandes." };
  }
  if (
    message.includes("réservé") ||
    message.includes("réservée") ||
    message.startsWith("Forbidden")
  ) {
    return { code: "FORBIDDEN" as const, status: 403, message };
  }
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return { code: "INVALID_REQUEST" as const, status: 400, message: "Requête invalide." };
  }
  if (message.toLowerCase().includes("configur")) {
    return {
      code: "CONFIGURATION_ERROR" as const,
      status: 503,
      message: "Service temporairement indisponible.",
    };
  }

  const status = options.fallbackStatus ?? 500;
  return {
    code: (status >= 500 ? "INTERNAL_ERROR" : "INVALID_REQUEST") as ApiErrorCode,
    status,
    message: options.fallbackMessage,
  };
}
