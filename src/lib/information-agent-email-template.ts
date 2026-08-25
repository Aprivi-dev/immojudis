import { z } from "zod";

export const INFORMATION_AGENT_EMAIL_VARIABLES = [
  {
    key: "recipient_name",
    label: "Nom du destinataire",
    example: "Maître Dupont",
  },
  {
    key: "sale_title",
    label: "Titre de l’annonce",
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
    key: "starting_price",
    label: "Mise à prix",
    example: "85 000 €",
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
  { id: "identity", kind: "fixed", label: "Présentation ImmoJudis" },
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
  name: "Demande d’informations — modèle initial",
  subjectTemplate: "Demande d’informations — {{sale_title}} — audience du {{hearing_date}}",
  blocks: [
    {
      id: "greeting",
      kind: "dynamic",
      label: "Formule d’appel",
      content: "Bonjour {{recipient_name}},",
    },
    {
      id: "identity",
      kind: "fixed",
      label: "Présentation ImmoJudis",
      content:
        "ImmoJudis est un service indépendant d’analyse des ventes immobilières judiciaires. Nous vous contactons à la demande d’un utilisateur intéressé par cette vente, après validation explicite de sa demande.",
    },
    {
      id: "sale_details",
      kind: "dynamic",
      label: "Informations de la vente",
      content:
        "Référence de l’annonce : {{sale_reference}}\nDate annoncée : {{hearing_date}}\nMise à prix annoncée : {{starting_price}}",
    },
    {
      id: "request_intro",
      kind: "fixed",
      label: "Introduction de la demande",
      content:
        "Afin de permettre une étude du dossier sur la base d’informations fiables et à jour, pourriez-vous nous préciser les éléments suivants ?",
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
        "Vous pouvez répondre directement à cet email et y joindre les documents ou photographies que vous êtes autorisé à communiquer. Votre réponse sera conservée dans un espace privé, analysée avec traçabilité puis contrôlée avant toute intégration aux données ImmoJudis.",
    },
    {
      id: "closing",
      kind: "fixed",
      label: "Conclusion et signature",
      content:
        "Nous vous remercions par avance pour votre aide et restons à votre disposition si vous souhaitez préciser le périmètre de cette demande.\n\nCordialement,\nL’équipe ImmoJudis",
    },
  ],
};

export const INFORMATION_AGENT_PROTECTED_EMAIL_BLOCKS = [
  {
    title: "Identité et indépendance",
    description:
      "Le bandeau ImmoJudis et la mention précisant que le message n’émane ni d’un tribunal ni d’une administration restent toujours affichés.",
  },
  {
    title: "Transparence sur l’IA",
    description:
      "Le destinataire est informé que l’IA assiste la lecture et qu’un contrôle précède toute modification de l’annonce ou de l’estimation.",
  },
  {
    title: "Confidentialité et droits",
    description:
      "Le message rappelle que l’adresse de l’utilisateur reste privée et que seules les pièces autorisées peuvent être transmises.",
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
}): { subject: string; bodyText: string } {
  const parsed = informationAgentEmailTemplateContentSchema.parse(template);
  const bodyText = parsed.blocks
    .map((block) => renderTemplateText(block.content, values).trim())
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

export function templateVariableToken(key: InformationAgentEmailVariable): string {
  return `{{${key}}}`;
}

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
