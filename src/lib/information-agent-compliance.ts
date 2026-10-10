/**
 * Browser/email-safe helpers for the GDPR guarantees of the supervised information agent
 * (plan P4-12). The agent contacts professionals whose address it did not collect from them, so
 * every message must carry the art. 14 GDPR information and a one-click objection link.
 */

export const INFORMATION_AGENT_RECIPIENT_COOLDOWN_DAYS = 30;

export type InformationAgentLegalFooter = {
  /** Data controller (responsable de traitement). */
  controllerName: string;
  controllerAddress: string;
  contactEmail: string | null;
  /** Where the recipient's address came from (art. 14(2)(f)). */
  addressOrigin: string;
  privacyUrl: string;
  /** One-click objection link. */
  optOutUrl: string;
};

export type InformationAgentControllerIdentity = {
  name: string;
  address: string;
  contactEmail: string | null;
};

/**
 * Identity of the data controller, from the same public legal-entity variables as the legal
 * pages. Sending is refused while it is incomplete.
 */
export function informationAgentControllerIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
): InformationAgentControllerIdentity | null {
  const name = env.NEXT_PUBLIC_LEGAL_ENTITY_NAME?.trim();
  const address = env.NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS?.trim();
  if (!name || !address) return null;
  return { name, address, contactEmail: env.NEXT_PUBLIC_LEGAL_CONTACT_EMAIL?.trim() || null };
}

function sourceHost(sourceUrl: string | null | undefined): string | null {
  try {
    return sourceUrl ? new URL(sourceUrl).hostname.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}

export function describeInformationAgentAddressOrigin({
  sourceName,
  sourceUrl,
}: {
  sourceName?: string | null;
  sourceUrl?: string | null;
}): string {
  const name = sourceName?.trim();
  const host = sourceHost(sourceUrl);
  if (name && host) {
    return `Votre adresse professionnelle figure dans une publication accessible au public (${name}, ${host}) relative à cette vente.`;
  }
  if (name || host) {
    return `Votre adresse professionnelle figure dans une publication accessible au public (${name ?? host}) relative à cette vente.`;
  }
  return "Votre adresse professionnelle figure dans l’avis de vente judiciaire publié, accessible au public.";
}

/** Plain-text rendering, kept identical in meaning to the HTML footer. */
export function informationAgentLegalFooterLines(footer: InformationAgentLegalFooter): string[] {
  return [
    `Responsable de traitement : ${footer.controllerName}, ${footer.controllerAddress}${
      footer.contactEmail ? ` — ${footer.contactEmail}` : ""
    }.`,
    footer.addressOrigin,
    "Finalité et base légale : vous demander des informations sur cette vente, dans notre intérêt légitime à fiabiliser l’annonce. Aucune autre sollicitation ne vous sera adressée pour ce motif pendant 30 jours.",
    `Politique de confidentialité et vos droits : ${footer.privacyUrl}`,
    `Ne plus être contacté (un clic) : ${footer.optOutUrl}`,
  ];
}
