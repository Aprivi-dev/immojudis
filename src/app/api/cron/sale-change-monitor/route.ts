import { positiveNumberFromEnv, runMonitoredCron } from "@/lib/cron-jobs";
import { runSaleChangeMonitorBatch } from "@/lib/sale-change-monitor";

export async function GET(request: Request) {
  return runMonitoredCron(request, "sale-change-monitor", () =>
    runSaleChangeMonitorBatch({
      userLimit: positiveNumberFromEnv("SALE_CHANGE_CRON_USER_LIMIT"),
    }),
  );
}
