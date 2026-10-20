import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { errorDetailForLog } from "@/lib/api-errors";
import { apiJson, createApiRequestContext } from "@/lib/api-observability";
import { buildHealthReport, unavailableHealthReport } from "@/lib/health-status";

// Une sonde externe l'appelle toutes les quelques minutes : jamais servie d'un cache.
export const dynamic = "force-dynamic";

/**
 * Supervision indépendante : `ok` ou `degraded`, avec l'âge du dernier succès de `operational-health`
 * (dégradé au-delà de 45 min) et de la dernière collecte réussie (dégradé au-delà de 18 h). Publique
 * et sans détail sensible (voir `src/lib/health-status.ts`) ; 200 quand tout va bien, 503 sinon pour
 * qu'une sonde HTTP ordinaire s'en aperçoive. Voir docs/operations/supervision-externe.md.
 */
export async function GET(request: Request) {
  const context = createApiRequestContext(request, "api.health");
  const now = new Date();
  try {
    const [health, collection] = await Promise.all([
      supabaseAdmin
        .from("operational_job_runs")
        .select("finished_at")
        .eq("job_name", "operational-health")
        .eq("status", "success")
        .not("finished_at", "is", null)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from("auction_source_state")
        .select("last_publication_complete_at")
        .not("last_publication_complete_at", "is", null)
        .order("last_publication_complete_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (health.error) throw health.error;
    if (collection.error) throw collection.error;

    const report = buildHealthReport({
      now,
      lastOperationalHealthSuccessAt: health.data?.finished_at ?? null,
      lastCollectionAt: collection.data?.last_publication_complete_at ?? null,
    });
    return apiJson(report, context, { status: report.status === "ok" ? 200 : 503 });
  } catch (error) {
    // Le détail reste dans le journal (`api.health`), jamais dans la réponse publique.
    console.error(
      JSON.stringify({
        scope: "api.health",
        requestId: context.requestId,
        error: errorDetailForLog(error),
      }),
    );
    return apiJson(unavailableHealthReport(now), context, { status: 503 });
  }
}
