import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Réponse « ce n'est pas moi » (mauvais destinataire), reconnue par la lecture des réponses ou déclarée par un
 * administrateur (bouton « Mauvais destinataire »). Même effet dans les deux cas :
 *
 * - l'identité du destinataire est exclue du pilote automatique pendant 24 mois
 *   (`information_agent_autopilot_exclusions`, purgée au-delà) : elle ne repasse qu'en validation manuelle ;
 * - si le message venait du pilote (mission marquée `trigger = autopilot`), le pilote est arrêté
 *   (`record_information_agent_autopilot_auto_stop`, motif `wrong_recipient`, alerte critique) : une erreur de
 *   destinataire d'un envoi automatique est le signe que la sélection est à revoir ;
 * - un évènement `wrong_recipient` est journalisé, sans adresse.
 *
 * Aucun envoi : ce module n'écrit que des réglages et un journal.
 */
export async function applyWrongRecipient({
  caseId,
  source,
  actorId,
  reason,
}: {
  caseId: string;
  source: "reply" | "admin";
  /** Administrateur auteur (bouton « Mauvais destinataire »), journalisé avec son motif. */
  actorId?: string;
  reason?: string;
}): Promise<{ stopped: boolean; excludedIdentities: number; alreadyApplied?: boolean }> {
  // Idempotent : un webhook rejoué, ou un second clic, ne duplique ni l'évènement ni l'arrêt.
  const existing = await supabaseAdmin
    .from("information_agent_autopilot_events")
    .select("id")
    .eq("kind", "wrong_recipient")
    .eq("details->>caseId", caseId)
    .limit(1);
  if (existing.error) throw existing.error;
  if ((existing.data ?? []).length > 0) {
    return { stopped: false, excludedIdentities: 0, alreadyApplied: true };
  }
  const { data, error } = await supabaseAdmin
    .from("information_agent_missions")
    .select("recipient_identity_keys,metadata")
    .eq("case_id", caseId)
    .limit(20);
  if (error) throw error;
  const missions = data ?? [];
  const keys = [...new Set(missions.flatMap((mission) => mission.recipient_identity_keys ?? []))];
  const fromAutopilot = missions.some(isAutopilotMission);

  if (keys.length) {
    const { error: exclusionError } = await supabaseAdmin.rpc(
      "record_information_agent_autopilot_exclusions",
      { p_identity_keys: keys, p_reason: "wrong_recipient" },
    );
    if (exclusionError) throw exclusionError;
  }
  const { error: eventError } = await supabaseAdmin.rpc(
    "record_information_agent_autopilot_event",
    {
      p_kind: "wrong_recipient",
      p_details: {
        caseId,
        source,
        fromAutopilot,
        identities: keys.length,
        ...(actorId ? { actorId } : {}),
        ...(reason ? { reason: reason.replaceAll("@", "(at)").slice(0, 200) } : {}),
      },
    },
  );
  if (eventError) throw eventError;
  if (fromAutopilot) {
    const { error: stopError } = await supabaseAdmin.rpc(
      "record_information_agent_autopilot_auto_stop",
      { p_reason: "wrong_recipient", p_details: { caseId, source } },
    );
    if (stopError) throw stopError;
  }
  return { stopped: fromAutopilot, excludedIdentities: keys.length };
}

/** Mission envoyée par le pilote automatique (`metadata.trigger = autopilot`). */
export function isAutopilotMission(mission: { metadata: unknown }): boolean {
  const metadata = mission.metadata;
  return (
    Boolean(metadata) &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    (metadata as { trigger?: unknown }).trigger === "autopilot"
  );
}

/** Motif d'arrêt du pilote sur un « mauvais destinataire » d'un expéditeur non vérifié. */
export const AUTOPILOT_WRONG_RECIPIENT_UNVERIFIED = "wrong_recipient_unverified";

/**
 * « Mauvais destinataire » fort reçu par le jeton de réponse d'un dossier du pilote, d'un expéditeur NON vérifié
 * (authentification non concluante ou autre adresse que le destinataire) : le pilote s'arrête (motif
 * `wrong_recipient_unverified`, alerte critique), dans le sens protecteur. Rien d'autre : ni exclusion de 24 mois
 * (elle attend la confirmation d'un administrateur, bouton « Mauvais destinataire », `applyWrongRecipient`), ni
 * évènement `wrong_recipient` (qui rendrait cette confirmation sans effet). Idempotent : un webhook rejoué ne
 * rejoue pas l'arrêt (évènement `auto_stop` de ce motif pour ce dossier déjà journalisé).
 */
export async function stopAutopilotForUnverifiedWrongRecipient(caseId: string): Promise<boolean> {
  const existing = await supabaseAdmin
    .from("information_agent_autopilot_events")
    .select("id")
    .eq("kind", "auto_stop")
    .eq("reason", AUTOPILOT_WRONG_RECIPIENT_UNVERIFIED)
    .eq("details->>caseId", caseId)
    .limit(1);
  if (existing.error) throw existing.error;
  if ((existing.data ?? []).length > 0) return false;
  const { error } = await supabaseAdmin.rpc("record_information_agent_autopilot_auto_stop", {
    p_reason: AUTOPILOT_WRONG_RECIPIENT_UNVERIFIED,
    p_details: { caseId, source: "reply" },
  });
  if (error) throw error;
  return true;
}
