import { positiveNumberFromEnv, runMonitoredCron } from "@/lib/cron-jobs";
import { runSaleValuationPrecomputeBatch } from "@/lib/sale-market-estimates";

export const maxDuration = 300;

export async function GET(request: Request) {
  return runMonitoredCron(request, "precompute-valuations", () =>
    runSaleValuationPrecomputeBatch({
      limit: positiveNumberFromEnv("VALUATION_PRECOMPUTE_BATCH_LIMIT") ?? 75,
    }),
  );
}
