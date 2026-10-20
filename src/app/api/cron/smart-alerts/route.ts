import { positiveNumberFromEnv, runMonitoredCron } from "@/lib/cron-jobs";
import { assertSmartAlertBatchComplete, runSmartAlertEvaluationBatch } from "@/lib/alert-matches";

export const maxDuration = 300;

export async function GET(request: Request) {
  return runMonitoredCron(
    request,
    "smart-alerts",
    async () => {
      const summary = await runSmartAlertEvaluationBatch({
        saleLimit: positiveNumberFromEnv("SMART_ALERT_CRON_SALE_LIMIT"),
      });
      // Des comptes en échec en nombre (20 % ou plus) : le passage échoue et le rattrapage reprend.
      assertSmartAlertBatchComplete(summary);
      return { ...summary };
    },
    { catchUpSchedule: "15 8 * * *" },
  );
}
