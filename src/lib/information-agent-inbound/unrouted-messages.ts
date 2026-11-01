import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { InboundSenderAuthentication } from "@/lib/information-agent-inbound/sender-authentication";
import {
  replaceControlCharacters,
  stripInvisibleCharacters,
} from "@/lib/information-agent-inbound/text";

/**
 * Conservation d'un message reçu à l'adresse de réponse de l'agent SANS dossier ouvert (jeton absent ou
 * inconnu, dossier clos, jetons multiples), pour qu'un administrateur le voie dans l'écran de l'agent et
 * dans le résumé quotidien.
 *
 * Ce module n'écrit que dans `information_agent_unrouted_messages` : aucune extraction de faits, aucune
 * pièce enregistrée (le circuit des pièces est rattaché à un dossier : on ne garde que leur nombre),
 * aucune réponse. Les durées de conservation sont celles de la purge SQL (12 mois si l'expéditeur nous
 * était connu, 21 jours sinon).
 */

export type UnroutedInboundReason =
  | "no_token"
  | "unknown_case"
  | "case_not_open"
  | "token_mismatch";

export const UNROUTED_EXCERPT_MAX_CHARS = 1000;
const UNROUTED_SENDER_MAX_CHARS = 320;
const UNROUTED_SUBJECT_MAX_CHARS = 500;
const UNROUTED_ATTACHMENT_COUNT_MAX = 1000;

/** Remplace les paires de substituts incomplètes, que Postgres refuse dans un texte JSON. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

function boundedLine(value: string | null | undefined, max: number): string {
  const cleaned = replaceControlCharacters(stripInvisibleCharacters(value ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, max).replace(LONE_SURROGATE, "\ufffd");
}

function boundedExcerpt(value: string | null | undefined): string | null {
  const cleaned = replaceControlCharacters(stripInvisibleCharacters(value ?? ""), true)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, UNROUTED_EXCERPT_MAX_CHARS).replace(LONE_SURROGATE, "\ufffd");
}

export type UnroutedInboundMessageInput = {
  providerEmailId: string;
  /** En-tête « From » tel que reçu. */
  from: string;
  /** Adresse de l'expéditeur normalisée, vide si elle n'a pas pu être lue. */
  senderEmail: string;
  subject: string | null | undefined;
  receivedAt: string;
  reason: UnroutedInboundReason;
  /** L'expéditeur figure dans nos données : fixe la durée de conservation. */
  senderKnown: boolean;
  /** Corps du message, seulement s'il a été lu chez le fournisseur ; borné ici. */
  bodyText: string | null;
  authentication: InboundSenderAuthentication | null;
  attachmentCount: number;
  oppositionRecorded: boolean;
};

/**
 * Enregistre le message. Une livraison rejouée par le fournisseur (même `provider_email_id`) ne crée pas
 * de seconde ligne et n'écrase pas l'état « traité » posé entre-temps. Une erreur d'écriture est
 * propagée : le webhook échoue et le fournisseur rejoue la livraison, comme pour une opposition.
 */
export async function storeUnroutedInboundMessage(input: UnroutedInboundMessageInput) {
  const receivedAtMs = Date.parse(input.receivedAt);
  const { error } = await supabaseAdmin.from("information_agent_unrouted_messages").upsert(
    {
      provider_email_id: input.providerEmailId.slice(0, 200),
      sender: boundedLine(input.from, UNROUTED_SENDER_MAX_CHARS),
      sender_email: input.senderEmail ? boundedLine(input.senderEmail, 320) : null,
      subject: boundedLine(input.subject, UNROUTED_SUBJECT_MAX_CHARS),
      received_at: new Date(Number.isNaN(receivedAtMs) ? Date.now() : receivedAtMs).toISOString(),
      excerpt: boundedExcerpt(input.bodyText),
      reason: input.reason,
      sender_known: input.senderKnown,
      sender_authentication: input.authentication?.status ?? null,
      attachment_count: Math.min(
        Math.max(0, Math.trunc(input.attachmentCount)),
        UNROUTED_ATTACHMENT_COUNT_MAX,
      ),
      opposition_recorded: input.oppositionRecorded,
    },
    { onConflict: "provider_email_id", ignoreDuplicates: true },
  );
  if (error) throw error;
}
