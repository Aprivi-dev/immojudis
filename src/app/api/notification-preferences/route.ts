import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  getNotificationPreferences,
  notificationPreferenceUpdateSchema,
  updateNotificationPreferences,
} from "@/lib/notification-preferences";

export const GET = apiRoute(
  { scope: "api.notification-preferences.read", fallbackMessage: "Préférences indisponibles" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    return getNotificationPreferences({ auth });
  },
);

export const PATCH = apiRoute(
  { scope: "api.notification-preferences.update", fallbackMessage: "Préférences impossibles" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = notificationPreferenceUpdateSchema.parse(await request.json());
    return updateNotificationPreferences({ auth, input });
  },
);
