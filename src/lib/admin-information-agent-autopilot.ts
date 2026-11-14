import "server-only";
import { PublicApiError } from "@/lib/api-errors";
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
  loadAutopilotSettings,
  loadAutopilotStats,
  loadLastAutopilotRunAt,
  loadPendingSimulatedDrafts,
  loadRecentAutopilotEvents,
} from "@/lib/information-agent/autopilot-settings";
import {
  AUTOPILOT_ART14_MAX_DAYS,
  AUTOPILOT_MAX_PENDING_SIMULATED_DRAFTS,
} from "@/lib/information-agent/autopilot-rules";
import {
  buildAutopilotView,
  type AutopilotPreparedDraft,
  type AutopilotView,
} from "@/lib/information-agent/autopilot-view";
import { assertAdminAuth } from "@/lib/admin-auth.server";
import { adminInformationAgentRpcFailure } from "@/lib/admin-information-agent-rpc-failure";

/**
 * Panneau du pilote automatique (administrateurs). Lecture : modèle de vue déjà mis en forme. Écriture : les
 * quatre RPC d'administration (`is_admin`, motif obligatoire, journal en ajout seul), appelées avec le jeton de
 * l'administrateur ; le passage en mode réel exige en plus le contrôle de préparation (TypeScript) et la base
 * le revérifie (AIPD, aller-retour).
 */
/** Motif d'un changement : 8 caractères au moins, jamais d'adresse (le journal n'en contient pas). */
const changeReason = z
  .string()
  .trim()
  .min(8)
  .max(500)
  .refine((value) => !value.includes("@"), "Le motif ne doit contenir aucune adresse email.");

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
        // Article 14 (J9, 14/11/2026) : la règle ne se désactive plus ; seul « vrai » est admis, pour rétablir une
        // valeur fausse antérieure à la contrainte de la base. Délai de 1 à 90 jours (décision du 14/11/2026).
        art14RuleEnabled: z.literal(true).optional(),
        art14MaxAgeDays: z.number().int().min(1).max(AUTOPILOT_ART14_MAX_DAYS).optional(),
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
]);
export type AdminAutopilotAction = z.output<typeof adminAutopilotActionSchema>;

/**
 * État du compte d'exécution pour l'écran : une lecture impossible (panne passagère de l'API Auth) s'affiche
 * « lecture impossible » au lieu de rendre tout le panneau indisponible. Le passage, lui, lève l'erreur (T7).
 */
async function actingAdminState(userId: string | null): Promise<boolean | null> {
  try {
    return await isActiveAdmin(userId);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    console.error(
      JSON.stringify({
        scope: "admin.autopilot",
        code: "acting_admin_unreadable",
        error: {
          name: error instanceof Error ? error.name : typeof error,
          code: typeof code === "string" ? code.slice(0, 20) : null,
        },
      }),
    );
    return null;
  }
}

async function readiness(now: Date, env: Readonly<Record<string, string | undefined>>) {
  const [settings, stats] = await Promise.all([loadAutopilotSettings(), loadAutopilotStats(now)]);
  const report = evaluateAutopilotReadiness({
    settings,
    stats,
    env,
    now,
    roundtripVerifiedAt: await loadRoundtripVerifiedAt(),
    actingAdminIsAdmin: await actingAdminState(settings.actingAdminId),
    privacyVersion: currentPrivacyVersion(),
    verifiedResendDomains: await loadVerifiedResendDomains(env.RESEND_API_KEY?.trim()),
  });
  return { settings, stats, report };
}

/**
 * Brouillons préparés par le pilote en simulation (« prêts à valider ») : leur nombre, puis les plus récents (au
 * plus le plafond de la simulation : tous, en temps normal) avec les identifiants de la mission et de la vente
 * (pour l'ouvrir dans l'éditeur de l'onglet « À contacter ») et le titre de la vente, jamais l'adresse.
 */
async function loadPreparedDrafts(): Promise<{ total: number; items: AutopilotPreparedDraft[] }> {
  const { rows: pending, total } = await loadPendingSimulatedDrafts({
    limit: AUTOPILOT_MAX_PENDING_SIMULATED_DRAFTS,
  });
  const rows = pending.flatMap((row) =>
    row.sale_id ? [{ missionId: row.id, saleId: row.sale_id }] : [],
  );
  const ids = [...new Set(rows.map((row) => row.saleId))];
  if (!ids.length) return { total, items: [] };
  const { data: sales, error: salesError } = await supabaseAdmin
    .from("auction_sales")
    .select("id,title,city")
    .in("id", ids);
  if (salesError) throw salesError;
  const titles = new Map(
    (sales ?? []).map((sale) => [sale.id, sale.title || sale.city || sale.id]),
  );
  return {
    total,
    items: rows.map((row) => ({ ...row, label: String(titles.get(row.saleId) ?? row.saleId) })),
  };
}

export async function getAdminAutopilotView(
  authToken: string,
  {
    env = process.env,
    now = new Date(),
  }: { env?: Readonly<Record<string, string | undefined>>; now?: Date } = {},
): Promise<AutopilotView> {
  await assertAdminAuth(authToken);
  const [{ settings, stats, report }, events, lastRunAt, prepared] = await Promise.all([
    readiness(now, env),
    loadRecentAutopilotEvents(20),
    loadLastAutopilotRunAt(),
    loadPreparedDrafts(),
  ]);
  return buildAutopilotView({
    settings,
    stats,
    readiness: report,
    env,
    now,
    events,
    lastRunAt,
    prepared,
  });
}

export async function runAdminAutopilotAction({
  authToken,
  input,
  env = process.env,
}: {
  authToken: string;
  input: AdminAutopilotAction;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<AutopilotView> {
  const auth = await assertAdminAuth(authToken);
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
