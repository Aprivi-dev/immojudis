import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Évènements de livraison Resend écrits au journal des envois (`email_send_log`) : remis, différé,
 * échec, rebond, plainte. Les ouvertures et les clics ne sont ni abonnés ni lus.
 *
 * Le journal est une mémoire, jamais une décision : le retrait des consentements, `bounce_status` et la
 * liste d'opposition se lisent dans l'évènement lui-même, jamais dans `email_send_log`
 * (`email-delivery-log.test.ts` le vérifie dans le code). Les journaux applicatifs ne portent aucune adresse.
 */
const LOGGED_EVENTS = new Set([
  "email.delivered",
  "email.delivery_delayed",
  "email.failed",
  "email.bounced",
  "email.complained",
]);

export type DeliveryLogEvent = { type: string; created_at?: string; data?: unknown };

export type DeliveryLogArgs = {
  p_resend_email_id: string;
  p_event: string;
  p_occurred_at?: string;
  p_from?: string;
  p_to?: string;
  p_subject?: string;
  p_bounce_type?: string;
  p_error_code?: string;
};

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Motif d'échec réduit à un court code (lettres, chiffres, tirets bas), jamais le texte du fournisseur. */
function shortCode(reason: unknown): string {
  return text(reason)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

/** Les arguments de la RPC pour cet évènement, ou `null` (autre évènement, aucun identifiant d'email). Pur. */
export function deliveryLogArgsOf(event: DeliveryLogEvent): DeliveryLogArgs | null {
  if (!LOGGED_EVENTS.has(event.type)) return null;
  const data = (event.data ?? {}) as {
    email_id?: unknown;
    from?: unknown;
    to?: unknown;
    subject?: unknown;
    bounce?: { type?: unknown };
    failed?: { reason?: unknown };
  };
  const id = text(data.email_id).trim();
  if (!id) return null;
  const occurredAt =
    event.created_at && Number.isFinite(Date.parse(event.created_at))
      ? new Date(event.created_at).toISOString()
      : undefined;
  const to = Array.isArray(data.to) ? text(data.to[0]) : "";
  return {
    p_resend_email_id: id,
    p_event: event.type,
    ...(occurredAt ? { p_occurred_at: occurredAt } : {}),
    p_from: text(data.from),
    p_to: to,
    p_subject: text(data.subject),
    ...(event.type === "email.bounced" && text(data.bounce?.type)
      ? { p_bounce_type: text(data.bounce?.type) }
      : {}),
    ...(event.type === "email.failed" && shortCode(data.failed?.reason)
      ? { p_error_code: shortCode(data.failed?.reason) }
      : {}),
  };
}

/** Écrit l'évènement au journal. Une erreur de la base remonte : l'appelant décide de rejouer ou non. */
export async function recordEmailDeliveryEvent(event: DeliveryLogEvent): Promise<void> {
  const args = deliveryLogArgsOf(event);
  if (!args) return;
  const { error } = await supabaseAdmin.rpc("record_email_delivery_event", args);
  if (error) throw error;
}

/** Délai maximal d'une écriture du journal depuis un webhook. */
const DELIVERY_LOG_TIMEOUT_MS = 3_000;

/**
 * Exécute l'écriture du journal, bornée à 3 s : une panne ou une lenteur est rendue (`{ error }`) au lieu d'être
 * levée, pour que l'appelant la relance à la fin, une fois les retraits de consentement faits.
 */
export async function captureFailure(
  write: () => Promise<void>,
  timeoutMs = DELIVERY_LOG_TIMEOUT_MS,
): Promise<{ error: unknown } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      write(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Journal des envois : délai dépassé.")),
          timeoutMs,
        );
      }),
    ]);
    return null;
  } catch (error) {
    return { error: error ?? new Error("Journal des envois indisponible.") };
  } finally {
    clearTimeout(timer);
  }
}
