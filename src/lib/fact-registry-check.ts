import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { DEFAULT_RETRY_DELAYS_MS, TransientJobError } from "@/lib/monitored-job.server";

/**
 * Contrôle quotidien du registre des pièces (plan du 11/11/2026, lots R2a et R2b ; migrations
 * `20261117100500_fact_registry_baselines_and_check.sql` et
 * `20261118100300_fact_registry_check_pages_and_reprojection.sql`).
 *
 * La base fait tout le travail, un appel par transaction :
 *
 * 1. `reproject_fact_registry_drift` (lot R2b) : la relance planifiée de la projection. Fermée par
 *    défaut ; ouverte, elle réapplique des décisions humaines déjà acceptées aux ventes dont la fiche a
 *    dérivé, 30 ventes par passe. Les passes s'enchaînent tant que la base dit qu'il en reste et que le
 *    temps le permet ; les verrous de chacune sont rendus avant la suivante, et avant le contrôle.
 * 2. `sync_fact_registry_alerts` : le contrôle en lecture seule, page par page, puis une alerte
 *    opérationnelle par contrôle (`fact_registry.<contrôle>`), livrée par le canal d'alerte existant à
 *    la passe suivante de `operational-health`. Il tourne toujours, même après une relance en échec :
 *    c'est lui qui dit l'état du registre.
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
const OPTIONAL_FACT_REGISTRY_CHECKS = [
  "reprojection_enabled",
  "final_decisions",
  "final_decisions_over_limit",
] as const;

type FactRegistryCheck =
  | (typeof FACT_REGISTRY_CHECKS)[number]
  | (typeof OPTIONAL_FACT_REGISTRY_CHECKS)[number];

type JobStep = "reprojection" | "check";

/**
 * Une nouvelle passe de relance ne part que dans ce délai après le début de la tâche. La route dure au
 * plus 300 s ; une passe et le contrôle sont bornés chacun à 120 s par la base : 300 - 120 (une passe
 * en cours) - 120 (le contrôle) laisse 60 s, dont 15 de marge.
 */
export const REPROJECTION_PASS_START_BUDGET_MS = 45_000;

/** Durée maximale de la route (`maxDuration` de `/api/cron/fact-registry-check`, qui veut un littéral). */
const ROUTE_MAX_DURATION_MS = 300_000;
/** Une tentative lancée hors du délai des passes : une passe (120 s) puis le contrôle (120 s). */
const LATE_ATTEMPT_MAX_MS = 240_000;
const RETRY_MARGIN_MS = 5_000;

/**
 * Une exécution de la tâche, reprises comprises : son début et le nombre de tentatives. La route la crée une
 * fois ; `runMonitoredCron` rappelle la tâche avec la même à chaque reprise.
 */
export type FactRegistryCheckRun = { startedAt: number; attempts: number };

/**
 * Reste-t-il la place d'une tentative entière avant la coupure de la route ? Il faut attendre le délai de la
 * prochaine reprise de `runMonitoredCron`, puis une passe et le contrôle. Au-delà, la plateforme couperait la
 * tâche : l'exécution resterait « running » et son erreur ne serait jamais enregistrée.
 */
function hasRoomForRetry(run: FactRegistryCheckRun): boolean {
  const wait = DEFAULT_RETRY_DELAYS_MS[run.attempts - 1];
  return (
    wait !== undefined &&
    Date.now() - run.startedAt + wait + LATE_ATTEMPT_MAX_MS <=
      ROUTE_MAX_DURATION_MS - RETRY_MARGIN_MS
  );
}

/** Erreur de la base qui vaut d'être retentée, d'après son code seul. */
class RetryableDatabaseError extends Error {}

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
 * La panne passagère se reconnaît au CODE SEUL, jamais au texte : une erreur sans code est une panne de
 * réseau ; `40001` et `40P01` (conflit, interblocage) passent à la tentative suivante. Le délai d'instruction
 * (`57014`) n'en est pas une : rejouer une tâche qui a déjà pris 120 s dépasserait la durée de la route.
 */
function databaseError(step: JobStep, error: { code?: string }): Error {
  const code =
    typeof error.code === "string" && /^[A-Za-z0-9]{5,12}$/.test(error.code)
      ? error.code
      : "inconnu";
  const message = `Contrôle du registre des pièces : étape ${step}, code ${code}.`;
  return !error.code || error.code === "40001" || error.code === "40P01"
    ? new RetryableDatabaseError(message)
    : new Error(message);
}

function count(value: Json | undefined): number | null {
  return typeof value === "number" ? value : null;
}

/** Codes des ventes en échec (SQLSTATE, contrainte s'il y en a une), sans identifiant de vente. */
function failureCodes(failures: Json | undefined): string[] {
  const codes: string[] = [];
  for (const failure of Array.isArray(failures) ? failures : []) {
    const entry = jsonRecord(failure);
    if (!entry || typeof entry.sqlstate !== "string") continue;
    codes.push(
      typeof entry.constraint === "string"
        ? `${entry.sqlstate}:${entry.constraint}`
        : entry.sqlstate,
    );
  }
  return codes;
}

type StepOutcome =
  | { summary: Record<string, unknown> }
  | { skipped: "migration_pending" }
  | { error: unknown };

