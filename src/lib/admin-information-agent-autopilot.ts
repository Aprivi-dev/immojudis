import "server-only";
import { PublicApiError, RateLimitError } from "@/lib/api-errors";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  currentPrivacyVersion,
  evaluateAutopilotReadiness,
  isActiveAdmin,
  loadRoundtripVerifiedAt,
  loadVerifiedResendDomains,
} from "@/lib/information-agent/autopilot-readiness";
import {
  AUTOPILOT_EVENT_TEXT_MAX,
  loadAutopilotSettings,
  loadAutopilotStats,
  loadRecentAutopilotEvents,
} from "@/lib/information-agent/autopilot-settings";
import { AUTOPILOT_ON_DEMAND_COOLDOWN_MS } from "@/lib/information-agent/autopilot-rules";
import {
  buildAutopilotView,
  type AutopilotPreparedDraft,
  type AutopilotView,
} from "@/lib/information-agent/autopilot-view";
import { asObject } from "@/lib/information-agent/mission-store";
import { assertAdminAuth } from "@/lib/admin-auth.server";
import { adminInformationAgentRpcFailure } from "@/lib/admin-information-agent-rpc-failure";
import { ADMIN_ROUTE_TIMEOUT_MS } from "@/lib/admin-route-deadline";
import {
  runInformationAgentAutopilotOnDemand,
  type AutopilotRunSummary,
} from "@/lib/information-agent-autopilot";

/**
 * Panneau du pilote automatique (administrateurs). Lecture : modèle de vue déjà mis en forme. Écriture : les
 * quatre RPC d'administration (`is_admin`, motif obligatoire, journal en ajout seul), appelées avec le jeton de
 * l'administrateur ; le passage en mode réel exige en plus le contrôle de préparation (TypeScript) et la base
 * le revérifie (AIPD, aller-retour). Enfin, le passage de simulation lancé à la main (motif obligatoire,
 * journalisé par le passage lui-même) ; l'écran relit ensuite l'état par la lecture habituelle.
 */
/** Motif : 8 caractères au moins, `max` au plus, jamais d'adresse (le journal n'en contient pas). */
const reasonSchema = (max: number) =>
  z
    .string()
    .trim()
    .min(8)
    .max(max)
    .refine((value) => !value.includes("@"), "Le motif ne doit contenir aucune adresse email.");
/** Motif d'un changement (colonne `reason` du journal, 500 caractères). */
const changeReason = reasonSchema(500);

export const adminAutopilotActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("set_mode"),
    mode: z.enum(["off", "simulation", "live"]),
    reason: changeReason,
  }),
  z.object({
    action: z.literal("update_settings"),
    changes: z
      .object({
        capTotalOverride: z.number().int().min(1).max(60).nullable().optional(),
        allowLicitorDecoded: z.boolean().optional(),
        art14RuleEnabled: z.boolean().optional(),
        art14MaxAgeDays: z.number().int().min(1).max(365).optional(),
        actingAdminId: z.string().guid().optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0, "Aucun réglage à modifier."),
    reason: changeReason,
  }),
  z.object({ action: z.literal("emergency_stop"), reason: z.string().trim().max(500).optional() }),
  z.object({
    action: z.literal("attest_aipd"),
    version: z.string().trim().min(1).max(40),
    reason: changeReason,
  }),
  // Motif rangé dans les `details` du journal : refusé au-delà de leur longueur, jamais tronqué.
  z.object({
    action: z.literal("run_simulation_now"),
    reason: reasonSchema(AUTOPILOT_EVENT_TEXT_MAX),
  }),
]);
export type AdminAutopilotAction = z.output<typeof adminAutopilotActionSchema>;
/** Actions qui rendent la vue du pilote (toutes, sauf le passage lancé à la main). */
export type AdminAutopilotChange = Exclude<AdminAutopilotAction, { action: "run_simulation_now" }>;

/** Résultat d'un passage de simulation lancé à la main, déjà rédigé pour l'écran. */
export type AutopilotOnDemandRun = {
  outcome: "finished" | "time_budget" | "interrupted";
  text: string;
};
/** Réponse du passage lancé à la main : son résultat seul, l'écran relit l'état du pilote ensuite. */
export type AdminAutopilotSimulationResult = { onDemandRun: AutopilotOnDemandRun };

