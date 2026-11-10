/**
 * États de remise d'un email, tels que les affichent le journal des envois (module Emails, onglet
 * Historique) et l'onglet Envois de l'agent d'information. Module pur, sans accès à la base : importable
 * par le navigateur. Affichage seulement : aucune décision ne se lit ici (voir `email-delivery-log.ts`).
 */
export type EmailDeliveryTone = "ok" | "bad" | "warn" | "neutral";
export type EmailDeliveryLabel = { text: string; tone: EmailDeliveryTone; detail?: string };
/**
 * `bounced_temporary_unconfirmed` : rebond noté « passager » sur une mission avant que le type du
 * fournisseur y soit conservé ; il peut s'agir d'un rebond de type inconnu, d'où l'absence de précision.
 */
export type EmailDeliveryState =
  | "delivered"
  | "delayed"
  | "failed"
  | "bounced"
  | "bounced_temporary"
  | "bounced_temporary_unconfirmed"
  | "complained";

export const TRANSIENT_BOUNCE_DETAIL =
  "souvent une réponse automatique d’absence ; l’adresse reste utilisable";

export const EMAIL_DELIVERY_LABELS: Record<EmailDeliveryState, EmailDeliveryLabel> = {
  delivered: { text: "Remis", tone: "ok" },
  delayed: { text: "Différé", tone: "warn" },
  failed: { text: "Échec", tone: "bad" },
  bounced: { text: "Rebond", tone: "bad" },
  bounced_temporary: { text: "Rebond passager", tone: "warn", detail: TRANSIENT_BOUNCE_DETAIL },
  bounced_temporary_unconfirmed: { text: "Rebond passager", tone: "warn" },
  complained: { text: "Plainte", tone: "bad" },
};

/** Rebond passager : `bounce_type` « transient », quelle que soit la casse du fournisseur. */
export function isTransientBounce(bounceType: string | null | undefined): boolean {
  return typeof bounceType === "string" && bounceType.trim().toLowerCase() === "transient";
}

/**
 * État lisible d'une ligne du journal (`status`, `bounce_type`), ou `null` pour « envoyé ». Un rebond
 * définitif ou de type inconnu reste un « Rebond ».
 */
export function deliveryStateOfLog(
  status: string,
  bounceType: string | null | undefined,
): EmailDeliveryState | null {
  if (status === "bounced") return isTransientBounce(bounceType) ? "bounced_temporary" : "bounced";
  if (
    status === "delivered" ||
    status === "delayed" ||
    status === "failed" ||
    status === "complained"
  ) {
    return status;
  }
  return null;
}
