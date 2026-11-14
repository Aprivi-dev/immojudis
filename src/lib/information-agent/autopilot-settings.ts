import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  parseAutopilotStats,
  sharedStructureCounts,
  type AutopilotMode,
  type AutopilotSettings,
  type AutopilotSharedSend,
  type AutopilotStats,
  type SharedStructureCounts,
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
    liveAllowed: data?.live_allowed ?? false,
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
  return { ...parseAutopilotStats(data), ...(await loadSharedStructureCounts(now)) };
}

/**
 * Missions lues au plus sur 8 jours (plafond dur du pilote : 60 par jour, soit 480 au plus, manuels en sus).
 * Au-delà, le compte par structure serait incomplet.
 */
const SHARED_SENDS_LIMIT = 1000;

/**
 * Envois des 8 derniers jours, dont `sharedStructureCounts` ne retient que ceux d'un domaine partagé
 * (`notaires.fr`, `gouv.fr`), comptés par structure. LECTURE SEULE.
 *
 * RÈGLE COPIÉE : la définition d'un envoi compté est celle de la table `sent` de la fonction SQL
 * `public.information_agent_autopilot_stats` (migration
 * `supabase/migrations/20261110230000_information_agent_autopilot.sql`) : mission approuvée depuis moins de
 * 8 jours, de statut `sending`, `sent`, `replied`, `review` ou `completed`, ou `failed` avec
 * `metadata.send_outcome = 'unverified'`. Les deux doivent changer ensemble.
 *
 * Une erreur de lecture est propagée (un plafond illisible ne vaut jamais autorisation). Un compte tronqué
 * n'est pas une erreur : il est rendu incomplet (`sharedStructureCountsComplete: false`), le pilote n'écrit
 * alors à aucune adresse d'un domaine partagé et l'écran d'administration l'affiche au lieu d'échouer.
 */
async function loadSharedStructureCounts(now: Date): Promise<SharedStructureCounts> {
  // Seuls les champs utiles de `metadata` sont lus (jamais l'inventaire ni le reste du brouillon).
  const { data, error } = await supabaseAdmin
    .from("information_agent_missions")
    .select(
      "recipient_email,approved_at,status,send_outcome:metadata->>send_outcome,office_code:metadata->contact_identity->>office_code,selected_email:metadata->contact_discovery->>selected_email",
    )
    .gte("approved_at", new Date(now.getTime() - 8 * 86_400_000).toISOString())
    .in("status", ["sending", "sent", "replied", "review", "completed", "failed"])
    .limit(SHARED_SENDS_LIMIT);
  if (error) throw error;
  if (!data) throw new Error("Shared-structure send counter read returned no data");
  if (data.length >= SHARED_SENDS_LIMIT) {
    return {
      todayBySharedStructure: {},
      weekBySharedStructure: {},
      sharedStructureCountsComplete: false,
    };
  }
  const sends: AutopilotSharedSend[] = [];
  for (const row of data as unknown as SharedSendRow[]) {
    if (row.status === "failed" && row.send_outcome !== "unverified") continue;
    if (!row.approved_at || typeof row.recipient_email !== "string") continue;
    // Le code d'office du brouillon ne vaut que si l'adresse est restée celle que le brouillon a choisie.
    const sameAddress =
      typeof row.selected_email === "string" &&
      row.selected_email.trim().toLowerCase() === row.recipient_email.trim().toLowerCase();
    sends.push({
      recipientEmail: row.recipient_email,
      officeCode: sameAddress && typeof row.office_code === "string" ? row.office_code : null,
      approvedAt: row.approved_at,
    });
  }
  return sharedStructureCounts(sends, now);
}

type SharedSendRow = {
  recipient_email: string;
  approved_at: string | null;
  status: string;
  send_outcome: string | null;
  office_code: string | null;
  selected_email: string | null;
};

/** Clés admises dans le journal (liste blanche) : codes, nombres et identifiants de vente, jamais autre chose. */
const EVENT_DETAIL_KEYS = new Set([
  "code",
  "mode",
  "failed",
  "saleId",
  "missionId",
  "caseId",
  "status",
  "blockers",
  "source",
  "fromAutopilot",
  "identities",
  "actorId",
  "reason",
  "examined",
  "prepared",
  "would_send",
  "sent",
]);

/** Filtre `details` : liste blanche de clés, « @ » neutralisé dans toute chaîne (aucune adresse dans une erreur de contrainte). */
export function sanitizeAutopilotEventDetails(
  details: Record<string, string | number | boolean | null | string[]>,
): Record<string, string | number | boolean | null | string[]> {
  const clean = (value: string) => value.replaceAll("@", "(at)").slice(0, 200);
  return Object.fromEntries(
    Object.entries(details)
      .filter(
        ([key]) =>
          EVENT_DETAIL_KEYS.has(key) || key.startsWith("skip_") || key.startsWith("error_"),
      )
      .map(([key, value]) => [
        key,
        typeof value === "string" ? clean(value) : Array.isArray(value) ? value.map(clean) : value,
      ]),
  );
}

export async function recordAutopilotEvent(
  kind: "run" | "skip" | "would_send" | "sent" | "send_error" | "wrong_recipient",
  runId: string | null,
  details: Record<string, string | number | boolean | null | string[]>,
): Promise<void> {
  const { error } = await supabaseAdmin.rpc("record_information_agent_autopilot_event", {
    p_kind: kind,
    p_run_id: runId ?? undefined,
    p_details: sanitizeAutopilotEventDetails(details),
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
