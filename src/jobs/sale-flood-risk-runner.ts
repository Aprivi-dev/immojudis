/**
 * Passe du traitement d'inondation lancée depuis GitHub Actions (`.github/workflows/sale-flood-risk.yml`) : même code
 * que la route `/api/cron/sale-flood-risk` (`runSaleFloodRiskBatch`), mêmes bail, cadence et écritures, supervision
 * dans `operational_job_runs` sous le nom `sale-flood-risk` (lu par `cron.stale`). Géorisques refuse les appels de
 * Vercel depuis le 27/10/2026, pas ceux de GitHub Actions.
 *
 * Construit par esbuild (`npm run flood-risk:build`), puis exécuté par Node avec `SUPABASE_URL` et
 * `SUPABASE_SERVICE_ROLE_KEY`. La sortie ne porte que le résumé de la passe : aucune coordonnée, URL ni réponse.
 */
import { runMonitoredJob } from "@/lib/monitored-job.server";
import { runSaleFloodRiskBatch } from "@/lib/sale-flood-risk-batch";

/** Même taille de lot par défaut que la route ; `SALE_FLOOD_RISK_BATCH_LIMIT` la remplace. */
const DEFAULT_BATCH_LIMIT = 150;

const parsed = Number(process.env.SALE_FLOOD_RISK_BATCH_LIMIT);
const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BATCH_LIMIT;

// Aucune reprise différée, comme la route : la passe suivante reprend ce qui reste.
const outcome = await runMonitoredJob("sale-flood-risk", () => runSaleFloodRiskBatch({ limit }), {
  retryDelaysMs: [],
});
process.exitCode = outcome.ok ? 0 : 1;
