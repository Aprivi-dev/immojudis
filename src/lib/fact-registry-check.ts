import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";

/**
 * Contrôle quotidien du registre des pièces (plan du 11/11/2026, lots R2a et R2b ; migrations
 * `20261117100500_fact_registry_baselines_and_check.sql` et
 * `20261118100300_fact_registry_check_pages_and_reprojection.sql`).
 *
 * La base fait tout le travail, en deux appels, donc deux transactions :
 *
 * 1. `reproject_fact_registry_drift` (lot R2b) : la relance planifiée de la projection. Fermée par
 *    défaut ; ouverte, elle réapplique des décisions humaines déjà acceptées aux ventes dont la fiche a
 *    dérivé. Ses verrous sont rendus avant que le contrôle ne commence.
 * 2. `sync_fact_registry_alerts` : le contrôle en lecture seule, page par page, puis une alerte
 *    opérationnelle par contrôle (`fact_registry.<contrôle>`), livrée par le canal d'alerte existant à
 *    la passe suivante de `operational-health`.
 *
 * Cette tâche ne fournit ni borne, ni rapport, ni détail : elle déclenche, puis résume dans le journal
 * des exécutions. Le résumé ne porte que des comptes et des codes, jamais une valeur ni un identifiant
 * de vente, et une erreur de la base n'y laisse que son code et son étape, jamais son message.
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

/**
 * Contrôles ajoutés par une migration plus récente que ce code peut l'être : résumés s'ils sont dans
 * le rapport, jamais exigés (le code est déployé avant la migration).
 */
const OPTIONAL_FACT_REGISTRY_CHECKS = ["reprojection_enabled"] as const;

type FactRegistryCheck =
  | (typeof FACT_REGISTRY_CHECKS)[number]
  | (typeof OPTIONAL_FACT_REGISTRY_CHECKS)[number];

type JobStep = "reprojection" | "check";

/** « La fonction n'existe pas » : `PGRST202` (cache du schéma de PostgREST) ou `42883` (PostgreSQL). */
function isMissingFunctionError(error: { code?: string }): boolean {
  return error.code === "PGRST202" || error.code === "42883";
}

function jsonRecord(value: Json | undefined): Record<string, Json | undefined> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/**
 * Erreur de la base : l'étape et le code, rien d'autre. Le message de PostgreSQL peut porter une
 * ligne entière d'une table, et ce texte est recopié dans `operational_job_runs.error_message`.
 */
function databaseError(step: JobStep, error: { code?: string }): Error {
  const code =
    typeof error.code === "string" && /^[A-Za-z0-9]{5,12}$/.test(error.code)
      ? error.code
      : "inconnu";
  return new Error(`Contrôle du registre des pièces : étape ${step}, code ${code}.`);
}

function count(value: Json | undefined): number | null {
  return typeof value === "number" ? value : null;
}

/**
 * Compte rendu de la relance : l'état de l'interrupteur et des comptes. Les ventes en échec sont
 * ramenées à leurs codes (SQLSTATE, contrainte), sans identifiant de vente.
 */
function summarizeReprojection(data: Json | undefined): Record<string, unknown> {
  const report = jsonRecord(data);
  if (!report || typeof report.enabled !== "boolean") {
    throw new Error("Contrôle du registre des pièces : compte rendu de la relance illisible.");
  }
  const failureCodes = new Set<string>();
  for (const failure of Array.isArray(report.failures) ? report.failures : []) {
    const entry = jsonRecord(failure);
    if (!entry || typeof entry.sqlstate !== "string") continue;
    failureCodes.add(
      typeof entry.constraint === "string"
        ? `${entry.sqlstate}:${entry.constraint}`
        : entry.sqlstate,
    );
  }
  return {
    enabled: report.enabled,
    drifted: count(report.drifted),
    applied: count(report.applied),
    busy: count(report.busy),
    failed: count(report.failed),
    bounded: report.bounded === true,
    failureCodes: [...failureCodes].sort(),
  };
}

/**
 * Lancé par `/api/cron/fact-registry-check` sous `runMonitoredCron`.
 *
 * - Migration pas encore appliquée (code déployé avant elle) : une fonction absente ne fait pas échouer
 *   la tâche. Sans la relance (lot R2b non appliqué), le contrôle tourne seul et le résumé le dit ; sans
 *   le contrôle (lot R2a non appliqué), la tâche ne contrôle rien et le dit (`skipped`).
 * - Rapport illisible, ou tronqué (plus de ventes que la borne du contrôle) : la tâche échoue. Un
 *   rapport partiel ne passe pas pour un contrôle complet ; la base, de son côté, n'a alors refermé
 *   aucune alerte (elle ne synchronise que les contrôles actifs d'un rapport tronqué).
 */
export async function runFactRegistryCheckJob(): Promise<Record<string, unknown>> {
  const reprojected = await supabaseAdmin.rpc("reproject_fact_registry_drift");
  let reprojection: Record<string, unknown>;
  if (reprojected.error) {
    if (!isMissingFunctionError(reprojected.error)) {
      throw databaseError("reprojection", reprojected.error);
    }
    reprojection = { skipped: "migration_pending" };
  } else {
    reprojection = summarizeReprojection(reprojected.data);
  }

  const { data, error } = await supabaseAdmin.rpc("sync_fact_registry_alerts");
  if (error) {
    if (isMissingFunctionError(error)) return { skipped: "migration_pending" };
    throw databaseError("check", error);
  }

  const report = jsonRecord(data);
  const checks = jsonRecord(report?.checks);
  if (!report || !checks) {
    throw new Error("Contrôle du registre des pièces : rapport illisible.");
  }

  const counts: Record<string, number> = {};
  const raised: FactRegistryCheck[] = [];
  for (const name of [...FACT_REGISTRY_CHECKS, ...OPTIONAL_FACT_REGISTRY_CHECKS]) {
    const check = jsonRecord(checks[name]);
    if (!check && !FACT_REGISTRY_CHECKS.some((required) => required === name)) continue;
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
    pages: count(report.pages),
    mergeCarried24h: count(jsonRecord(report.merge_carried)?.count),
    counts,
    raised,
    alert: raised.length > 0 ? "open" : "clear",
    reprojection,
  };
}
