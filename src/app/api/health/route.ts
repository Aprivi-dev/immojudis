import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { errorDetailForLog } from "@/lib/api-errors";
import { apiJson, createApiRequestContext } from "@/lib/api-observability";
import { asRecord } from "@/lib/guards";
import {
  HEALTH_CACHE_SECONDS,
  buildHealthReport,
  unavailableHealthReport,
} from "@/lib/health-status";

// Le contenu est calculé à chaque appel qui atteint la fonction ; c'est le CDN qui limite le nombre
// d'appels (`Cache-Control: public, s-maxage=30`), pas un cache de Next.
export const dynamic = "force-dynamic";

/**
 * Supervision indépendante, en deux niveaux. Disponibilité : 200 tant que le site et la base répondent
 * (`available: true`), 503 seulement quand la base ne répond pas. Fraîcheur : `status` vaut `ok` ou
 * `degraded` dans le corps, avec l'âge du dernier succès de `operational-health` (dégradé au-delà de
 * 45 min) et l'état de la collecte des sources ACTIVÉES (dégradé quand l'une d'elles n'a pas de
 * publication complète depuis plus de 36 h, ou n'en a jamais eu) : un retard de collecte ne rend plus la
 * route 503 en permanence. `scheduledJobs` donne le nombre de tâches planifiées en retard (alerte `cron.stale`),
 * sans nom : il distingue la panne d'une tâche du retard ancien d'une source. Publique et sans détail sensible (voir `src/lib/health-status.ts`). Voir
 * docs/operations/supervision-externe.md.
 *
 * La route est publique : le CDN garde la réponse 30 s (`s-maxage`), ce qui borne les lectures de la
 * base quel que soit le nombre d'appelants (un appelant qui ajoute un paramètre d'adresse contourne le
 * cache, au prix de deux lectures indexées). Une erreur n'est jamais mise en cache, et l'identifiant de
 * requête n'est pas répercuté (la réponse gardée serait servie à d'autres appelants avec celui du
 * premier ; il reste dans le journal).
 */
export async function GET(request: Request) {
  const context = createApiRequestContext(request, "api.health");
  const now = new Date();
  try {
    const [health, sources, staleJobs] = await Promise.all([
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
        .eq("enabled", true),
      // Les tâches planifiées en retard : l'alerte `cron.stale` (même liste que l'alerte, SQL), son nombre seul.
      supabaseAdmin
        .from("operational_alerts")
        .select("details")
        .eq("alert_key", "cron.stale")
        .eq("status", "open")
        .maybeSingle(),
    ]);
    if (health.error) throw health.error;
    if (sources.error) throw sources.error;
    if (staleJobs.error) throw staleJobs.error;
    const staleJobCount = asRecord(staleJobs.data?.details).stale_job_count;

    const report = buildHealthReport({
      now,
      lastOperationalHealthSuccessAt: health.data?.finished_at ?? null,
      enabledSourceCompletions: (sources.data ?? []).map((row) => row.last_publication_complete_at),
      // Alerte ouverte sans nombre lisible : au moins une tâche en retard.
      staleCronJobCount: staleJobs.data
        ? typeof staleJobCount === "number"
          ? staleJobCount
          : 1
        : 0,
    });
    return apiJson(
      report,
      context,
      {
        // Disponibilité et fraîcheur sont séparées : la base répond, donc 200, même quand une tâche
        // ou une source est en retard (`status: "degraded"` et les âges sont dans le corps).
        status: 200,
        headers: { "cache-control": `public, s-maxage=${HEALTH_CACHE_SECONDS}` },
      },
      { echoRequestId: false },
    );
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
