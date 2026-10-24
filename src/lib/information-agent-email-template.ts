import { z } from "zod";

export const INFORMATION_AGENT_EMAIL_VARIABLES = [
  {
    key: "recipient_name",
    label: "Nom du destinataire",
    example: "Maître Dupont",
  },
  {
    key: "salutation",
    label: "Formule d’appel adaptée au destinataire",
    example: "Bonjour Maître Dupont,",
  },
  {
    key: "sale_title",
    label: "Titre de l’annonce",
    example: "Appartement T3 à Bordeaux",
  },
  {
    key: "sale_subject_title",
    label: "Titre court pour l’objet",
    example: "Appartement T3 à Bordeaux",
  },
  {
    key: "sale_reference",
    label: "Référence complète de la vente",
    example: "Appartement T3 à Bordeaux — 33000 Bordeaux — Tribunal judiciaire de Bordeaux",
  },
  {
    key: "location",
    label: "Localisation",
    example: "33000 Bordeaux",
  },
  {
    key: "tribunal",
    label: "Tribunal",
    example: "Tribunal judiciaire de Bordeaux",
  },
  {
    key: "hearing_date",
    label: "Date d’audience",
    example: "14 septembre 2026",
  },
  {
    key: "hearing_line",
    label: "Ligne d’audience, omise si la date manque",
    example: "Audience annoncée : 14 septembre 2026",
  },
  {
    key: "subject_date",
    label: "Date courte pour l’objet",
    example: "audience du 14/09/2026",
  },
  {
    key: "starting_price",
    label: "Mise à prix",
    example: "85 000 €",
  },
  {
    key: "price_line",
    label: "Ligne de mise à prix, omise si le montant manque",
    example: "Mise à prix annoncée : 85 000 €",
  },
  {
    key: "questions",
    label: "Questions adaptées aux informations manquantes",
    example: "- Le cahier des conditions de vente est-il disponible ?",
  },
] as const;

export type InformationAgentEmailVariable =
  (typeof INFORMATION_AGENT_EMAIL_VARIABLES)[number]["key"];

export const INFORMATION_AGENT_EMAIL_BLOCK_DEFINITIONS = [
  { id: "greeting", kind: "dynamic", label: "Formule d’appel" },
  { id: "identity", kind: "fixed", label: "Objet du message" },
  { id: "sale_details", kind: "dynamic", label: "Informations de la vente" },
  { id: "request_intro", kind: "fixed", label: "Introduction de la demande" },
  { id: "questions", kind: "dynamic", label: "Questions adaptées à l’annonce" },
  { id: "reply_instructions", kind: "fixed", label: "Consignes de réponse" },
  { id: "closing", kind: "fixed", label: "Conclusion et signature" },
] as const;

export type InformationAgentEmailBlockId =
  (typeof INFORMATION_AGENT_EMAIL_BLOCK_DEFINITIONS)[number]["id"];
export type InformationAgentEmailBlockKind = "fixed" | "dynamic";

export type InformationAgentEmailBlock = {
  id: InformationAgentEmailBlockId;
  kind: InformationAgentEmailBlockKind;
  label: string;
  content: string;
};

export type InformationAgentEmailTemplateContent = {
  name: string;
  subjectTemplate: string;
  blocks: InformationAgentEmailBlock[];
};

export type InformationAgentEmailTemplateSummary = InformationAgentEmailTemplateContent & {
  id: string;
  revision: number;
  status: "draft" | "published" | "archived";
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
};

export type InformationAgentEmailTemplateWorkspace = {
  published: InformationAgentEmailTemplateSummary;
  /** Vrai quand le modèle publié est antérieur à `minCompliantRevision` : il est ignoré. */
  publishedIgnored: boolean;
  minCompliantRevision: number;
  /** Modèle du code, utilisé tant que le modèle publié est ignoré. */
  fallback: InformationAgentEmailTemplateContent & { revision: number };
  draft: InformationAgentEmailTemplateSummary | null;
  history: InformationAgentEmailTemplateSummary[];
  variables: typeof INFORMATION_AGENT_EMAIL_VARIABLES;
  protectedBlocks: Array<{ title: string; description: string }>;
};

