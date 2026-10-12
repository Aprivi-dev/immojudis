import { authHeaders, readJson } from "@/lib/client-api-core";
import type {
  AlertNotificationListResponse,
  AlertNotificationSummary,
} from "@/lib/alert-notifications";
import type { AlertEvaluationResponse, AlertMatchSummary } from "@/lib/alert-matches";
import type {
  NotificationPreferencesResponse,
  NotificationPreferenceUpdateInput,
} from "@/lib/notification-preferences";
import type {
  SaleChangeEventListResponse,
  SaleChangeEventSummary,
  SaleChangeMonitorResponse,
} from "@/lib/sale-change-monitor";

export async function fetchAlertMatches(
  args: {
    limit?: number;
    includeDismissed?: boolean;
  } = {},
): Promise<{ matches: AlertMatchSummary[] }> {
  const search = new URLSearchParams();
  if (args.limit) search.set("limit", String(args.limit));
  if (args.includeDismissed) search.set("includeDismissed", "true");
  const response = await fetch(`/api/alerts/matches${search.size ? `?${search.toString()}` : ""}`, {
    headers: await authHeaders(),
  });

  return readJson<{ matches: AlertMatchSummary[] }>(response);
}

export async function evaluateAlertMatches(
  args: {
    saleLimit?: number;
    persist?: boolean;
  } = {},
): Promise<AlertEvaluationResponse> {
  const response = await fetch("/api/alerts/matches", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args),
  });

  return readJson<AlertEvaluationResponse>(response);
}

export async function fetchAlertNotifications(
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

  const response = await fetch(
    `/api/alerts/notifications${search.size ? `?${search.toString()}` : ""}`,
    {
      headers: await authHeaders(),
    },
  );

  return readJson<AlertNotificationListResponse>(response);
}

export async function updateAlertNotification(args: {
  notificationId: string;
  action: "read" | "unread" | "dismiss" | "restore";
}): Promise<{ notification: AlertNotificationSummary }> {
  const response = await fetch("/api/alerts/notifications", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args),
  });

  return readJson<{ notification: AlertNotificationSummary }>(response);
}

export async function fetchSaleChangeEvents(
  args: {
    limit?: number;
    includeDismissed?: boolean;
  } = {},
): Promise<SaleChangeEventListResponse> {
  const search = new URLSearchParams();
  if (args.limit) search.set("limit", String(args.limit));
  if (args.includeDismissed) search.set("includeDismissed", "true");
  const response = await fetch(
    `/api/sale-change-events${search.size ? `?${search.toString()}` : ""}`,
    {
      headers: await authHeaders(),
    },
  );

  return readJson<SaleChangeEventListResponse>(response);
}

export async function monitorSaleChanges(): Promise<SaleChangeMonitorResponse> {
  const response = await fetch("/api/sale-change-events", {
    method: "POST",
    headers: await authHeaders(),
  });

  return readJson<SaleChangeMonitorResponse>(response);
}

export async function updateSaleChangeEvent(args: {
  eventId: string;
  action: "read" | "unread" | "dismiss" | "restore";
}): Promise<{ event: SaleChangeEventSummary }> {
  const response = await fetch("/api/sale-change-events", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args),
  });

  return readJson<{ event: SaleChangeEventSummary }>(response);
}

export async function fetchNotificationPreferences(): Promise<NotificationPreferencesResponse> {
  const response = await fetch("/api/notification-preferences", {
    headers: await authHeaders(),
  });

  return readJson<NotificationPreferencesResponse>(response);
}

export async function updateNotificationPreferences(
  data: NotificationPreferenceUpdateInput,
): Promise<NotificationPreferencesResponse> {
  const response = await fetch("/api/notification-preferences", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(data),
  });

  return readJson<NotificationPreferencesResponse>(response);
}
