import { NextResponse } from "next/server";
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
    const message = error instanceof Error ? error.message : "Préférences indisponibles";
    const status = message.startsWith("Unauthorized") ? 401 : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
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
    const message = error instanceof Error ? error.message : "Préférences impossibles";
    const status = message.startsWith("Unauthorized") ? 401 : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
