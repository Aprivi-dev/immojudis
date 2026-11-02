import "server-only";
import { z } from "zod";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
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
  loadRecentAutopilotEvents,
} from "@/lib/information-agent/autopilot-settings";
import { buildAutopilotView, type AutopilotView } from "@/lib/information-agent/autopilot-view";
import { asObject } from "@/lib/information-agent/mission-store";

/**
 * Panneau du pilote automatique (administrateurs). Lecture : modèle de vue déjà mis en forme. Écriture : les
 * quatre RPC d'administration (`is_admin`, motif obligatoire, journal en ajout seul), appelées avec le jeton de
 * l'administrateur ; le passage en mode réel exige en plus le contrôle de préparation (TypeScript) et la base
 * le revérifie (AIPD, aller-retour).
 */
export const adminAutopilotActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("set_mode"),
    mode: z.enum(["off", "simulation", "live"]),
    reason: z.string().trim().min(8).max(500),
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
    reason: z.string().trim().min(8).max(500),
  }),
  z.object({ action: z.literal("emergency_stop"), reason: z.string().trim().max(500).optional() }),
  z.object({
    action: z.literal("attest_aipd"),
    version: z.string().trim().min(1).max(40),
    reason: z.string().trim().min(8).max(500),
  }),
]);
export type AdminAutopilotAction = z.output<typeof adminAutopilotActionSchema>;

async function requireAdmin(authToken: string) {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");
  return auth;
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

/** Brouillons préparés par le pilote en simulation (« prêts à valider »), titre de la vente seulement. */
async function loadPreparedDrafts(): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("information_agent_missions")
    .select("sale_id,metadata,created_at")
    .eq("status", "draft")
    .eq("metadata->>trigger", "autopilot")
    .eq("metadata->>autopilot_simulated", "true")
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) throw error;
  const rows = (data ?? []).filter(
    (row) => row.sale_id && asObject(row.metadata).trigger === "autopilot",
  );
  const ids = [...new Set(rows.map((row) => row.sale_id as string))];
  if (!ids.length) return [];
  const { data: sales, error: salesError } = await supabaseAdmin
    .from("auction_sales")
    .select("id,title,city")
    .in("id", ids);
  if (salesError) throw salesError;
  const titles = new Map(
    (sales ?? []).map((sale) => [sale.id, sale.title || sale.city || sale.id]),
  );
  return ids.map((id) => String(titles.get(id) ?? id));
}

export async function getAdminAutopilotView(
  authToken: string,
  {
    env = process.env,
    now = new Date(),
  }: { env?: Readonly<Record<string, string | undefined>>; now?: Date } = {},
): Promise<AutopilotView> {
  await requireAdmin(authToken);
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
}: {
  authToken: string;
  input: AdminAutopilotAction;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<AutopilotView> {
  const auth = await requireAdmin(authToken);
  if (input.action === "set_mode") {
    if (input.mode === "live") {
      const { report } = await readiness(new Date(), env);
      if (!report.ready) {
        const failed = report.checks.filter((check) => !check.ok).map((check) => check.label);
        throw new Error(
          `Mode réel refusé, contrôle de préparation non satisfait : ${failed.join(" ; ")}.`,
        );
      }
    }
    const { error } = await auth.supabase.rpc("set_information_agent_autopilot_mode", {
      p_mode: input.mode,
      p_reason: input.reason,
    });
    if (error) throw error;
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
    if (error) throw error;
  } else if (input.action === "emergency_stop") {
    // Toujours permis : aucune condition, motif facultatif.
    const { error } = await auth.supabase.rpc("stop_information_agent_autopilot", {
      p_reason: input.reason,
    });
    if (error) throw error;
  } else {
    const { error } = await auth.supabase.rpc("attest_information_agent_aipd", {
      p_version: input.version,
      p_reason: input.reason,
    });
    if (error) throw error;
  }
  return getAdminAutopilotView(authToken, { env });
}
