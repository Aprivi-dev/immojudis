import { positiveNumberFromEnv, runMonitoredCron } from "@/lib/cron-jobs";
import { runListingCompletenessBatch } from "@/lib/listing-completeness-batch";

export const maxDuration = 300;

export async function GET(request: Request) {
  return runMonitoredCron(request, "listing-completeness", () =>
    runListingCompletenessBatch({
      limit: positiveNumberFromEnv("LISTING_COMPLETENESS_BATCH_LIMIT") ?? 300,
    }),
  );
}
