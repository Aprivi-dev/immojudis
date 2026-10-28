import { runMonitoredCron } from "@/lib/cron-jobs";
import { serverEnv } from "@/lib/env";
import { runSaleFloodRiskBatch } from "@/lib/sale-flood-risk-batch";
import {
  dispatchSaleFloodRiskWorkflow,
  saleFloodRiskRunsOnVercel,
} from "@/lib/sale-flood-risk-dispatch.server";

export const maxDuration = 300;

/** Taille de lot par défaut (ventes observées par passe) ; `SALE_FLOOD_RISK_BATCH_LIMIT` la remplace. */
const DEFAULT_BATCH_LIMIT = 150;

/**
 * Filet quotidien de `vercel.json`. Le passage horaire vient de Supabase `pg_cron` (à :25) : le filet ne
 * fait rien si la passe a réussi dans les deux dernières heures (sous le nom `sale-flood-risk`, que le
 * workflow GitHub écrit), et n'occupe donc GitHub Actions que si ce chemin est en panne.
 */
const CATCH_UP = {
  catchUpSchedule: "35 5 * * *",
  catchUpSuccessWindowHours: 2,
  catchUpSuccessJobName: "sale-flood-risk",
};

/** La taille de lot de l'environnement (circuit commun `serverEnv`), ou la valeur par défaut. */
function batchLimit(): number {
  const parsed = Number(serverEnv().saleFloodRisk.batchLimit);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BATCH_LIMIT;
}

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
      CATCH_UP,
    );
  }
  // Aucune reprise différée : les pauses de reprise (5 s, 20 s, 60 s) s'ajouteraient au temps de la passe et
  // pourraient dépasser `maxDuration`. La passe suivante (toutes les heures) reprend ce qui reste.
  return runMonitoredCron(
    request,
    "sale-flood-risk",
    () => runSaleFloodRiskBatch({ limit: batchLimit() }),
    { retryDelaysMs: [], ...CATCH_UP },
  );
}