export type InformationAgentEmailTemplatePreview = {
  subject: string;
  bodyText: string;
  html: string;
  text: string;
};

/**
 * Ancien bloc « Vous avez d’autres ventes à partager ? » que des modèles publiés ou des brouillons
 * peuvent encore contenir dans leur texte éditable. Les emails aux professionnels restent purement
 * informatifs (décision du 13 octobre 2026) : ce bloc est toujours retiré du corps, ainsi que
 * l'ancienne phrase fixe « Vous publiez d’autres ventes ? ».
 */
export const INFORMATION_AGENT_ACCOUNT_INVITATION_HEADING =
  "Vous avez d’autres ventes à partager ?";
export const INFORMATION_AGENT_ACCOUNT_INVITATION_CTA = "Créer un compte professionnel";
export const INFORMATION_AGENT_ACCOUNT_INVITATION_LEGACY_TEXT = "Vous publiez d’autres ventes ?";

export const INFORMATION_AGENT_EMAIL_TEMPLATE_REVISION = 9;

/**
 * Révision minimale d'un modèle publié en base pour qu'il soit utilisé. Un modèle publié avant cette
 * révision (présentation commerciale d'Immojudis, invitation à créer un compte…) est ignoré au profit
 * du modèle du code, sans rien écrire en base ; un nouveau modèle publié depuis l'éditeur reprend la
 * numérotation après cette révision (migration `information_agent_legal_safeguards`). Les révisions 8 et 9
 * ne changent que la rédaction : le seuil de conformité reste la révision 7.
 */
export const MIN_COMPLIANT_TEMPLATE_REVISION = 7;

export type InformationAgentEmailRenderOptions = {
  /** Environment origin of the site (kept for callers that build absolute links). */
  appUrl?: string;
};

/** True for the legacy invitation block written in an editable template. */
export function containsInformationAgentAccountInvitation(text: string): boolean {
  return (
    text.includes(INFORMATION_AGENT_ACCOUNT_INVITATION_HEADING) ||
    text.includes(INFORMATION_AGENT_ACCOUNT_INVITATION_LEGACY_TEXT) ||
    text.includes(`${INFORMATION_AGENT_ACCOUNT_INVITATION_CTA} :`)
  );
}

/** Drops every paragraph of `text` that belongs to the legacy account invitation. */
export function stripInformationAgentAccountInvitation(text: string): string {
  return text
    .split(/\n\s*\n/)
    .filter((paragraph) => !containsInformationAgentAccountInvitation(paragraph))
    .join("\n\n")
    .trim();
}

const variableKeySchema = z.enum(
  INFORMATION_AGENT_EMAIL_VARIABLES.map((variable) => variable.key) as [
    InformationAgentEmailVariable,
    ...InformationAgentEmailVariable[],
  ],
);
const blockIdSchema = z.enum(
  INFORMATION_AGENT_EMAIL_BLOCK_DEFINITIONS.map((block) => block.id) as [
    InformationAgentEmailBlockId,
    ...InformationAgentEmailBlockId[],
  ],
);

export const informationAgentEmailBlockSchema = z.object({
  id: blockIdSchema,
  kind: z.enum(["fixed", "dynamic"]),
  label: z.string().trim().min(2).max(100),
  content: z.string().trim().min(1).max(4000),
});

