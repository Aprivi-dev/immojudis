import type { InformationAgentEmailTemplateContent } from "@/lib/information-agent-email-template";

/**
 * Message adressé à un greffe (contact de secours d'une vente au tribunal, voir
 * `court-registry-fallback.ts`). Un greffe ne connaît pas les détails d'une vente et oriente vers
 * l'avocat poursuivant : on ne lui pose donc PAS les questions adressées à un avocat (date, mise à
 * prix, occupation, visites, diagnostics…). La demande tient en une question : qui est l'avocat
 * poursuivant, ou, à défaut, quelles pièces publiques de la vente peut-il transmettre.
 *
 * Même structure de blocs que le modèle des professionnels (`DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE`),
 * donc même rendu, même pied RGPD et mêmes contrôles (aucune mention commerciale, au moins une
 * question). Aucun nom de personne : « Madame, Monsieur, ».
 */
export const COURT_REGISTRY_QUESTION =
  "Pouvez-vous nous indiquer l’avocat poursuivant de cette vente, ou nous transmettre les pièces publiques du dossier (cahier des conditions de vente, procès-verbal descriptif) lorsqu’elles sont communicables à tout candidat acquéreur ?";

export const COURT_REGISTRY_EMAIL_TEMPLATE: InformationAgentEmailTemplateContent = {
  name: "Demande à un greffe : avocat poursuivant ou pièces publiques — version 1",
  subjectTemplate:
    "{{sale_subject_title}}, {{subject_date}} : avocat poursuivant ou pièces publiques",
  blocks: [
    {
      id: "greeting",
      kind: "dynamic",
      label: "Formule d’appel",
      content: "{{salutation}}",
    },
    {
      id: "identity",
      kind: "fixed",
      label: "Objet du message",
      content:
        "Immojudis est un site privé d’information sur les ventes immobilières aux enchères, destiné aux candidats acquéreurs. Il ne vend aucun bien et n’agit pas au nom d’un tribunal. Nous vous écrivons au sujet d’une vente annoncée devant votre tribunal :",
    },
    {
      id: "sale_details",
      kind: "dynamic",
      label: "Informations de la vente",
      content: "Vente concernée : {{sale_reference}}\n{{hearing_line}}",
    },
    {
      id: "request_intro",
      kind: "fixed",
      label: "Introduction de la demande",
      content:
        "Nous savons que le greffe n’a pas à détailler les ventes et que les enchères sont portées par l’avocat poursuivant. L’annonce ne nous donne pas son adresse : notre demande se limite donc à ceci.",
    },
    {
      id: "questions",
      kind: "dynamic",
      label: "Question adressée au greffe",
      content: "{{questions}}",
    },
    {
      id: "reply_instructions",
      kind: "fixed",
      label: "Consignes de réponse",
      content:
        "Répondre est facultatif. Le plus simple : un retour à cet email. Vous pouvez aussi le transférer au service concerné. Aucun compte n’est nécessaire.\n\nNe communiquez que ce qui est communicable à tout candidat acquéreur : les règles de communication de la juridiction priment sur notre demande.",
    },
    {
      id: "closing",
      kind: "fixed",
      label: "Conclusion et signature",
      content: "Merci par avance de votre aide.\n\nBien cordialement,\nL’équipe Immojudis",
    },
  ],
};
