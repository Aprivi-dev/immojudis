import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/** Tâche planifiée `data-retention` : purges de rétention, une erreur de purge fait échouer le passage. */
export async function runDataRetention(now = new Date()): Promise<Record<string, unknown>> {
  const { data, error } = await supabaseAdmin.rpc("run_data_retention", {
    p_now: now.toISOString(),
  });
  if (error) throw new Error(error.message || "Data retention failed.");
  // Each purge is isolated in the database: the others have run and are committed, but a failed
  // one must still fail the monitored job (it stays in the report for the operator).
  const purgeErrors =
    data && typeof data === "object" && !Array.isArray(data) ? data.purge_errors : null;
  if (purgeErrors && typeof purgeErrors === "object" && !Array.isArray(purgeErrors)) {
    const failed = Object.entries(purgeErrors)
      .map(([purge, sqlstate]) => `${purge} (${String(sqlstate)})`)
      .join(", ");
    if (failed) throw new Error(`Data retention: purge failed: ${failed}.`);
  }
  // Journal du préavis de fin d'offre : purge propre, hors run_data_retention.
  const noticePurge = await supabaseAdmin.rpc("purge_launch_offer_end_notices");
  if (noticePurge.error) {
    throw new Error(`Data retention: purge failed: purge_launch_offer_end_notices.`);
  }
  // Journal du pilote automatique de l'agent (5 ans), identités exclues (24 mois), attestations (5 ans) :
  // purge dédiée (migration 20261110230000), run_data_retention n'est pas redéfinie.
  const autopilotPurge = await supabaseAdmin.rpc("purge_information_agent_autopilot");
  if (autopilotPurge.error) {
    throw new Error(`Data retention: purge failed: purge_information_agent_autopilot.`);
  }
  return {
    deleted: {
      ...(data && typeof data === "object" && !Array.isArray(data) ? data : {}),
      launch_offer_end_notices: noticePurge.data ?? 0,
      ...(autopilotPurge.data && typeof autopilotPurge.data === "object"
        ? (autopilotPurge.data as Record<string, number>)
        : {}),
    },
  };
}
