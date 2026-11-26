// Sans zod ni import serveur : la case de « Mon compte » et celle de /bienvenue n'ont besoin que du
// texte ; la route serveur (`notification-preferences.ts`) lit la version.

/**
 * Texte de la case de consentement aux emails de nouveautés et d'offres d'Immojudis, le même dans
 * « Mon compte » (`MarketingEmailsToggle`) et à la dernière étape de `/bienvenue`
 * (`InvestorOnboarding`). Provisoire : à faire valider par un avocat.
 *
 * Le texte et sa version changent ensemble : la version est conservée avec la date du consentement
 * (`marketing_emails_consent_text_version`), pour savoir à quel libellé chaque personne a consenti.
 * Elle est posée par le serveur, jamais par le client.
 */
export const MARKETING_EMAILS_CONSENT_TEXT_VERSION = "2026-11-26.1";
export const MARKETING_EMAILS_CONSENT_TEXT =
  "Recevoir par email les nouveautés et les offres d’Immojudis (au plus deux messages par mois). Vous pouvez vous désinscrire à tout moment depuis votre compte ou par le lien de chaque email.";
