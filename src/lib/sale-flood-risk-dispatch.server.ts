import "server-only";
import { serverEnv } from "@/lib/env";

/** Workflow GitHub qui observe le risque d'inondation (voir `.github/workflows/sale-flood-risk.yml`). */
export const SALE_FLOOD_RISK_WORKFLOW = "sale-flood-risk.yml";

/**
 * Le traitement d'inondation tourne-t-il dans la route de Vercel ? Non par défaut : depuis le 27/10/2026, Géorisques
 * coupe les connexions venant de Vercel (`ECONNRESET`) ; les appels partent donc de GitHub Actions.
 * `SALE_FLOOD_RISK_RUNNER=vercel` revient aux appels depuis la route.
 */
export function saleFloodRiskRunsOnVercel(): boolean {
  return serverEnv().saleFloodRisk.runner?.toLowerCase() === "vercel";
}

/**
 * Déclenche une passe du workflow d'inondation (`workflow_dispatch`, même jeton que le pipeline). La passe elle-même
 * est supervisée par le workflow (`operational_job_runs`, tâche `sale-flood-risk`) : la route ne fait que déclencher.
 */
export async function dispatchSaleFloodRiskWorkflow(
  fetcher: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const { githubToken: token, repository, ref } = serverEnv().pipeline;
  if (!token)
    throw new Error("Jeton de déclenchement GitHub absent : traitement d'inondation non déclenché");
  const response = await fetcher(
    `https://api.github.com/repos/${repository}/actions/workflows/${SALE_FLOOD_RISK_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref }),
      signal: AbortSignal.timeout(12_000),
    },
  );
  // Seul le statut remonte : la réponse de GitHub n'est pas journalisée.
  if (!response.ok) {
    throw new Error(`Déclenchement du workflow d'inondation refusé : HTTP ${response.status}`);
  }
  return { dispatched: true, workflow: SALE_FLOOD_RISK_WORKFLOW, ref };
}