/** Passages non lancés : un refus (409) avec son motif ; le délai de 10 minutes est un 429. */
const ON_DEMAND_REFUSALS: Record<string, string> = {
  busy: "Un passage du pilote est déjà en cours : réessayez dans quelques minutes.",
  paused: "Passage refusé : le pilote est en pause.",
  auto_stopped: "Passage refusé : le pilote est arrêté automatiquement.",
  not_production: "Passage refusé : seul l’environnement de production fait tourner le pilote.",
};
/**
 * Heure à laquelle le travail du passage à la demande doit être fini, comptée depuis le début de la requête : 3 s
 * avant le délai des routes admin, pour l'événement de fin, l'alerte des erreurs et le bail. Le passage n'entame
 * aucune étape qui risque de la dépasser.
 */
const ON_DEMAND_FINISH_BY_MS = ADMIN_ROUTE_TIMEOUT_MS - 3_000;

/** « 1 préparée », « 2 préparées » (0 au singulier, comme en français). */
function counted(count: number, word: string): string {
  return `${count} ${word}${count > 1 ? "s" : ""}`;
}

function onDemandRunResult(summary: AutopilotRunSummary): AutopilotOnDemandRun {
  if (summary.status === "skipped") {
    if (summary.code === "on_demand_cooldown") {
      const seconds = Math.max(
        1,
        Math.ceil((summary.retryAfterMs ?? AUTOPILOT_ON_DEMAND_COOLDOWN_MS) / 1000),
      );
      const message = `Un passage à la demande a déjà été lancé il y a moins de ${AUTOPILOT_ON_DEMAND_COOLDOWN_MS / 60_000} minutes : réessayez dans ${Math.ceil(seconds / 60)} min.`;
      throw new RateLimitError(message, seconds, message);
    }
    if (summary.code === "not_simulation") {
      const state = summary.mode === "live" ? "en mode réel" : "éteint";
      throw new PublicApiError(
        `Passage refusé : le pilote est ${state}. Le passage à la demande n’existe qu’en mode Simulation.`,
        409,
      );
    }
    throw new PublicApiError(
      ON_DEMAND_REFUSALS[summary.code ?? ""] ?? `Passage non lancé (${summary.code}).`,
      409,
    );
  }
  const errors = Object.values(summary.errors).reduce((total, count) => total + count, 0);
  const counts = `${counted(summary.examined, "examinée")}, ${counted(summary.prepared, "préparée")}, ${counted(summary.wouldSend, "simulée")}${errors ? `, ${errors} en erreur` : ""}`;
  // Arrêt ou pause automatique, ou mode changé pendant le passage.
  if (summary.status === "stopped" || summary.skipped.interrupted) {
    return {
      outcome: "interrupted",
      text: `Passage de simulation interrompu (arrêt ou pause automatique, ou mode changé ; voir l’état du pilote) : ${counts}. Aucun envoi.`,
    };
  }
  if (summary.stoppedByTimeBudget) {
    return {
      outcome: "time_budget",
      text: `Passage de simulation arrêté par la borne de temps : ${counts}. Aucun envoi.`,
    };
  }
  return { outcome: "finished", text: `Passage de simulation terminé : ${counts}. Aucun envoi.` };
}

async function readiness(now: Date, env: Readonly<Record<string, string | undefined>>) {
  const [settings, stats] = await Promise.all([loadAutopilotSettings(), loadAutopilotStats(now)]);
  const report = evaluateAutopilotReadiness({
    settings,
    stats,
    env,
    now,
    roundtripVerifiedAt: await loadRoundtripVerifiedAt(),
    actingAdminIsAdmin: await isActiveAdmin(settings.actingAdminId),
    privacyVersion: currentPrivacyVersion(),
    verifiedResendDomains: await loadVerifiedResendDomains(env.RESEND_API_KEY?.trim()),
  });
  return { settings, stats, report };
}

/**
 * Brouillons préparés par le pilote en simulation (« prêts à valider ») : identifiants de la mission et de la
 * vente (pour l'ouvrir dans l'éditeur de l'onglet « À contacter ») et titre de la vente, jamais l'adresse.
 */
async function loadPreparedDrafts(): Promise<AutopilotPreparedDraft[]> {
  const { data, error } = await supabaseAdmin
    .from("information_agent_missions")
    .select("id,sale_id,metadata,created_at")
    .eq("status", "draft")
    .eq("metadata->>trigger", "autopilot")
    .eq("metadata->>autopilot_simulated", "true")
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) throw error;
  const rows = (data ?? []).flatMap((row) =>
    row.sale_id && asObject(row.metadata).trigger === "autopilot"
      ? [{ missionId: row.id, saleId: row.sale_id }]
      : [],
  );
  const ids = [...new Set(rows.map((row) => row.saleId))];
  if (!ids.length) return [];
  const { data: sales, error: salesError } = await supabaseAdmin
    .from("auction_sales")
    .select("id,title,city")
    .in("id", ids);
  if (salesError) throw salesError;
  const titles = new Map(
    (sales ?? []).map((sale) => [sale.id, sale.title || sale.city || sale.id]),
  );
  return rows.map((row) => ({ ...row, label: String(titles.get(row.saleId) ?? row.saleId) }));
}

