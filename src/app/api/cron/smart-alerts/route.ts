import { positiveNumberFromEnv, runMonitoredCron } from "@/lib/cron-jobs";
import { runSmartAlertEvaluationBatch } from "@/lib/alert-matches";

export async function GET(request: Request) {
  return runMonitoredCron(request, "smart-alerts", () =>
    runSmartAlertEvaluationBatch({
      userLimit: positiveNumberFromEnv("SMART_ALERT_CRON_USER_LIMIT"),
      saleLimit: positiveNumberFromEnv("SMART_ALERT_CRON_SALE_LIMIT"),
    }),
  );
}
