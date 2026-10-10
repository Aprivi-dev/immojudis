import { NextResponse } from "next/server";
import { classifyApiError } from "@/lib/api-observability";
import { resolveRequestId } from "@/lib/request-id";

type AdminErrorOptions = {
  fallbackMessage?: string;
  fallbackStatus?: number;
  /** Correlation id of the request, so support can find the logged detail. */
  requestId?: string | null;
};

/**
 * Keeps the admin route error contract in one place. Authorization failures keep
 * their status; the response carries a generic French message and a requestId, and
 * the underlying detail is written to the server logs only.
 */
export function adminErrorResponse(
  error: unknown,
  {
    fallbackMessage = "Erreur admin",
    fallbackStatus = 400,
    requestId = null,
  }: AdminErrorOptions = {},
) {
  const classified = classifyApiError(error, {
    fallbackMessage,
    fallbackStatus,
    exposeBusinessMessages: true,
  });
  const id = resolveRequestId(requestId);

  console[classified.status >= 500 ? "error" : "warn"](
    JSON.stringify({
      scope: "admin.api",
      requestId: id,
      status: classified.status,
      code: classified.code,
      error: error instanceof Error ? error.message : String(error),
    }),
  );

  return NextResponse.json(
    { error: classified.message, code: classified.code, requestId: id },
    {
      status: classified.status,
      headers: {
        "x-request-id": id,
        "cache-control": "no-store",
        ...(classified.retryAfterSeconds
          ? { "retry-after": String(classified.retryAfterSeconds) }
          : {}),
      },
    },
  );
}
