import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";

/**
 * Contrôle quotidien du registre des pièces (plan du 11/11/2026, lot R2a ; migration
 * `20261117100500_fact_registry_baselines_and_check.sql`).
 *
 * La base fait tout le travail : `sync_fact_registry_alerts` (sans paramètre) lance le contrôle en
 * lecture seule (`check_fact_registry_consistency`), puis ouvre ou referme une alerte opérationnelle
 * par contrôle (`fact_registry.<contrôle>`), livrée par le canal d'alerte existant à la passe suivante
 * de `operational-health`. Cette tâche ne fournit ni borne, ni rapport, ni détail : elle déclenche,
 * puis résume le rapport rendu dans le journal des exécutions. Le rapport ne porte que des comptes et
 * des identifiants de vente, jamais une valeur.
 */
export const FACT_REGISTRY_CHECKS = [
  "projection_drift",
  "triggers_not_always",
  "column_mismatch",
  "registry_label",
  "echo_suspected",
  "internal_column_copied",
  "events_burst",
  "echo_suppressed",
  "echo_blocked",
  "stale_listing",
] as const;

type FactRegistryCheck = (typeof FACT_REGISTRY_CHECKS)[number];

/** « La fonction n'existe pas » : `PGRST202` (cache du schéma de PostgREST) ou `42883` (PostgreSQL). */
function isMissingFunctionError(error: { code?: string }): boolean {
  return error.code === "PGRST202" || error.code === "42883";
}

function jsonRecord(value: Json | undefined): Record<string, Json | undefined> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/**
 * Lancé par `/api/cron/fact-registry-check` sous `runMonitoredCron`.
 *
 * - Migration pas encore appliquée (code déployé avant elle) : la fonction est absente, la tâche ne
 *   contrôle rien et le dit (`skipped`). Elle n'est attendue par `cron.stale` qu'une fois la migration
 *   `20261117100600` appliquée, donc jamais dans cet état.
 * - Rapport illisible, ou tronqué (plus de ventes que la borne du contrôle) : la tâche échoue. Un
 *   rapport partiel ne passe pas pour un contrôle complet ; la base, de son côté, n'a alors refermé
 *   aucune alerte (elle ne synchronise que les contrôles actifs d'un rapport tronqué).
 */
export async function runFactRegistryCheckJob(): Promise<Record<string, unknown>> {
  const { data, error } = await supabaseAdmin.rpc("sync_fact_registry_alerts");
  if (error) {
    if (isMissingFunctionError(error)) return { skipped: "migration_pending" };
    throw new Error(error.message || "Contrôle du registre des pièces impossible.");
  }

  const report = jsonRecord(data);
  const checks = jsonRecord(report?.checks);
  if (!report || !checks) {
    throw new Error("Contrôle du registre des pièces : rapport illisible.");
  }

  const counts: Record<string, number> = {};
  const raised: FactRegistryCheck[] = [];
  for (const name of FACT_REGISTRY_CHECKS) {
    const check = jsonRecord(checks[name]);
    if (!check || typeof check.active !== "boolean" || typeof check.count !== "number") {
      throw new Error(`Contrôle du registre des pièces : contrôle ${name} absent du rapport.`);
    }
    counts[name] = check.count;
    if (check.active) raised.push(name);
  }

  if (report.truncated !== false) {
    throw new Error(
      "Contrôle du registre des pièces : plus de ventes que la borne du contrôle, rapport partiel.",
    );
  }

  return {
    checkedAt: report.checked_at ?? null,
    salesChecked: report.sales_checked ?? null,
    heldSaleCount: report.held_sale_count ?? null,
    heldFieldCount: report.held_field_count ?? null,
    counts,
    raised,
    alert: raised.length > 0 ? "open" : "clear",
  };
}
