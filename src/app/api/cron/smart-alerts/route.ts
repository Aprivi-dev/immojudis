import { positiveNumberFromEnv, runMonitoredCron } from "@/lib/cron-jobs";
import { runSmartAlertEvaluationBatch } from "@/lib/alert-matches";

export const maxDuration = 300;

export async function GET(request: Request) {
  return runMonitoredCron(
    request,
    "smart-alerts",
    () =>
      runSmartAlertEvaluationBatch({
        saleLimit: positiveNumberFromEnv("SMART_ALERT_CRON_SALE_LIMIT"),
      }),
    { catchUpSchedule: "15 8 * * *" },
  );
}
