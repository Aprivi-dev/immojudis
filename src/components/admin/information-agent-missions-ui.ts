import {
  EMAIL_DELIVERY_LABELS,
  type EmailDeliveryLabel,
  type EmailDeliveryState,
} from "@/lib/email-delivery-status";
import type { InformationAgentMission } from "@/lib/information-agent/schemas";

/** Libellés et règles partagés par l'éditeur de message (À contacter) et la liste des envois. */

/** Un brouillon ou un échec se reprend et se modifie ; tout autre statut s'ouvre en lecture seule. */
export function isMissionEditable(status: string): boolean {
  return status === "draft" || status === "failed";
}

export function missionStatusLabel(status: string): string {
  return (
    {
      draft: "Brouillon",
      subscribed: "Rattachée au dossier",
      approved: "Validée",
      sending: "Envoi en cours",
      sent: "Envoyée",
      replied: "Réponse reçue",
      review: "À vérifier",
      completed: "Terminée",
      failed: "Échec",
      cancelled: "Annulée",
    }[status] ?? status
  );
}

/**
 * Origine d'une mission : « Pilote » si le pilote automatique l'a marquée (`metadata.trigger = autopilot`, dès
 * son brouillon), sinon « Manuel ». Repli quand la marque manque : seul le pilote marque ses brouillons, une
 * mission sans marque est donc un brouillon d'administrateur pas encore validé ou un envoi antérieur au pilote.
 */
export function missionTriggerLabel(trigger: InformationAgentMission["trigger"]): string {
  return trigger === "autopilot" ? "Pilote" : "Manuel";
}

/** État de remise d'une mission envoyée (« Remis », « Rebond passager »…), ou `null` sans information. */
export function missionDeliveryLabel(
  state: EmailDeliveryState | null | undefined,
): EmailDeliveryLabel | null {
  return state ? EMAIL_DELIVERY_LABELS[state] : null;
}

/** Couleur du texte de l'état de remise ; le texte suffit à le lire (jamais la couleur seule). */
export const MISSION_DELIVERY_TONE_CLASS: Record<EmailDeliveryLabel["tone"], string> = {
  ok: "text-success",
  bad: "text-danger",
  warn: "text-warning",
  neutral: "text-brand-navy/60",
};
