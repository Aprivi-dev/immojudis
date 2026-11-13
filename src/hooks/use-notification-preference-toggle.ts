import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updateNotificationPreferences } from "@/lib/client-api";
import type { NotificationPreferenceUpdateInput } from "@/lib/notification-preferences";
import * as queryKeys from "@/lib/query-keys";
import { toast } from "@/lib/toast";
import { userMessage } from "@/lib/user-messages";

/**
 * Enregistrement d'une préférence depuis une case : relit les préférences et annonce le résultat.
 * Les phrases restent celles de chaque case (`saved`, `failed`).
 */
export function useNotificationPreferenceToggle(
  userId: string,
  messages: { saved: (update: NotificationPreferenceUpdateInput) => string; failed: string },
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateNotificationPreferences,
    onSuccess: (_result, update) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notificationPreferences(userId) });
      toast.success(messages.saved(update));
    },
    onError: (error) => toast.error(userMessage(error, messages.failed)),
  });
}
