import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  listSaleChangeEvents,
  monitorUserSaleChanges,
  saleChangeEventActionSchema,
  updateSaleChangeEventState,
} from "@/lib/sale-change-monitor";

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const response = await listSaleChangeEvents({
      auth,
      limit: Number(url.searchParams.get("limit") ?? 80),
      includeDismissed: url.searchParams.get("includeDismissed") === "true",
    });

    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Changements indisponibles";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("réservé")
        ? 403
        : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const response = await monitorUserSaleChanges({ auth });

    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Monitoring des changements impossible";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("réservé")
        ? 403
        : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

export async function PATCH(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = saleChangeEventActionSchema.parse(await request.json());
    const response = await updateSaleChangeEventState({
      auth,
      eventId: input.eventId,
      action: input.action,
    });

    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Changement impossible";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("réservé")
        ? 403
        : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
