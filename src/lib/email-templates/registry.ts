import { AGENT_EMAIL_TEMPLATES } from "./definitions/agent";
import { ACCOUNT_EMAIL_TEMPLATES } from "./definitions/account";
import { AUTH_TEMPLATES } from "./definitions/auth";
import { BILLING_EMAIL_TEMPLATES } from "./definitions/billing";
import { OPERATIONS_EMAIL_TEMPLATES } from "./definitions/operations";
import type { EmailSenderVariable, EmailTemplateDefinition, EmailTemplateLevel } from "./types";

export type { EmailSenderVariable, EmailTemplateDefinition };

/** Tous les emails d'Immojudis, dans l'ordre de présentation. */
export const EMAIL_TEMPLATES: readonly EmailTemplateDefinition[] = [
  ...ACCOUNT_EMAIL_TEMPLATES,
  ...BILLING_EMAIL_TEMPLATES,
  ...OPERATIONS_EMAIL_TEMPLATES,
  ...AGENT_EMAIL_TEMPLATES,
  ...AUTH_TEMPLATES,
];

/** Ce que la liste des modèles affiche d'un gabarit : jamais sa fonction `sample`. */
export type EmailTemplateSummary = {
  key: string;
  label: string;
  description: string;
  category: string | null;
  sender: EmailSenderVariable | null;
  level: EmailTemplateLevel;
  previewable: boolean;
};

export function summarizeEmailTemplate(definition: EmailTemplateDefinition): EmailTemplateSummary {
  return {
    key: definition.key,
    label: definition.label,
    description: definition.description,
    category: definition.category,
    sender: definition.sender,
    level: definition.level,
    previewable: Boolean(definition.sample),
  };
}

/** Gabarits qui partent de l'expéditeur donné (rubrique « Expéditeurs » de l'onglet Adresses). */
export function emailTemplatesUsingSender(
  sender: EmailSenderVariable,
  templates: readonly EmailTemplateDefinition[] = EMAIL_TEMPLATES,
): EmailTemplateDefinition[] {
  return templates.filter((definition) => definition.sender === sender);
}