export async function getAdminAutopilotView(
  authToken: string,
  {
    env = process.env,
    now = new Date(),
  }: { env?: Readonly<Record<string, string | undefined>>; now?: Date } = {},
): Promise<AutopilotView> {
  await assertAdminAuth(authToken);
  const [{ settings, stats, report }, events, prepared] = await Promise.all([
    readiness(now, env),
    loadRecentAutopilotEvents(20),
    loadPreparedDrafts(),
  ]);
  return buildAutopilotView({ settings, stats, readiness: report, env, now, events, prepared });
}

export async function runAdminAutopilotAction({
  authToken,
  input,
  env = process.env,
  startedAt = Date.now(),
}: {
  authToken: string;
  input: AdminAutopilotAction;
  env?: Readonly<Record<string, string | undefined>>;
  /** Début de la requête (ms) : la borne de temps du passage à la demande en part. */
  startedAt?: number;
}): Promise<AutopilotView | AdminAutopilotSimulationResult> {
  const auth = await assertAdminAuth(authToken);
  if (input.action === "run_simulation_now") {
    // Administrateur de la session vérifiée, jamais une valeur du client. La vue n'est pas relue ici (l'écran
    // la relit) : tout le temps de la requête reste au passage.
    const summary = await runInformationAgentAutopilotOnDemand({
      adminId: auth.userId,
      reason: input.reason,
      finishBy: new Date(startedAt + ON_DEMAND_FINISH_BY_MS),
    });
    return { onDemandRun: onDemandRunResult(summary) };
  }
  if (input.action === "set_mode") {
    if (input.mode === "live") {
      const { report } = await readiness(new Date(), env);
      if (!report.ready) {
        const failed = report.checks.filter((check) => !check.ok).map((check) => check.label);
        throw new PublicApiError(
          `Mode réel refusé, contrôle de préparation non satisfait : ${failed.join(" ; ")}.`,
          409,
        );
      }
    }
    const { error } = await auth.supabase.rpc("set_information_agent_autopilot_mode", {
      p_mode: input.mode,
      p_reason: input.reason,
    });
    if (error) throw adminInformationAgentRpcFailure("admin.autopilot", error);
  } else if (input.action === "update_settings") {
    const {
      capTotalOverride,
      allowLicitorDecoded,
      art14RuleEnabled,
      art14MaxAgeDays,
      actingAdminId,
    } = input.changes;
    const changes = {
      ...(capTotalOverride !== undefined ? { cap_total_override: capTotalOverride } : {}),
      ...(allowLicitorDecoded !== undefined ? { allow_licitor_decoded: allowLicitorDecoded } : {}),
      ...(art14RuleEnabled !== undefined ? { art14_rule_enabled: art14RuleEnabled } : {}),
      ...(art14MaxAgeDays !== undefined ? { art14_max_age_days: art14MaxAgeDays } : {}),
      ...(actingAdminId !== undefined ? { acting_admin_id: actingAdminId } : {}),
    };
    const { error } = await auth.supabase.rpc("update_information_agent_autopilot_settings", {
      p_changes: changes,
      p_reason: input.reason,
    });
    if (error) throw adminInformationAgentRpcFailure("admin.autopilot", error);
  } else if (input.action === "emergency_stop") {
    // Toujours permis : aucune condition, motif facultatif.
    const { error } = await auth.supabase.rpc("stop_information_agent_autopilot", {
      p_reason: input.reason,
    });
    if (error) throw adminInformationAgentRpcFailure("admin.autopilot", error);
  } else {
    const { error } = await auth.supabase.rpc("attest_information_agent_aipd", {
      p_version: input.version,
      p_reason: input.reason,
    });
    if (error) throw adminInformationAgentRpcFailure("admin.autopilot", error);
  }
  try {
    return await getAdminAutopilotView(authToken, { env });
  } catch (error) {
    // L'action est faite : une relecture en échec ne doit pas la faire passer pour refusée (arrêt d'urgence).
    if (input.action !== "emergency_stop") throw error;
    console.error(JSON.stringify({ scope: "admin.autopilot", code: "stop_view_unread" }));
    throw new PublicApiError(AUTOPILOT_STOP_RECORDED_UNREAD_MESSAGE, 503, { cause: error });
  }
}

const AUTOPILOT_STOP_RECORDED_UNREAD_MESSAGE =
  "Arrêt enregistré, état non relu : rechargez la page pour vérifier l’état du pilote.";
