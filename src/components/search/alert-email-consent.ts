import type { QueryClient } from "@tanstack/react-query";
import { updateNotificationPreferences } from "@/lib/client-api";
import { queryKeys } from "@/lib/query-keys";

/**
 * Records the explicit, unticked-by-default consent given while creating an alert
 * (« Recevoir un email récapitulatif chaque semaine »). The alert is already saved when this
 * runs, so a failure must not undo it: it returns `false` and the caller says so.
 */
export async function enableAlertEmailRecap(
  queryClient: QueryClient,
  userId: string,
): Promise<boolean> {
  try {
    await updateNotificationPreferences({
      alertEmailEnabled: true,
      consentSource: "alert_creation",
    });
    void queryClient.invalidateQueries({ queryKey: queryKeys.notificationPreferences(userId) });
    return true;
  } catch {
    return false;
  }
}
