import "server-only";
import { resolveSiteOrigin } from "@/lib/site-url";

// Configuration d'envoi de l'agent et garde-fous d'environnement (interrupteur, canari). Extraits
// de `information-agent.ts` sans changement de comportement.

/** Motifs d'environnement que la simulation du pilote tolère (elle n'envoie jamais). */
export const INFORMATION_AGENT_OUTBOUND_DISABLED_MESSAGE =
  "Envoi de l’agent désactivé pendant la phase de validation.";
export const INFORMATION_AGENT_CANARY_ONLY_MESSAGE =
  "Envoi limité à l'adresse de test du fournisseur pendant l'essai canari.";

export function assertInformationAgentOutboundEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (env.INFORMATION_AGENT_OUTBOUND_ENABLED !== "true") {
    throw new Error(INFORMATION_AGENT_OUTBOUND_DISABLED_MESSAGE);
  }
}

/** Domaine de messagerie du notariat : une adresse qui y est logée est celle d'un office. */
const NOTARY_MAIL_DOMAIN = "notaires.fr";

export const INFORMATION_AGENT_NOTARY_SEND_DISABLED_MESSAGE =
  "Envoi à un notaire fermé : la réutilisation des annonces notariales pour écrire aux offices attend une autorisation. Le brouillon reste consultable ; l'envoi sera possible une fois le réglage INFORMATION_AGENT_NOTARY_SEND_ENABLED activé.";

/**
 * Les envois aux notaires sont FERMÉS par défaut (décision prudente du 11/11/2026, en attendant une
 * autorisation sur la réutilisation des annonces notariales). Sont concernés le destinataire de rôle notaire,
 * tout destinataire d'une vente notariale (`question_audience = notary`) et toute adresse en `notaires.fr`
 * (ou l'un de ses sous-domaines), quels que soient le rôle et la vente. Seule la valeur exacte `true`
 * de `INFORMATION_AGENT_NOTARY_SEND_ENABLED` ouvre l'approbation et l'envoi ; le brouillon, l'aperçu du
 * texte et la mesure à blanc restent possibles.
 */
export function assertInformationAgentNotarySendAllowed(
  recipient: { role: string | null; questionAudience: unknown; email: string },
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const domain = recipient.email.trim().toLowerCase().split("@").pop() ?? "";
  const notaryDomain = domain === NOTARY_MAIL_DOMAIN || domain.endsWith(`.${NOTARY_MAIL_DOMAIN}`);
  if (recipient.role !== "notary" && recipient.questionAudience !== "notary" && !notaryDomain) {
    return;
  }
  if (env.INFORMATION_AGENT_NOTARY_SEND_ENABLED !== "true") {
    throw new Error(INFORMATION_AGENT_NOTARY_SEND_DISABLED_MESSAGE);
  }
}

/** Keep the first provider canary restricted to Resend's own delivery test address. */
export function assertInformationAgentCanaryRecipient(
  email: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.INFORMATION_AGENT_OUTBOUND_CANARY_ONLY === "false") return;
  if (email.trim().toLowerCase() !== "delivered@resend.dev") {
    throw new Error(INFORMATION_AGENT_CANARY_ONLY_MESSAGE);
  }
}

/**
 * Configuration d'envoi de l'agent. L'expéditeur est celui de l'agent, `INFORMATION_AGENT_EMAIL_FROM`,
 * et rien d'autre : le repli sur `ALERT_EMAIL_FROM` envoyait les emails à des tiers depuis l'adresse
 * des alertes aux comptes, donc leur réputation d'expéditeur était commune. Sans expéditeur, l'envoi
 * est bloqué (et l'aperçu le dit).
 */
export function resolveInformationAgentEmailConfig(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.INFORMATION_AGENT_EMAIL_FROM?.trim();
  const inboundDomain = env.INFORMATION_AGENT_INBOUND_DOMAIN?.trim().toLowerCase();
  if (!apiKey || !from || !inboundDomain) {
    throw new Error("Configuration d'envoi et de réception de l'agent incomplète.");
  }
  return { apiKey, from, inboundDomain, appUrl: informationAgentAppOrigin(env) };
}

/**
 * Keep links in supervised emails on the environment that initiated the send.
 * The production origin remains the safe fallback for legacy deployments that
 * have not declared SITE_URL yet.
 */
export function informationAgentAppOrigin(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return resolveSiteOrigin(env, "https://immojudis.com") ?? "https://immojudis.com";
}

export function informationAgentCaseReference(caseId: string): string {
  return `IJ-${caseId.replaceAll("-", "").slice(0, 8).toUpperCase()}`;
}