export const informationAgentEmailTemplateContentSchema = z
  .object({
    name: z.string().trim().min(3).max(120),
    subjectTemplate: z
      .string()
      .trim()
      .min(3)
      .max(200)
      .refine((value) => !/[\r\n]/.test(value), "L’objet doit tenir sur une ligne."),
    blocks: z
      .array(informationAgentEmailBlockSchema)
      .length(INFORMATION_AGENT_EMAIL_BLOCK_DEFINITIONS.length),
  })
  .superRefine((value, context) => {
    const expectedById = new Map(
      INFORMATION_AGENT_EMAIL_BLOCK_DEFINITIONS.map((block) => [block.id, block]),
    );
    const seen = new Set<string>();
    for (const [index, block] of value.blocks.entries()) {
      const definition = expectedById.get(block.id);
      if (!definition || seen.has(block.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["blocks", index, "id"],
          message: "Bloc inconnu ou présent plusieurs fois.",
        });
        continue;
      }
      seen.add(block.id);
      if (block.kind !== definition.kind) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["blocks", index, "kind"],
          message: "La nature fixe ou dynamique du bloc ne peut pas être modifiée.",
        });
      }
      validateTemplateVariables(block.content, ["blocks", index, "content"], context);
      if (block.kind === "fixed" && /{{\s*[a-z_]+\s*}}/.test(block.content)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["blocks", index, "content"],
          message: "Un bloc fixe ne peut pas contenir de variable dynamique.",
        });
      }
    }
    if (seen.size !== INFORMATION_AGENT_EMAIL_BLOCK_DEFINITIONS.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blocks"],
        message: "Tous les blocs obligatoires doivent être conservés.",
      });
    }
    if (value.blocks.reduce((total, block) => total + block.content.length, 0) > 7000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blocks"],
        message: "Le contenu total des blocs ne peut pas dépasser 7 000 caractères.",
      });
    }
    const questionBlock = value.blocks.find((block) => block.id === "questions");
    if (!questionBlock?.content.includes("{{questions}}")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blocks"],
        message: "Le bloc Questions doit conserver la variable {{questions}}.",
      });
    }
    validateTemplateVariables(value.subjectTemplate, ["subjectTemplate"], context, false);
  });

export const DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE: InformationAgentEmailTemplateContent = {
  name: "Demande de précisions sur une vente — version 10",
  subjectTemplate: "{{sale_subject_title}}, {{subject_date}} : vérification de l’annonce",
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
        "Immojudis est un site privé d’information sur les ventes immobilières aux enchères, destiné aux candidats acquéreurs. Il ne vend aucun bien et n’agit pas au nom d’un tribunal. Nous souhaitons vérifier avec vous quelques points de la fiche que nous publions sur cette vente :",
    },
    {
      id: "sale_details",
      kind: "dynamic",
      label: "Informations de la vente",
      content: "Vente concernée : {{sale_reference}}\n{{hearing_line}}\n{{price_line}}",
    },
    {
      id: "request_intro",
      kind: "fixed",
      label: "Introduction de la demande",
      content:
        "Ces informations manquent à la fiche ou y sont contradictoires. Une réponse même partielle nous est utile ; notre équipe la relit avant toute mise à jour de la fiche.",
    },
    {
      id: "questions",
      kind: "dynamic",
      label: "Questions adaptées à l’annonce",
      content: "{{questions}}",
    },
    {
      id: "reply_instructions",
      kind: "fixed",
      label: "Consignes de réponse",
      content:
        "Répondre est facultatif. Le plus simple : un retour à cet email, avec les documents ou photos que vous êtes autorisé à partager. Aucun compte n’est nécessaire.\n\nNe communiquez que ce qui est communicable à tout candidat acquéreur (cahier des conditions de vente, procès-verbal descriptif, diagnostics, dates de visite, mise à prix, garantie exigée pour enchérir, audience) : votre secret professionnel prime sur notre demande. Si ce dossier est suivi par un collaborateur ou un autre interlocuteur, vous pouvez lui transférer ce message.",
    },
    {
      id: "closing",
      kind: "fixed",
      label: "Conclusion et signature",
      content:
        "Merci par avance : une fiche exacte évite aux candidats de vous interroger sur des points déjà connus.\n\nBien cordialement,\nL’équipe Immojudis",
    },
  ],
};

