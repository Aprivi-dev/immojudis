import "server-only";
import type { EmailBouncedEvent, EmailComplainedEvent } from "resend";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { recordInboundContactOptOut } from "@/lib/information-agent-inbound/case-updates";
import { normalizeEmail } from "@/lib/information-agent-inbound/text";
import type { InformationAgentInboundResult } from "@/lib/information-agent-inbound/types";

/**
 * Rebonds et plaintes des emails de l'agent d'information.
 *
 * Avant, rien ne traitait `email.bounced` ni `email.complained` : le webhook ne gardait que
 * `email.received`, `information_agent_contacts.bounce_status` ne passait jamais à « permanent » et les
 * garde-fous qui lisent cette colonne (aperçu, envoi, rapport de suffisance) ne coupaient rien.
 *
 * - Rebond définitif (`bounce.type` « Permanent ») : `bounce_status = 'permanent'`, l'adresse n'est plus
 *   jamais sollicitée. Rebond passager ou indéterminé : `temporary`, sans jamais défaire un `permanent`.
 * - Plainte (« spam » signalé par le destinataire) : traitée comme une opposition, la mesure la plus
 *   prudente (`opposition_status = 'opposed'`, comme un « STOP » reçu).
 *
 * Seuls les emails envoyés par l'expéditeur de l'agent (`INFORMATION_AGENT_EMAIL_FROM`) comptent : le
 * même webhook recevrait aussi les rebonds des alertes envoyées aux comptes, dont les adresses n'ont
 * rien à faire dans le registre de contacts de l'agent. Les journaux ne portent aucune adresse.
 */
export type DeliveryEvent = EmailBouncedEvent | EmailComplainedEvent;

export type DeliveryAction =
  | { kind: "bounce"; status: "permanent" | "temporary"; emails: string[]; at: string }
  | { kind: "complaint"; emails: string[]; at: string };

/** L'adresse d'expéditeur de l'agent (sans le nom affiché), ou `null` si elle n'est pas configurée. */
export function informationAgentSenderAddress(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  return normalizeEmail(env.INFORMATION_AGENT_EMAIL_FROM ?? "") || null;
}

/** Le rebond est définitif seulement quand le fournisseur le dit (« Permanent »). */
export function bounceStatusOf(bounceType: unknown): "permanent" | "temporary" {
  return typeof bounceType === "string" && bounceType.trim().toLowerCase() === "permanent"
    ? "permanent"
    : "temporary";
}

/**
 * Ce que l'évènement demande de faire, ou `null` : autre expéditeur que l'agent, aucun destinataire
 * lisible. Pur, testé sans base.
 */
export function deliveryActionOf(
  event: DeliveryEvent,
  agentSender: string | null,
): DeliveryAction | null {
  if (!agentSender || normalizeEmail(event.data.from ?? "") !== agentSender) return null;
  const emails = [
    ...new Set((event.data.to ?? []).map((recipient) => normalizeEmail(recipient)).filter(Boolean)),
  ];
  if (emails.length === 0) return null;
  const at = Number.isFinite(Date.parse(event.created_at))
    ? new Date(event.created_at).toISOString()
    : new Date().toISOString();
  if (event.type === "email.complained") return { kind: "complaint", emails, at };
  return {
    kind: "bounce",
    status: bounceStatusOf((event as EmailBouncedEvent).data.bounce?.type),
    emails,
    at,
  };
}

/** Écrit le rebond sur l'adresse (portée globale). Un `permanent` n'est jamais rétrogradé. */
export async function recordInboundContactBounce(
  email: string,
  status: "permanent" | "temporary",
  bouncedAt: string,
): Promise<void> {
  if (status === "temporary") {
    const { data, error } = await supabaseAdmin
      .from("information_agent_contacts")
      .select("bounce_status")
      .is("scope_sale_id", null)
      .eq("normalized_email", email)
      .maybeSingle();
    if (error) throw error;
    if (data?.bounce_status === "permanent") return;
  }
  const { error } = await supabaseAdmin
    .from("information_agent_contacts")
    .upsert(
      { sale_id: null, scope_sale_id: null, email, bounce_status: status, bounced_at: bouncedAt },
      { onConflict: "scope_sale_id,normalized_email" },
    );
  if (error) throw error;
}

export async function processDeliveryEvent(
  event: DeliveryEvent,
  env: Readonly<Record<string, string | undefined>>,
): Promise<InformationAgentInboundResult> {
  const action = deliveryActionOf(event, informationAgentSenderAddress(env));
  if (!action) return { accepted: true, ignored: true };
  // Une erreur remonte : le fournisseur rejoue l'évènement, qui ne doit pas se perdre.
  for (const email of action.emails) {
    if (action.kind === "bounce") await recordInboundContactBounce(email, action.status, action.at);
    else await recordInboundContactOptOut(email, action.at);
  }
  console.warn(
    JSON.stringify({
      scope: "information-agent-delivery",
      level: "warn",
      event: action.kind === "bounce" ? `bounce_${action.status}` : "complaint",
      recipients: action.emails.length,
    }),
  );
  return { accepted: true };
}
