import { AUTH_EMAIL_TEMPLATES, buildAuthEmailTemplate } from "@/lib/auth-email-templates";
import { SAMPLE_APP_URL, SAMPLE_RECIPIENT } from "../samples";
import type { EmailTemplateDefinition } from "../types";

/**
 * Emails d'authentification de Supabase Auth : le HTML est celui de `buildAuthEmailTemplate`, que le
 * propriétaire colle dans Supabase (Authentication > Emails). Lecture seule ici : la copie de référence
 * se règle dans `src/lib/auth-email-templates.ts`. Expéditeur : le SMTP de Supabase, hors environnement
 * d'Immojudis.
 */

/** Variables Go de Supabase remplacées par des exemples dans l'aperçu (jamais dans le HTML à coller). */
const GO_VARIABLE_EXAMPLES: Record<string, string> = {
  ".SiteURL": SAMPLE_APP_URL,
  ".TokenHash": "jeton-exemple",
  ".RedirectTo": `${SAMPLE_APP_URL}/compte`,
  ".ConfirmationURL": `${SAMPLE_APP_URL}/auth/confirmer?exemple=1`,
  ".Email": SAMPLE_RECIPIENT,
  ".NewEmail": "marie.durand@nouvelle-adresse.fr",
  ".Token": "123456",
};

/** `{{ .Variable }}`, ou `{{ .Variable | urlquery }}` (lien en clair des gabarits), encodé comme Go. */
export function fillGoVariables(html: string): string {
  return html.replace(
    /\{\{\s*(\.[A-Za-z]+)(\s*\|\s*urlquery)?\s*\}\}/g,
    (match, name: string, urlquery: string | undefined) => {
      const example = GO_VARIABLE_EXAMPLES[name];
      if (example === undefined) return match;
      return urlquery ? encodeURIComponent(example) : example;
    },
  );
}

const DESCRIPTIONS: Record<string, string> = {
  confirmation: "Après l’inscription : confirmer l’adresse email du compte.",
  recovery: "Mot de passe oublié : lien pour en choisir un nouveau.",
  email_change: "Changement d’adresse email du compte : confirmation de la nouvelle adresse.",
  invite: "Invitation à rejoindre Immojudis (non émise par l’application aujourd’hui).",
  magic_link: "Lien de connexion sans mot de passe (non émis par l’application aujourd’hui).",
  reauthentication: "Code à saisir pour confirmer une action sensible (non émis aujourd’hui).",
};

export const AUTH_TEMPLATES: readonly EmailTemplateDefinition[] = AUTH_EMAIL_TEMPLATES.map(
  (definition) => ({
    key: `auth_${definition.id}`,
    label: `Authentification : ${definition.heading}`,
    description: DESCRIPTIONS[definition.id] ?? "Email d’authentification de Supabase.",
    category: null,
    sender: null,
    level: "supabase" as const,
    async sample() {
      const pasteHtml = buildAuthEmailTemplate(definition, "token-hash");
      return [
        {
          key: "token-hash",
          label: "Lien vers la page /auth/confirmer",
          subject: definition.subject,
          html: fillGoVariables(pasteHtml),
          text: "",
          pasteHtml,
        },
      ];
    },
  }),
);
