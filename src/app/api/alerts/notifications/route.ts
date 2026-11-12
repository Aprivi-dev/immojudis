import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  alertNotificationUpdateSchema as notificationUpdateSchema,
  listAlertNotifications,
  updateAlertNotificationState,
} from "@/lib/alert-notifications";

export const GET = apiRoute(
  { scope: "api.alerts.notifications.list", fallbackMessage: "Notifications indisponibles" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const includeDismissed = url.searchParams.get("includeDismissed") === "true";
    const includeQueued = url.searchParams.get("includeQueued") === "true";
    return listAlertNotifications({ auth, limit, includeDismissed, includeQueued });
  },
);

export const PATCH = apiRoute(
  { scope: "api.alerts.notifications.update", fallbackMessage: "Notification impossible" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    // Une action inconnue est refusée (400) : elle ne doit jamais retomber sur une action par défaut.
    const body = notificationUpdateSchema.parse(await request.json());
    return updateAlertNotificationState({
      auth,
      notificationId: body.notificationId,
      action: body.action,
    });
  },
);
