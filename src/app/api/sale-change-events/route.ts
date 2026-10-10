import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
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
    return apiRouteError(error, request, "sale-change-events", {
      fallbackMessage: "Changements indisponibles",
    });
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
    return apiRouteError(error, request, "sale-change-events", {
      fallbackMessage: "Monitoring des changements impossible",
    });
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
    return apiRouteError(error, request, "sale-change-events", {
      fallbackMessage: "Changement impossible",
    });
  }
}
