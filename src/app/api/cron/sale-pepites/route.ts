import { positiveNumberFromEnv, runMonitoredCron } from "@/lib/cron-jobs";
import { runSalePepitesBatch } from "@/lib/sale-pepites-batch";

export const maxDuration = 300;

/**
 * Filet quotidien de `vercel.json`. Le passage horaire vient de Supabase `pg_cron` (à :35) : le filet ne
 * fait rien si la tâche a réussi dans les deux dernières heures, et ne sert que si ce chemin est en panne.
 */
const CATCH_UP_SCHEDULE = "42 5 * * *";

/**
 * Calcule la pépite des ventes en ligne et la stocke (règle `pepite-v1.1`, voir
 * `src/lib/sale-pepites-batch.ts`). Même protection que les autres routes planifiées : jeton
 * `CRON_SECRET`, supervision par `runMonitoredCron`, reprise sur erreur réseau.
 */
export async function GET(request: Request) {
  // Aucune reprise différée : les pauses de reprise (5 s, 20 s, 60 s) s'ajouteraient au temps de la passe et
  // pourraient dépasser `maxDuration`. La passe suivante (toutes les heures) reprend ce qui reste.
  return runMonitoredCron(
    request,
    "sale-pepites",
    () =>
      runSalePepitesBatch({
        limit: positiveNumberFromEnv("SALE_PEPITES_BATCH_LIMIT") ?? 300,
      }),
    { retryDelaysMs: [], catchUpSchedule: CATCH_UP_SCHEDULE, catchUpSuccessWindowHours: 2 },
  );
}
