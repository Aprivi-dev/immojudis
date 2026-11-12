import { runMonitoredCron } from "@/lib/cron-jobs";
import { serverEnv } from "@/lib/env";
import { runSaleValuationPrecomputeBatch } from "@/lib/sale-market-estimates";

export const maxDuration = 300;

export async function GET(request: Request) {
  return runMonitoredCron(request, "precompute-valuations", () =>
    runSaleValuationPrecomputeBatch({
      limit: serverEnv().batchLimits.valuationPrecompute,
    }),
  );
}
