import { runMonitoredCron } from "@/lib/cron-jobs";
import { serverEnv } from "@/lib/env";
import { runSaleFloodRiskBatch } from "@/lib/sale-flood-risk-batch";
import {
  dispatchSaleFloodRiskWorkflow,
  saleFloodRiskRunsOnVercel,
} from "@/lib/sale-flood-risk-dispatch.server";

export const maxDuration = 300;

/**
 * Observe le risque d'inondation des ventes à venir et le stocke (voir `src/lib/sale-flood-risk-batch.ts` : TRI
 * `tri_zonage` de Géorisques et périmètre PPRi du Géoportail de l'urbanisme, 2 à 3 appels par seconde, un 429
 * arrête la passe). Alimente la règle `pepite-v2`, qui ne fait elle-même aucun appel réseau. Même protection que
 * les autres routes planifiées : jeton `CRON_SECRET`, supervision par `runMonitoredCron`.
 */
export async function GET(request: Request) {
  if (!saleFloodRiskRunsOnVercel()) {
    // Géorisques refuse les appels de Vercel : la route ne fait que déclencher le workflow GitHub, qui supervise la
    // passe sous le nom `sale-flood-risk`. Le déclenchement a son propre suivi, sans tromper `cron.stale`.
    return runMonitoredCron(
      request,
      "sale-flood-risk-dispatch",
      () => dispatchSaleFloodRiskWorkflow(),
      { catchUpOf: "sale-flood-risk" },
    );
  }
  // Aucune reprise différée : les pauses de reprise (5 s, 20 s, 60 s) s'ajouteraient au temps de la passe et
  // pourraient dépasser `maxDuration`. La passe suivante (toutes les heures) reprend ce qui reste.
  return runMonitoredCron(
    request,
    "sale-flood-risk",
    () => runSaleFloodRiskBatch({ limit: serverEnv().batchLimits.saleFloodRisk }),
    { retryDelaysMs: [] },
  );
}
