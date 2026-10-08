import { NextResponse } from "next/server";

type AdminErrorOptions = {
  fallbackMessage?: string;
  fallbackStatus?: number;
};

/**
 * Keeps the legacy admin route error contract in one place.
 * Authorization failures retain their status while unexpected failures use
 * the route's existing fallback status.
 */
export function adminErrorResponse(
  error: unknown,
  { fallbackMessage = "Erreur admin", fallbackStatus = 400 }: AdminErrorOptions = {},
) {
  const message = error instanceof Error ? error.message : fallbackMessage;
  const status = message.startsWith("Unauthorized")
    ? 401
    : message.startsWith("Forbidden")
      ? 403
      : message.startsWith("NotFound")
        ? 404
        : fallbackStatus;

  return NextResponse.json({ error: message }, { status });
}