/**
 * La relance, passe après passe. Résumé : l'état de l'interrupteur, le nombre de passes, les ventes en
 * dérive vues par la première, les ventes écrites en tout, et l'état laissé par la dernière (occupées,
 * en échec, travail restant).
 */
async function runReprojection(startedAt: number): Promise<StepOutcome> {
  const codes = new Set<string>();
  let passes = 0;
  let applied = 0;
  let drifted: number | null = null;
  for (;;) {
    const { data, error } = await supabaseAdmin.rpc("reproject_fact_registry_drift");
    if (error) {
      if (passes === 0 && isMissingFunctionError(error)) return { skipped: "migration_pending" };
      throw databaseError("reprojection", error);
    }
    const report = jsonRecord(data);
    if (!report || typeof report.enabled !== "boolean") {
      throw new Error("Contrôle du registre des pièces : compte rendu de la relance illisible.");
    }
    passes += 1;
    const passApplied = count(report.applied) ?? 0;
    applied += passApplied;
    if (passes === 1) drifted = count(report.drifted);
    for (const code of failureCodes(report.failures)) codes.add(code);
    const bounded = report.bounded === true;
    // Une passe qui n'a rien écrit (ventes occupées) ne ferait pas mieux tout de suite.
    if (
      !bounded ||
      passApplied === 0 ||
      Date.now() - startedAt >= REPROJECTION_PASS_START_BUDGET_MS
    ) {
      return {
        summary: {
          enabled: report.enabled,
          passes,
          drifted,
          applied,
          busy: count(report.busy),
          failed: count(report.failed),
          bounded,
          failureCodes: [...codes].sort(),
        },
      };
    }
  }
}

async function runCheck(): Promise<StepOutcome> {
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
    summary: {
      checkedAt: report.checked_at ?? null,
      salesChecked: report.sales_checked ?? null,
      heldSaleCount: report.held_sale_count ?? null,
      heldFieldCount: report.held_field_count ?? null,
      pages: count(report.pages),
      mergeCarried24h: count(jsonRecord(report.merge_carried)?.count),
      decisionsSecondFactorRequired:
        typeof report.decisions_second_factor_required === "boolean"
          ? report.decisions_second_factor_required
          : null,
      simulationFailureCodes: [...new Set(failureCodes(report.simulation_failures))].sort(),
      counts,
      raised,
      alert: raised.length > 0 ? "open" : "clear",
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Contrôle du registre des pièces : erreur inconnue.";
}

/** Ce que le contrôle a donné, pour le message d'une tâche que la relance fait échouer. */
function checkOutcomeText(check: StepOutcome): string {
  if ("error" in check) return errorMessage(check.error);
  if ("skipped" in check) return "Contrôle non lancé : migration en attente.";
  const raised = check.summary.raised as FactRegistryCheck[];
  return raised.length > 0
    ? `Contrôle fait ensuite : ${raised.length} contrôle(s) levé(s) (${raised.join(", ")}).`
    : "Contrôle fait ensuite : aucun contrôle levé.";
}

/**
 * Lancé par `/api/cron/fact-registry-check` sous `runMonitoredCron`.
 *
 * - Migration pas encore appliquée (code déployé avant elle) : une fonction absente ne fait pas échouer
 *   la tâche. Sans la relance (lot R2b non appliqué), le contrôle tourne seul et le résumé le dit ; sans
 *   le contrôle (lot R2a non appliqué), la tâche ne contrôle rien et le dit (`skipped`).
 * - Relance en échec : le contrôle tourne quand même, puis la tâche échoue ; son message porte les deux
 *   étapes (une exécution en échec n'a pas de résumé).
 * - Rapport illisible, ou tronqué (plus de ventes que la borne du contrôle) : la tâche échoue. Un
 *   rapport partiel ne passe pas pour un contrôle complet ; la base, de son côté, n'a alors refermé
 *   aucune alerte (elle ne synchronise que les contrôles actifs d'un rapport tronqué).
 * - Panne passagère de l'une des deux étapes (erreur sans code, `40001`, `40P01`) : l'erreur le dit à
 *   `runMonitoredCron`, qui reprend la tâche entière (la relance et le contrôle se rejouent sans dommage),
 *   seulement s'il reste la place d'une tentative entière dans la durée de la route. Sinon c'est une erreur
 *   ordinaire, enregistrée avec son étape et son code.
 */
export async function runFactRegistryCheckJob(
  run: FactRegistryCheckRun = { startedAt: Date.now(), attempts: 0 },
): Promise<Record<string, unknown>> {
  run.attempts += 1;
  const reprojection = await runReprojection(run.startedAt).catch((error: unknown) => ({ error }));
  const check = await runCheck().catch((error: unknown) => ({ error }));

  if ("error" in reprojection || "error" in check) {
    const failed = [reprojection, check].flatMap((step) => ("error" in step ? [step.error] : []));
    const message =
      "error" in reprojection
        ? `${errorMessage(reprojection.error)} ${checkOutcomeText(check)}`
        : errorMessage(failed[0]);
    if (failed.some((error) => error instanceof RetryableDatabaseError) && hasRoomForRetry(run)) {
      throw new TransientJobError(message);
    }
    throw new Error(message);
  }
  if ("skipped" in check) return { skipped: "migration_pending" };
  return {
    ...check.summary,
    reprojection: "skipped" in reprojection ? reprojection : reprojection.summary,
  };
}
