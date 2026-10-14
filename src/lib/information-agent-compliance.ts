/**
 * Browser/email-safe helpers for the GDPR guarantees of the supervised information agent
 * (plan P4-12). The agent contacts professionals whose address it did not collect from them, so
 * every message must carry the art. 14 GDPR information and a one-click objection link.
 */
import { safeExternalHttpUrl } from "@/lib/external-url";
import type { InformationAgentAiProvider } from "@/lib/information-agent-ai-provider";
import { sourceLabel } from "@/lib/sale-source-links";

export const INFORMATION_AGENT_RECIPIENT_COOLDOWN_DAYS = 30;

export type InformationAgentLegalFooter = {
  /** Data controller (responsable de traitement). */
  controllerName: string;
  controllerAddress: string;
  contactEmail: string | null;
  /** Référence de la vente concernée, pour « vérifier des informations sur la vente ». */
  saleReference?: string | null;
  /** Where the recipient's address came from (art. 14(2)(f)): type, link and date. */
  addressOrigin: string;
  /** Public page where the address was found (listing, directory or firm page). */
  addressOriginUrl?: string | null;
  /** Adresse retrouvée par l'outil de recherche automatisé : le pied le dit. */
  automatedSearch?: boolean;
  /** Prestataire d'IA qui lit les réponses (art. 14(1)(e)), tiré de la configuration. */
  aiProvider: InformationAgentAiProvider;
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

/**
 * Nature de la source d'une adresse retenue (art. 14(2)(f) RGPD) :
 * - `sale_listing` : l'annonce publique de cette vente ;
 * - `other_listing` : une autre annonce du même professionnel ;
 * - `firm_website` : le site du cabinet ou de l'étude ;
 * - `official_directory` : un annuaire officiel, désigné par son nom ;
 * - `admin_entry` : saisie d'un administrateur, d'après une page publique.
 */
export const INFORMATION_AGENT_ADDRESS_SOURCE_KINDS = [
  "sale_listing",
  "other_listing",
  "firm_website",
  "official_directory",
  "admin_entry",
] as const;

export type InformationAgentAddressSourceKind =
  (typeof INFORMATION_AGENT_ADDRESS_SOURCE_KINDS)[number];

export type InformationAgentAddressObserver = "agent" | "admin";

export function isInformationAgentAddressSourceKind(
  value: unknown,
): value is InformationAgentAddressSourceKind {
  return (INFORMATION_AGENT_ADDRESS_SOURCE_KINDS as readonly unknown[]).includes(value);
}

export type InformationAgentAddressOrigin = {
  /** Phrase lisible : « … figure dans l’annonce publique de cette vente sur Licitor (…). » */
  text: string;
  /** Lien vers la page publique d'où vient l'adresse, quand il est connu. */
  url: string | null;
  /** Vrai quand l'outil de recherche automatisé a retrouvé l'adresse sur une page publique. */
  automated: boolean;
};

/** Date de relevé au format JJ/MM/AAAA, à l'heure de Paris ; null si la date est absente. */
export function formatInformationAgentOriginDate(
  value: string | Date | null | undefined,
): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

/**
 * Origine de l'adresse du destinataire (art. 14 RGPD), avec le type de la source, le lien de la
 * page publique et la date de consultation. Le libellé suit le type : une adresse relevée dans un
 * annuaire ne « figure » jamais dans l'annonce de la vente. Formulations de l'avis juridique du
 * 14/10/2026 (section 7).
 *
 * `sourceKind` absent : `manual` (ancien paramètre) désigne une saisie d'administrateur, sinon
 * l'annonce publique de la vente.
 */
export function informationAgentAddressOrigin({
  sourceName,
  sourceUrl,
  manual = false,
  sourceKind,
  directoryName,
  observedAt,
  observedBy,
}: {
  sourceName?: string | null;
  sourceUrl?: string | null;
  manual?: boolean;
  sourceKind?: InformationAgentAddressSourceKind | null;
  /** Nom de l'annuaire officiel, ex. « annuaire officiel des commissaires de justice ». */
  directoryName?: string | null;
  observedAt?: string | Date | null;
  observedBy?: InformationAgentAddressObserver | null;
}): InformationAgentAddressOrigin {
  const kind: InformationAgentAddressSourceKind =
    sourceKind ?? (manual ? "admin_entry" : "sale_listing");
  const url = safeExternalHttpUrl(sourceUrl ?? null);
  const label = sourceName?.trim() || url ? sourceLabel(sourceName, url, "") : "";
  const observedOn = formatInformationAgentOriginDate(observedAt);
  const link = url ? ` (${url})` : "";
  const consulted = (feminine: boolean) =>
    observedOn ? `, ${feminine ? "consultée" : "consulté"} le ${observedOn}` : "";
  const automated = observedBy === "agent" && kind !== "sale_listing" && kind !== "admin_entry";

  switch (kind) {
    case "sale_listing":
      return {
        text: label
          ? `Votre adresse professionnelle figure dans l’annonce publique de cette vente sur ${label}${link}${consulted(true)}.`
          : `Votre adresse professionnelle figure dans l’avis de vente publié, accessible au public${link}${consulted(false)}.`,
        url,
        automated,
      };
    case "other_listing":
      return {
        text: `Votre adresse professionnelle figure dans une autre annonce publique de vente que vous avez publiée${
          label ? `, sur ${label}` : ""
        }${link}${consulted(true)}.`,
        url,
        automated,
      };
    case "official_directory": {
      const name = directoryName?.trim();
      return {
        text: `Votre adresse professionnelle figure sur votre fiche publique de ${
          name ? `l’${name}` : "l’annuaire officiel de votre profession"
        }${link}${consulted(true)}.`,
        url,
        automated,
      };
    }
    case "firm_website":
      return {
        text: `Votre adresse professionnelle figure sur le site de votre cabinet${link}${consulted(false)}.`,
        url,
        automated,
      };
    case "admin_entry":
      return {
        text: `Votre adresse professionnelle a été relevée par un membre de l’équipe Immojudis sur une page publique${
          url ? ` (${url})` : label ? ` (${label})` : ""
        }${observedOn ? `, le ${observedOn}` : ""}.`,
        url,
        automated,
      };
  }
}

/** Compatibilité : la phrase seule (sans le lien). */
export function describeInformationAgentAddressOrigin(
  input: Parameters<typeof informationAgentAddressOrigin>[0],
): string {
  return informationAgentAddressOrigin(input).text;
}

export type InformationAgentFooterSection = {
  /** Intertitre en gras (« Pourquoi ce message ? »). */
  label: string;
  text: string;
};

/**
 * Pied de message art. 14 RGPD (cadrage juridique 8.3) : finalité et base, catégories de données
 * et origine, destinataires et prestataires, conservation, droits, opposition et réclamation CNIL.
 * Les liens (politique, opposition, CNIL) sont ajoutés par le gabarit HTML et par
 * `informationAgentLegalFooterLines`.
 */
export function informationAgentLegalFooterSections(
  footer: InformationAgentLegalFooter,
): InformationAgentFooterSection[] {
  const sale = footer.saleReference?.trim();
  const controller = `${footer.controllerName}, ${footer.controllerAddress}${
    footer.contactEmail ? ` — ${footer.contactEmail}` : ""
  }`;
  const sections: InformationAgentFooterSection[] = [
    {
      label: "Pourquoi ce message ?",
      text: `Immojudis vous écrit à titre professionnel pour vérifier des informations sur ${
        sale ? `la vente ${sale}` : "cette vente"
      }. ${INFORMATION_AGENT_NO_OFFER_STATEMENT} ${INFORMATION_AGENT_PURPOSE_STATEMENT} Responsable de traitement : ${controller}.`,
    },
    {
      label: "Vos données :",
      text: `${INFORMATION_AGENT_DATA_CATEGORIES_STATEMENT} Origine : ${footer.addressOrigin}`,
    },
  ];
  if (footer.automatedSearch) {
    sections.push({
      label: "Recherche de l’adresse :",
      text: INFORMATION_AGENT_AUTOMATED_SEARCH_STATEMENT,
    });
  }
  sections.push(
    { label: "Destinataires :", text: informationAgentRecipientsStatement(footer.aiProvider) },
    { label: "Conservation :", text: INFORMATION_AGENT_RETENTION_STATEMENT },
    { label: "Vos droits :", text: INFORMATION_AGENT_RIGHTS_STATEMENT },
    {
      label: "Opposition :",
      text: `${INFORMATION_AGENT_OBJECTION_STATEMENT} ${INFORMATION_AGENT_COMPLAINT_STATEMENT}`,
    },
  );
  return sections;
}

/** Plain-text rendering, kept identical in meaning to the HTML footer. */
export function informationAgentLegalFooterLines(footer: InformationAgentLegalFooter): string[] {
  return [
    ...informationAgentLegalFooterSections(footer).map(({ label, text }) => `${label} ${text}`),
    `Politique de confidentialité et vos droits : ${footer.privacyUrl}`,
    `Ne plus être contacté (un clic) : ${footer.optOutUrl}`,
  ];
}

/** Ce message reste purement informatif (décision du 13 octobre 2026). */
export const INFORMATION_AGENT_NO_OFFER_STATEMENT =
  "Ce message ne contient aucune offre commerciale.";

/** Finalité et base légale (art. 14(1)(c) RGPD). */
export const INFORMATION_AGENT_PURPOSE_STATEMENT =
  "Base : intérêt légitime à publier des informations exactes (art. 6.1.f RGPD). Aucune autre sollicitation ne vous sera adressée pour ce motif pendant 30 jours.";

/** Catégories de données (art. 14(1)(d) RGPD). */
export const INFORMATION_AGENT_DATA_CATEGORIES_STATEMENT =
  "votre nom, votre fonction, votre adresse professionnelle et nos échanges.";

/**
 * Mention de la recherche automatique (avis juridique du 14/10/2026, section 7), ajoutée quand
 * l'adresse a été retrouvée par l'outil de recherche.
 */
export const INFORMATION_AGENT_AUTOMATED_SEARCH_STATEMENT =
  "Cette adresse a été retrouvée par un outil de recherche automatisé d’Immojudis, qui consulte ponctuellement des pages publiques sans en conserver de copie. Ce message a été relu et validé par un membre de l’équipe avant envoi.";

/**
 * Durées de conservation annoncées au destinataire (art. 14(2)(a) RGPD), identiques à la purge
 * (`app_private.purge_information_agent_data`) : 30 jours sans envoi, 12 mois sans réponse,
 * 24 mois après le dernier échange (matrice de conservation, `docs/data-retention-matrix.md`).
 */
export const INFORMATION_AGENT_RETENTION_STATEMENT =
  "30 jours si aucun message ne vous est finalement envoyé, 12 mois sans réponse de votre part, 24 mois après le dernier échange.";

/** Droits (art. 14(2)(c) RGPD). */
export const INFORMATION_AGENT_RIGHTS_STATEMENT =
  "accès, rectification, effacement et limitation du traitement.";

/** Droit d'opposition formulé clairement et séparément (art. 21(4) RGPD). */
export const INFORMATION_AGENT_OBJECTION_STATEMENT =
  "Vous pouvez vous opposer à tout moment, sans motif, à ce que nous vous contactions et à ce que nous conservions vos coordonnées : utilisez le lien « Ne plus être contacté » ci-dessous ou répondez à ce message. Votre opposition vaut pour tous nos canaux.";

/** Droit de réclamation (art. 14(2)(e) RGPD). */
export const INFORMATION_AGENT_COMPLAINT_STATEMENT =
  "Vous pouvez aussi saisir la CNIL d’une réclamation (cnil.fr/plaintes).";

export const INFORMATION_AGENT_CNIL_COMPLAINT_URL = "https://www.cnil.fr/fr/plaintes";

/**
 * Destinataires et prestataires (art. 14(1)(e)-(f) RGPD) : l'équipe Immojudis et les prestataires
 * d'hébergement, d'envoi des courriels et d'IA. Le prestataire d'IA vient de la configuration
 * (`informationAgentAiProvider`), jamais d'un texte figé.
 */
export function informationAgentRecipientsStatement(
  aiProvider: InformationAgentAiProvider,
): string {
  return `l’équipe Immojudis et ses prestataires : Vercel et Supabase (hébergement), Resend (envoi des courriels) et ${aiProvider.name} (${aiProvider.country}), outil d’IA qui aide à lire et classer les réponses. Certains de ces prestataires peuvent traiter des données hors de l’Union européenne, notamment aux États-Unis ; les garanties applicables sont décrites dans la politique de confidentialité.`;
}
