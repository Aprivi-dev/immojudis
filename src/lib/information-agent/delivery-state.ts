import type { Json } from "@/integrations/supabase/types";
import { deliveryStateOfLog, type EmailDeliveryState } from "@/lib/email-delivery-status";

/**
 * État de remise d'une mission envoyée, pour l'onglet Envois de l'agent d'information. Affichage seulement :
 * aucune règle d'envoi ni aucun garde-fou ne le lit. Module pur, testé sans base.
 *
 * Deux sources, la plus grave l'emporte :
 * - le journal des envois (`email_send_log`, par l'identifiant Resend de la mission) : seul à connaître
 *   « remis » et « différé », et le type exact d'un rebond ; purgé après 90 jours ;
 * - `metadata.delivery` de la mission (`information-agent-inbound/case-delivery.ts`) : rebond définitif,
 *   rebond passager ou plainte, conservé avec la mission. Un rebond de type indéterminé y est noté
 *   « passager » (règle prudente des garde-fous) ; le journal, quand il existe encore, le dit « Rebond ».
 *
 * `information_agent_messages.delivery_status` n'est pas lu : il reste à « sent » après l'envoi.
 */
const RANK: Record<EmailDeliveryState, number> = {
  delayed: 1,
  delivered: 2,
  bounced_temporary: 3,
  bounced: 4,
  complained: 5,
};

const METADATA_STATES = new Set<EmailDeliveryState>(["bounced", "bounced_temporary", "complained"]);

function metadataDeliveryState(metadata: Json): EmailDeliveryState | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const delivery = metadata.delivery;
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) return null;
  const status = delivery.status;
  return typeof status === "string" && METADATA_STATES.has(status as EmailDeliveryState)
    ? (status as EmailDeliveryState)
    : null;
}

export function missionDeliveryState(
  mission: { provider_message_id: string | null; metadata: Json },
  log: { status: string; bounce_type: string | null } | undefined,
): EmailDeliveryState | null {
  if (!mission.provider_message_id) return null;
  const fromLog = log ? deliveryStateOfLog(log.status, log.bounce_type) : null;
  const fromMetadata = metadataDeliveryState(mission.metadata);
  if (!fromLog) return fromMetadata;
  if (!fromMetadata) return fromLog;
  return RANK[fromMetadata] > RANK[fromLog] ? fromMetadata : fromLog;
}
