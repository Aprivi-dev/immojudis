import { dispatchDueAlertNotifications } from "@/lib/alert-notifications";
import { positiveNumberFromEnv, runMonitoredCron } from "@/lib/cron-jobs";

export async function GET(request: Request) {
  return runMonitoredCron(request, "alert-notifications", () =>
    dispatchDueAlertNotifications({
      limit: positiveNumberFromEnv("ALERT_NOTIFICATION_CRON_LIMIT"),
    }),
  );
}