export const INFORMATION_AGENT_PROTECTED_EMAIL_BLOCKS = [
  {
    title: "Identité et indépendance",
    description:
      "Le bandeau Immojudis et la mention précisant que le service n’agit pas au nom d’un tribunal restent toujours affichés.",
  },
  {
    title: "Transparence sur l’IA",
    description:
      "Le destinataire est informé que l’IA aide à lire et classer les réponses et que l’équipe vérifie les informations avant toute mise à jour de la fiche.",
  },
  {
    title: "Confidentialité et droits",
    description:
      "Le message rappelle que seules les pièces autorisées peuvent être transmises et que la réponse doit suivre l’adresse liée au dossier.",
  },
  {
    title: "Informations RGPD et opposition",
    description:
      "Le pied du message est ajouté automatiquement (art. 14 RGPD) : finalité et base, catégories de données, origine de l’adresse (type de source, lien, date), destinataires et prestataires dont l’outil d’IA, durées de conservation, droits, droit d’opposition en un clic et réclamation auprès de la CNIL.",
  },
  {
    title: "Aucune sollicitation commerciale",
    description:
      "Aucune sollicitation commerciale : toute invitation à créer un compte est retirée du corps du message, et un contrôle automatique refuse offres, comptes, mise en avant, prix et liens vers les offres ou l’inscription.",
  },
] as const;

export function parseInformationAgentEmailTemplateContent(input: {
  name: unknown;
  subjectTemplate: unknown;
  blocks: unknown;
}): InformationAgentEmailTemplateContent {
  return informationAgentEmailTemplateContentSchema.parse(input);
}

export function renderInformationAgentEmailContent({
  template,
  values,
}: {
  template: InformationAgentEmailTemplateContent;
  values: Record<InformationAgentEmailVariable, string>;
} & InformationAgentEmailRenderOptions): { subject: string; bodyText: string } {
  const parsed = informationAgentEmailTemplateContentSchema.parse(template);
  const renderedBlocks = parsed.blocks.map((block) => ({
    id: block.id,
    content: stripInformationAgentAccountInvitation(renderTemplateText(block.content, values)),
  }));

  const bodyText = renderedBlocks
    .map((block) => block.content)
    .filter(Boolean)
    .join("\n\n");
  if (bodyText.length > 8000) {
    throw new Error("Le template produit un email trop long.");
  }
  return {
    subject: renderTemplateText(parsed.subjectTemplate, values).slice(0, 200),
    bodyText,
  };
}

// `templateVariableToken` (jeton `{{clé}}`) est dans `information-agent-email-template-token.ts` :
// l'éditeur de l'administration l'importe sans embarquer les schémas zod de ce module.

const TEMPLATE_VARIABLE_PATTERN = /{{\s*([^{}]+?)\s*}}/g;

function renderTemplateText(
  input: string,
  values: Record<InformationAgentEmailVariable, string>,
): string {
  return input.replace(TEMPLATE_VARIABLE_PATTERN, (_, rawKey: string) => {
    const key = variableKeySchema.parse(rawKey.trim());
    return values[key];
  });
}

function validateTemplateVariables(
  input: string,
  path: Array<string | number>,
  context: z.RefinementCtx,
  allowQuestions = true,
) {
  for (const match of input.matchAll(TEMPLATE_VARIABLE_PATTERN)) {
    const key = variableKeySchema.safeParse(match[1]?.trim());
    if (!key.success || (!allowQuestions && key.data === "questions")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: `Variable non autorisée : ${match[0]}.`,
      });
    }
  }
  const withoutTokens = input.replace(TEMPLATE_VARIABLE_PATTERN, "");
  if (withoutTokens.includes("{{") || withoutTokens.includes("}}")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: "Une variable est incomplète ou mal formée.",
    });
  }
}
