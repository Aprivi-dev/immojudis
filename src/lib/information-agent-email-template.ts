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
  { id: "identity", kind: "fixed", label: "Présentation Immojudis" },
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

/**
 * This invitation is appended while rendering an email, rather than stored in
 * the editable seven-block template. That keeps the account CTA present for
 * legacy templates already published in the database and prevents an admin
 * from accidentally removing it while editing the copy.
 */
export const INFORMATION_AGENT_ACCOUNT_INVITATION_EYEBROW = "POUR LES PROFESSIONNELS";
export const INFORMATION_AGENT_ACCOUNT_INVITATION_HEADING =
  "Vous avez d’autres ventes à partager ?";
export const INFORMATION_AGENT_ACCOUNT_INVITATION_DESCRIPTION =
  "Vous pouvez créer un compte professionnel Immojudis pour transmettre vos propres annonces à notre équipe, faire connaître les ventes retenues dans notre catalogue et suivre leur examen. Chaque publication reste soumise à validation. C’est facultatif : répondre à cet email suffit pour ce dossier.";
export const INFORMATION_AGENT_ACCOUNT_INVITATION_CTA = "Créer un compte professionnel";

export const INFORMATION_AGENT_EMAIL_TEMPLATE_REVISION = 4;

export type InformationAgentEmailRenderOptions = {
  /** Environment origin used to build the professional account URL. */
  appUrl?: string;
  /** Fully-qualified account URL, useful when the caller already built it. */
  accountUrl?: string;
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
  name: "Demande de précisions sur une vente — version 4",
  subjectTemplate: "{{sale_subject_title}} — précisions pour Immojudis",
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
      label: "Présentation Immojudis",
      content:
        "Immojudis est un service indépendant qui aide les acquéreurs à mieux préparer les ventes judiciaires. Nous complétons la fiche ci-dessous et votre connaissance du dossier nous serait précieuse.",
    },
    {
      id: "sale_details",
      kind: "dynamic",
      label: "Informations de la vente",
      content: "Référence de l’annonce : {{sale_reference}}\n{{hearing_line}}",
    },
    {
      id: "request_intro",
      kind: "fixed",
      label: "Introduction de la demande",
      content:
        "Pourriez-vous nous préciser les points suivants ou nous transmettre les pièces utiles ? Une réponse même partielle nous aide à présenter un dossier plus clair et à limiter les demandes répétées.",
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
        "Un simple retour à cet email suffit, avec les documents ou photos que vous êtes autorisé à partager. Aucun compte n’est nécessaire. Si ce dossier relève d’un autre interlocuteur, son contact nous serait utile.",
    },
    {
      id: "closing",
      kind: "fixed",
      label: "Conclusion et signature",
      content:
        "Merci pour votre aide : votre réponse contribuera à rendre cette fiche plus utile aux personnes qui étudient la vente.\n\nBien cordialement,\nL’équipe Immojudis",
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
    title: "Invitation au compte professionnel",
    description:
      "Une invitation facultative à créer un compte professionnel Immojudis est ajoutée automatiquement avant la conclusion, y compris pour les anciens modèles publiés.",
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
  appUrl,
  accountUrl,
}: {
  template: InformationAgentEmailTemplateContent;
  values: Record<InformationAgentEmailVariable, string>;
} & InformationAgentEmailRenderOptions): { subject: string; bodyText: string } {
  const parsed = informationAgentEmailTemplateContentSchema.parse(template);
  const resolvedAccountUrl = buildInformationAgentAccountUrl({ appUrl, accountUrl });
  const renderedBlocks: Array<{
    id: InformationAgentEmailBlockId | "account_invitation";
    content: string;
  }> = parsed.blocks.map((block) => ({
    id: block.id,
    content: renderTemplateText(block.content, values).trim(),
  }));
  const invitation = renderInformationAgentAccountInvitation(resolvedAccountUrl);

  if (!renderedBlocks.some((block) => block.content.includes(invitation))) {
    const closingIndex = renderedBlocks.findIndex((block) => block.id === "closing");
    renderedBlocks.splice(closingIndex < 0 ? renderedBlocks.length : closingIndex, 0, {
      id: "account_invitation",
      content: invitation,
    });
  }

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

export function buildInformationAgentAccountUrl({
  appUrl = "https://immojudis.com",
  accountUrl,
}: InformationAgentEmailRenderOptions = {}): string {
  if (accountUrl) return validateInformationAgentUrl(accountUrl);
  const url = new URL("/login", validateInformationAgentUrl(appUrl));
  url.searchParams.set("mode", "professional");
  url.searchParams.set("redirect", "/espace-pro");
  return url.toString();
}

export function renderInformationAgentAccountInvitation(accountUrl: string): string {
  return [
    INFORMATION_AGENT_ACCOUNT_INVITATION_EYEBROW,
    INFORMATION_AGENT_ACCOUNT_INVITATION_HEADING,
    INFORMATION_AGENT_ACCOUNT_INVITATION_DESCRIPTION,
    `${INFORMATION_AGENT_ACCOUNT_INVITATION_CTA} : ${accountUrl}`,
  ].join("\n");
}

function validateInformationAgentUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("L’URL de compte professionnel doit utiliser HTTP ou HTTPS.");
  }
  return parsed.toString();
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
