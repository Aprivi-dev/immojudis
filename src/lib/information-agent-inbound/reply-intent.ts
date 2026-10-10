import "server-only";
import { normalizeEmail, replyTextForExtraction } from "@/lib/information-agent-inbound/text";

export function findInboundToken(
  addresses: readonly string[],
  inboundDomain: string,
): string | null {
  const tokens = collectInboundTokens(addresses, inboundDomain);
  return tokens.length === 1 ? tokens[0] : null;
}

/**
 * Detect an explicit request to stop contact in the authenticated sender's
 * reply. Quoted history is removed before this helper is called so an old
 * message cannot unsubscribe a contact by being forwarded back to us.
 */
export function detectInformationAgentContactOptOut(bodyText: string): boolean {
  const text = replyTextForExtraction(bodyText)
    .replace(/\u00a0/g, " ")
    .trim();
  if (!text) return false;
  return [
    /(?:^|\n)\s*(?:stop|unsubscribe|désinscription|desinscription)(?:\s+merci)?\s*[.!…]*\s*$/imu,
    /\b(?:merci\s+de\s+ne\s+plus\s+(?:me|nous)\s+contacter|merci\s+de\s+(?:supprimer|retirer)\s+(?:mon\s+adresse|moi|nous)(?:\s+de\s+vos\s+listes?)?|(?:supprimez|retirez)\s+mon\s+adresse(?:\s+de\s+vos\s+listes?)?|ne\s+(?:me|nous)\s+contact(?:e|ez|er)\s+plus|retirez[-\s]?(?:moi|nous)(?:\s+de\s+vos\s+listes?)?|supprimez[-\s]?(?:moi|nous)(?:\s+de\s+vos\s+listes?)?|désinscrivez[-\s]?(?:moi|nous)|desinscrivez[-\s]?(?:moi|nous)|je\s+ne\s+souhaite\s+plus\s+(?:être\s+contact[ée]|recevoir\s+vos\s+(?:e-?mails?|courriels?))|je\s+ne\s+veux\s+plus\s+(?:être\s+contact[ée]|recevoir\s+vos\s+(?:e-?mails?|courriels?))|je\s+m['’]oppose\s+à\s+(?:tout|ce|votre)\s+contact|please\s+(?:remove|unsubscribe)\s+me|do\s+not\s+contact\s+me\s+again)\b/iu,
  ].some((pattern) => pattern.test(text));
}

export type InformationAgentReplyIntent = "opposition" | "agreement" | "ambiguous";

// Short, unambiguous confirmations ("oui", "d'accord", "confirmé"…) with no negation.
const EXPLICIT_AGREEMENT =
  /\b(?:oui|d['’]accord|bien\s+volontiers|volontiers|avec\s+plaisir|confirm[ée]s?|je\s+confirme|c['’]est\s+exact|ci[-\s]?joint(?:e|es|s)?|veuillez\s+trouver|pi[èe]ces?\s+jointes?)\b/iu;
const NEGATION =
  /\b(?:non|pas|jamais|aucun(?:e)?|refus(?:e|ons)?|impossible|n['’](?:est|ai|avons|a)\b|ne\s+\w+\s+pas)\b/iu;

/**
 * Classifies a reply from an authenticated sender. Only two outcomes are trusted without a
 * human: an explicit request to stop contact, and an explicit agreement or answer (information
 * extracted, or a plain confirmation without negation). Anything else is "ambiguous" and goes to
 * human review instead of being closed automatically.
 */
export function classifyInformationAgentReplyIntent(
  bodyText: string,
  { hasEvidence }: { hasEvidence: boolean },
): InformationAgentReplyIntent {
  if (detectInformationAgentContactOptOut(bodyText)) return "opposition";
  const text = replyTextForExtraction(bodyText)
    .replace(/\u00a0/g, " ")
    .trim();
  if (!text) return hasEvidence ? "agreement" : "ambiguous";
  if (NEGATION.test(text)) return hasEvidence ? "agreement" : "ambiguous";
  if (hasEvidence || EXPLICIT_AGREEMENT.test(text)) return "agreement";
  return "ambiguous";
}

export function collectInboundTokens(
  addresses: readonly string[],
  inboundDomain: string,
): string[] {
  const expectedDomain = inboundDomain.trim().toLowerCase();
  const localPartPattern =
    /^enquete\+([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
  const tokens = new Set<string>();
  for (const address of addresses) {
    const email = normalizeEmail(address);
    const separatorIndex = email.lastIndexOf("@");
    if (separatorIndex <= 0 || email.slice(separatorIndex + 1) !== expectedDomain) continue;
    const match = localPartPattern.exec(email.slice(0, separatorIndex));
    if (match?.[1]) tokens.add(match[1].toLowerCase());
  }
  return [...tokens];
}
