import { runMonitoredCron } from "@/lib/cron-jobs";
import { serverEnv } from "@/lib/env";
import { runListingCompletenessBatch } from "@/lib/listing-completeness-batch";

export const maxDuration = 300;

export async function GET(request: Request) {
  return runMonitoredCron(request, "listing-completeness", () =>
    runListingCompletenessBatch({
      limit: serverEnv().batchLimits.listingCompleteness,
    }),
  );
}
