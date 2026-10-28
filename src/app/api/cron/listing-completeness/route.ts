import { positiveNumberFromEnv, runMonitoredCron } from "@/lib/cron-jobs";
import { runListingCompletenessBatch } from "@/lib/listing-completeness-batch";

export const maxDuration = 300;

/**
 * Filet quotidien de `vercel.json`. Le passage horaire vient de Supabase `pg_cron` (à :20) : le filet ne
 * fait rien si la tâche a réussi dans les deux dernières heures, et ne sert que si ce chemin est en panne.
 */
const CATCH_UP_SCHEDULE = "50 5 * * *";

export async function GET(request: Request) {
  return runMonitoredCron(
    request,
    "listing-completeness",
    () =>
      runListingCompletenessBatch({
        limit: positiveNumberFromEnv("LISTING_COMPLETENESS_BATCH_LIMIT") ?? 300,
      }),
    { catchUpSchedule: CATCH_UP_SCHEDULE, catchUpSuccessWindowHours: 2 },
  );
}
