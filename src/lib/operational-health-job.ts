import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { operationalErrorMessage } from "@/lib/monitored-job.server";
import { deliverOperationalAlertNotifications } from "@/lib/operational-alerts";

/** Tâche planifiée `operational-health` : évaluations de santé en base, puis remise des alertes. */
export async function evaluateOperationalHealth(
  now = new Date(),
): Promise<Record<string, unknown>> {
  const args = { p_now: now.toISOString() };
  const results = await Promise.allSettled([
    supabaseAdmin.rpc("evaluate_operational_health", args),
    supabaseAdmin.rpc("evaluate_market_valuation_health", args),
    supabaseAdmin.rpc("observe_autonomous_pipeline", args),
    // Progression de l'agent d'information (mission en envoi, réponse en file, exécution bloquée),
    // évaluation séparée de evaluate_operational_health.
    supabaseAdmin.rpc("evaluate_information_agent_health", args),
  ]);
  // Deliver incidents even when an independent evaluator fails.
  const delivery = await deliverOperationalAlertNotifications();
  const failures = results.flatMap((result) =>
    result.status === "rejected"
      ? [operationalErrorMessage(result.reason)]
      : result.value.error
        ? [result.value.error.message ?? "Health evaluation failed"]
        : [],
  );
  if (!delivery.configured) {
    failures.push("No external operational alert channel is configured.");
  }
  if (delivery.failed > 0) {
    failures.push(`${delivery.failed} external operational alert delivery(ies) failed.`);
  }
  if (failures.length) throw new Error(failures.join("; "));
  const data = results.map((result) =>
    result.status === "fulfilled" ? (result.value.data ?? {}) : {},
  );
  return {
    health: data[0],
    valuation: data[1],
    pipeline: data[2],
    informationAgent: data[3],
    externalAlerts: delivery,
  };
}
