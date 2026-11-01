import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  alertNotificationUpdateSchema as notificationUpdateSchema,
  listAlertNotifications,
  updateAlertNotificationState,
} from "@/lib/alert-notifications";

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const includeDismissed = url.searchParams.get("includeDismissed") === "true";
    const includeQueued = url.searchParams.get("includeQueued") === "true";
    const response = await listAlertNotifications({
      auth,
      limit,
      includeDismissed,
      includeQueued,
    });

    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiRouteError(error, request, "alerts.notifications", {
      fallbackMessage: "Notifications indisponibles",
    });
  }
}

export async function PATCH(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    // Une action inconnue est refusée (400) : elle ne doit jamais retomber sur une action par défaut.
    const body = notificationUpdateSchema.parse(await request.json());
    const response = await updateAlertNotificationState({
      auth,
      notificationId: body.notificationId,
      action: body.action,
    });

    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiRouteError(error, request, "alerts.notifications", {
      fallbackMessage: "Notification impossible",
    });
  }
}
