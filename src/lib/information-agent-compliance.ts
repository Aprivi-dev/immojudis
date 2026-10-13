/**
 * Browser/email-safe helpers for the GDPR guarantees of the supervised information agent
 * (plan P4-12). The agent contacts professionals whose address it did not collect from them, so
 * every message must carry the art. 14 GDPR information and a one-click objection link.
 */
import { safeExternalHttpUrl } from "@/lib/external-url";
import { sourceLabel } from "@/lib/sale-source-links";

export const INFORMATION_AGENT_RECIPIENT_COOLDOWN_DAYS = 30;

export type InformationAgentLegalFooter = {
  /** Data controller (responsable de traitement). */
  controllerName: string;
  controllerAddress: string;
  contactEmail: string | null;
  /** Where the recipient's address came from (art. 14(2)(f)). */
  addressOrigin: string;
  /** Public page where the address was found (listing URL), shown as a link. */
  addressOriginUrl?: string | null;
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

export type InformationAgentAddressOrigin = {
  /** Phrase lisible : « … figure dans l’annonce publique de cette vente sur Licitor. » */
  text: string;
  /** Lien vers la page publique d'où vient l'adresse, quand il est connu. */
  url: string | null;
};

/**
 * Origine de l'adresse du destinataire (art. 14 RGPD), avec le lien de l'annonce publique.
 * `manual` : adresse relevée par un administrateur sur une autre page publique (annuaire, site
 * du cabinet), dont l'URL est obligatoire avant l'envoi.
 */
export function informationAgentAddressOrigin({
  sourceName,
  sourceUrl,
  manual = false,
}: {
  sourceName?: string | null;
  sourceUrl?: string | null;
  manual?: boolean;
}): InformationAgentAddressOrigin {
  const url = safeExternalHttpUrl(sourceUrl ?? null);
  const label = sourceName?.trim() || url ? sourceLabel(sourceName, url, "") : "";
  if (manual) {
    return {
      text: label
        ? `Votre adresse professionnelle a été relevée sur une page publique (${label}).`
        : "Votre adresse professionnelle a été relevée sur une page publique.",
      url,
    };
  }
  if (label) {
    return {
      text: `Votre adresse professionnelle figure dans l’annonce publique de cette vente sur ${label}.`,
      url,
    };
  }
  return {
    text: "Votre adresse professionnelle figure dans l’avis de vente publié, accessible au public.",
    url,
  };
}

/** Compatibilité : la phrase seule (sans le lien). */
export function describeInformationAgentAddressOrigin(input: {
  sourceName?: string | null;
  sourceUrl?: string | null;
  manual?: boolean;
}): string {
  return informationAgentAddressOrigin(input).text;
}

/** Plain-text rendering, kept identical in meaning to the HTML footer. */
export function informationAgentLegalFooterLines(footer: InformationAgentLegalFooter): string[] {
  return [
    `Responsable de traitement : ${footer.controllerName}, ${footer.controllerAddress}${
      footer.contactEmail ? ` — ${footer.contactEmail}` : ""
    }.`,
    footer.addressOriginUrl
      ? `${footer.addressOrigin} Annonce : ${footer.addressOriginUrl}`
      : footer.addressOrigin,
    INFORMATION_AGENT_PURPOSE_STATEMENT,
    `Politique de confidentialité et vos droits : ${footer.privacyUrl}`,
    `Ne plus être contacté (un clic) : ${footer.optOutUrl}`,
  ];
}

/** Finalité et base légale ; l'email reste purement informatif, sans sollicitation commerciale. */
export const INFORMATION_AGENT_PURPOSE_STATEMENT =
  "Finalité et base légale : vous demander des informations sur cette vente, dans notre intérêt légitime à fiabiliser l’annonce. Aucune autre sollicitation ne vous sera adressée pour ce motif pendant 30 jours ; le lien ci-dessous met fin à tout envoi.";
