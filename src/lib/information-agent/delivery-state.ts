import type { Json } from "@/integrations/supabase/types";
import {
  deliveryStateOfLog,
  isTransientBounce,
  type EmailDeliveryState,
} from "@/lib/email-delivery-status";

/**
 * État de remise d'une mission envoyée, pour l'onglet Envois de l'agent d'information. Affichage seulement :
 * aucune règle d'envoi ni aucun garde-fou ne le lit. Module pur, testé sans base.
 *
 * Deux sources, la plus grave l'emporte :
 * - le journal des envois (`email_send_log`, par l'identifiant Resend de la mission) : seul à connaître
 *   « remis » et « différé », et le type exact d'un rebond ; purgé après 90 jours ;
 * - `metadata.delivery` de la mission (`information-agent-inbound/case-delivery.ts`) : rebond définitif,
 *   rebond passager ou plainte, conservé avec la mission. Un rebond de type inconnu y est noté
 *   `bounced_temporary` (règle prudente des garde-fous) ; le type brut (`bounce_type`) dit lequel :
 *   « transient » = « Rebond passager » avec sa précision, autre type = « Rebond », type absent (entrées
 *   antérieures à sa conservation) = « Rebond passager » sans la précision « l'adresse reste utilisable ».
 *
 * `information_agent_messages.delivery_status` n'est pas lu : il reste à « sent » après l'envoi.
 */
/** Même ordre que `app_private.email_send_status_rank` (sent < delayed < failed < delivered < …). */
const RANK: Record<EmailDeliveryState, number> = {
  delayed: 1,
  failed: 2,
  delivered: 3,
  bounced_temporary_unconfirmed: 4,
  bounced_temporary: 4,
  bounced: 5,
  complained: 6,
};

function metadataDeliveryState(metadata: Json): EmailDeliveryState | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const delivery = metadata.delivery;
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) return null;
  const { status, bounce_type: bounceType } = delivery;
  if (status === "bounced" || status === "complained") return status;
  if (status !== "bounced_temporary") return null;
  if (typeof bounceType !== "string" || !bounceType.trim()) return "bounced_temporary_unconfirmed";
  return isTransientBounce(bounceType) ? "bounced_temporary" : "bounced";
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
