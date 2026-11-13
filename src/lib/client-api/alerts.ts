import { apiRequest } from "@/lib/client-api-core";
import type {
  AlertNotificationListResponse,
  AlertNotificationSummary,
} from "@/lib/alert-notifications";
import type { PublicAlertEvaluationResponse } from "@/lib/alert-matches";
import type {
  NotificationPreferencesResponse,
  NotificationPreferenceUpdateInput,
} from "@/lib/notification-preferences";
import type { SaleChangeEventListResponse } from "@/lib/sale-change-monitor";

export function evaluateAlertMatches(
  args: {
    saleLimit?: number;
    persist?: boolean;
  } = {},
): Promise<PublicAlertEvaluationResponse> {
  return apiRequest<PublicAlertEvaluationResponse>("/api/alerts/matches", {
    method: "POST",
    body: args,
  });
}

export function fetchAlertNotifications(
  args: {
    limit?: number;
    includeDismissed?: boolean;
    includeQueued?: boolean;
  } = {},
): Promise<AlertNotificationListResponse> {
  const search = new URLSearchParams();
  if (args.limit) search.set("limit", String(args.limit));
  if (args.includeDismissed) search.set("includeDismissed", "true");
  if (args.includeQueued) search.set("includeQueued", "true");
  return apiRequest<AlertNotificationListResponse>(
    `/api/alerts/notifications${search.size ? `?${search.toString()}` : ""}`,
  );
}

export function updateAlertNotification(args: {
  notificationId: string;
  action: "read" | "unread" | "dismiss" | "restore";
}): Promise<{ notification: AlertNotificationSummary }> {
  return apiRequest<{ notification: AlertNotificationSummary }>("/api/alerts/notifications", {
    method: "PATCH",
    body: args,
  });
}

export function fetchSaleChangeEvents(
  args: {
    limit?: number;
    includeDismissed?: boolean;
    saleId?: string;
  } = {},
): Promise<SaleChangeEventListResponse> {
  const search = new URLSearchParams();
  if (args.limit) search.set("limit", String(args.limit));
  if (args.includeDismissed) search.set("includeDismissed", "true");
  if (args.saleId) search.set("saleId", args.saleId);
  return apiRequest<SaleChangeEventListResponse>(
    `/api/sale-change-events${search.size ? `?${search.toString()}` : ""}`,
  );
}

export function fetchNotificationPreferences(): Promise<NotificationPreferencesResponse> {
  return apiRequest<NotificationPreferencesResponse>("/api/notification-preferences");
}

export function updateNotificationPreferences(
  data: NotificationPreferenceUpdateInput,
): Promise<NotificationPreferencesResponse> {
  return apiRequest<NotificationPreferencesResponse>("/api/notification-preferences", {
    method: "PATCH",
    body: data,
  });
}
