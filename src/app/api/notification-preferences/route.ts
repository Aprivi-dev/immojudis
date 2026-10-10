import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  getNotificationPreferences,
  notificationPreferenceUpdateSchema,
  updateNotificationPreferences,
} from "@/lib/notification-preferences";

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const response = await getNotificationPreferences({ auth });
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiRouteError(error, request, "notification-preferences", {
      fallbackMessage: "Préférences indisponibles",
    });
  }
}

export async function PATCH(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = notificationPreferenceUpdateSchema.parse(await request.json());
    const response = await updateNotificationPreferences({ auth, input });
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiRouteError(error, request, "notification-preferences", {
      fallbackMessage: "Préférences impossibles",
    });
  }
}
