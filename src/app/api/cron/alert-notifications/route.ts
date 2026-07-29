import { dispatchDueAlertNotifications } from "@/lib/alert-notifications";
import { retryFailedCommercialConfirmations } from "@/lib/commercial-acceptance";
import { positiveNumberFromEnv, runMonitoredCron } from "@/lib/cron-jobs";

export async function GET(request: Request) {
  return runMonitoredCron(request, "alert-notifications", async () => {
    const [alerts, commercialConfirmations] = await Promise.all([
      dispatchDueAlertNotifications({
        limit: positiveNumberFromEnv("ALERT_NOTIFICATION_CRON_LIMIT"),
      }),
      retryFailedCommercialConfirmations({
        limit: positiveNumberFromEnv("COMMERCIAL_CONFIRMATION_CRON_LIMIT"),
      }),
    ]);
    return { ...alerts, commercialConfirmations };
  });
}
