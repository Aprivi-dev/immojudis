/**
 * Texte du message selon le destinataire. MODULE PUR. L'avocat poursuivant garde le modèle publié
 * (`DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE` ou sa version en base) et le greffe le sien
 * (`court-registry-template.ts`). Le notaire d'une vente notariale et le service de l'État d'une cession ont
 * chacun le leur, écrit ici (relecture juridique du 11/11/2026).
 *
 * Même structure de blocs que le modèle des professionnels, donc même rendu, même pied RGPD et mêmes
 * contrôles (aucune mention commerciale, au moins une question).
 *
 * Notaire : le message ne cite ni le cahier des conditions de vente, ni le procès-verbal descriptif, ni la
 * garantie pour enchérir, ni l'audience, et n'invite pas à joindre de documents. Le lien de dépôt de pièces
 * n'est donc pas ajouté à ce message (`informationAgentAudienceInvitesDocuments`).
 */
import {
  DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  type InformationAgentEmailTemplateContent,
} from "@/lib/information-agent-email-template";
import type { InformationAgentQuestionAudience } from "@/lib/information-agent/recipient-questions";

const block = (id: string) => {
  const found = DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE.blocks.find((entry) => entry.id === id);
  if (!found) throw new Error(`Default email template has no block "${id}"`);
  return found;
};

const NOTARY_REPLY_INSTRUCTIONS =
  "Répondre est facultatif. Nous ne demandons que des informations déjà destinées aux candidats acquéreurs : celles de l’annonce et du cahier des charges. Ne nous transmettez rien d’autre : votre secret professionnel prime sur notre demande.";

const STATE_SERVICE_REPLY_INSTRUCTIONS =
  "Répondre est facultatif. Nous ne demandons que des informations déjà destinées aux candidats à l’acquisition. Les règles de votre administration priment sur notre demande.";

const REPLY_BY_EMAIL = "Un simple retour à cet email suffit ; aucun compte n’est nécessaire.";

function listingFieldTemplate(
  name: string,
  identity: string,
  replyInstructions: string,
): InformationAgentEmailTemplateContent {
  return {
    name,
    // Ni « audience » ni date de procédure dans l'objet : le bien et la demande suffisent.
    subjectTemplate: "{{sale_subject_title}} : vérification de l’annonce",
    blocks: [
      block("greeting"),
      { ...block("identity"), content: identity },
      { ...block("sale_details"), content: "Vente concernée : {{sale_reference}}" },
      {
        ...block("request_intro"),
        content:
          "Ces informations manquent à la fiche ou y sont contradictoires. Une réponse même partielle nous est utile ; notre équipe la relit avant toute mise à jour de la fiche.",
      },
      block("questions"),
      {
        ...block("reply_instructions"),
        content: `${replyInstructions}\n\n${REPLY_BY_EMAIL}`,
      },
      block("closing"),
    ],
  };
}

export const NOTARY_EMAIL_TEMPLATE = listingFieldTemplate(
  "Demande à un notaire : champs de la fiche — version 1",
  "Immojudis est un site privé d’information sur les ventes immobilières aux enchères, destiné aux candidats acquéreurs. Il ne vend aucun bien et n’agit au nom d’aucun office ni d’aucun tribunal. Nous souhaitons vérifier avec vous quelques points de la fiche que nous publions sur cette vente :",
  NOTARY_REPLY_INSTRUCTIONS,
);

export const STATE_SERVICE_EMAIL_TEMPLATE = listingFieldTemplate(
  "Demande à un service de l’État : champs de la fiche — version 1",
  "Immojudis est un site privé d’information sur les ventes immobilières, destiné aux candidats à l’acquisition. Il ne vend aucun bien et n’agit au nom d’aucune administration ni d’aucun tribunal. Nous souhaitons vérifier avec vous quelques points de la fiche que nous publions sur cette cession :",
  STATE_SERVICE_REPLY_INSTRUCTIONS,
);

/** Modèle propre au destinataire, ou `null` quand le modèle publié des professionnels s'applique. */
export function informationAgentAudienceTemplate(
  audience: InformationAgentQuestionAudience,
): InformationAgentEmailTemplateContent | null {
  if (audience === "notary") return NOTARY_EMAIL_TEMPLATE;
  if (audience === "state_service") return STATE_SERVICE_EMAIL_TEMPLATE;
  return null;
}

/** Le message propose-t-il le lien de dépôt de pièces ? Jamais à un notaire (aucune invitation à joindre). */
export function informationAgentAudienceInvitesDocuments(audience: unknown): boolean {
  return audience !== "notary";
}
