import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  parseAutopilotStats,
  type AutopilotMode,
  type AutopilotSettings,
  type AutopilotStats,
} from "@/lib/information-agent/autopilot-rules";

/**
 * Accès aux réglages, au journal et aux compteurs du pilote automatique (tables et RPC de la migration
 * 20261110230000). Le journal ne reçoit JAMAIS d'adresse : identifiants de vente, codes de motifs, nombres.
 */
export async function loadAutopilotSettings(): Promise<AutopilotSettings> {
  const { data, error } = await supabaseAdmin
    .from("information_agent_autopilot_settings")
    .select("*")
    .eq("singleton", true)
    .maybeSingle();
  if (error) throw error;
  // Ligne absente (migration en retard) : le pilote reste éteint.
  const mode: AutopilotMode =
    data?.mode === "simulation" || data?.mode === "live" ? data.mode : "off";
  return {
    mode,
    actingAdminId: data?.acting_admin_id ?? null,
    capTotalOverride: data?.cap_total_override ?? null,
    allowLicitorDecoded: data?.allow_licitor_decoded ?? false,
    art14RuleEnabled: data?.art14_rule_enabled ?? true,
    art14MaxAgeDays: data?.art14_max_age_days ?? 30,
    aipdAttestedAt: data?.aipd_attested_at ?? null,
    aipdVersion: data?.aipd_version ?? null,
    simulationStartedAt: data?.simulation_started_at ?? null,
    pausedUntil: data?.paused_until ?? null,
    autoStoppedAt: data?.auto_stopped_at ?? null,
    autoStopReason: data?.auto_stop_reason ?? null,
  };
}

export async function loadAutopilotStats(now = new Date()): Promise<AutopilotStats> {
  const { data, error } = await supabaseAdmin.rpc("information_agent_autopilot_stats", {
    p_now: now.toISOString(),
  });
  if (error) throw error;
  return parseAutopilotStats(data);
}

export async function recordAutopilotEvent(
  kind: "run" | "skip" | "would_send" | "sent" | "send_error" | "wrong_recipient",
  runId: string | null,
  details: Record<string, string | number | boolean | null | string[]>,
): Promise<void> {
  const { error } = await supabaseAdmin.rpc("record_information_agent_autopilot_event", {
    p_kind: kind,
    p_run_id: runId ?? undefined,
    p_details: details,
  });
  if (error) throw error;
}

/** Arrêt automatique (mode « off », alerte critique) ou, avec `pauseHours`, pause du pilote. */
export async function recordAutopilotAutoStop(
  code: string,
  details: Record<string, string | number | boolean | null>,
  pauseHours?: number,
): Promise<void> {
  const { error } = await supabaseAdmin.rpc("record_information_agent_autopilot_auto_stop", {
    p_reason: code,
    p_details: details,
    p_pause_hours: pauseHours,
  });
  if (error) throw error;
}

export async function syncAutopilotWarning(code: string, active: boolean): Promise<void> {
  const { error } = await supabaseAdmin.rpc("sync_information_agent_autopilot_warning", {
    p_code: code,
    p_active: active,
  });
  if (error) throw error;
}

export async function recordAutopilotExclusions(identityKeys: readonly string[]): Promise<void> {
  if (!identityKeys.length) return;
  const { error } = await supabaseAdmin.rpc("record_information_agent_autopilot_exclusions", {
    p_identity_keys: [...identityKeys],
    p_reason: "wrong_recipient",
  });
  if (error) throw error;
}

/** Clés d'identité (parmi celles données) exclues du pilote. Une lecture impossible est propagée. */
export async function loadExcludedIdentityKeys(keys: readonly string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const { data, error } = await supabaseAdmin
    .from("information_agent_autopilot_exclusions")
    .select("identity_key")
    .in("identity_key", [...keys]);
  if (error) throw error;
  return new Set((data ?? []).map((row) => row.identity_key));
}

export type AutopilotEventRow = {
  id: string;
  at: string;
  kind: string;
  action: string | null;
  reason: string | null;
  details: unknown;
};

export async function loadRecentAutopilotEvents(limit = 20): Promise<AutopilotEventRow[]> {
  const { data, error } = await supabaseAdmin
    .from("information_agent_autopilot_events")
    .select("id,at,kind,action,reason,details")
    .order("at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}
