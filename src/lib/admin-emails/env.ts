import "server-only";

/**
 * Seules variables d'environnement que le module « Emails » lit, une par une et par leur nom écrit
 * en toutes lettres : jamais `process.env` en entier, jamais un nom venu d'une requête. Les adresses
 * (expéditeurs, destinataires, domaine de réception) sont affichées ; les secrets ne sont jamais lus
 * que pour dire s'ils sont renseignés.
 */
const EMAIL_ADDRESS_VARIABLES = [
  "ALERT_EMAIL_FROM",
  "NOREPLY_EMAIL_FROM",
  "RESEND_FROM_EMAIL",
  "TRANSACTIONAL_EMAIL_FROM",
  "INFORMATION_AGENT_EMAIL_FROM",
  "CONTACT_EMAIL_FROM",
  "EMAIL_REPLY_TO",
  "NEXT_PUBLIC_LEGAL_CONTACT_EMAIL",
  "CONTACT_EMAIL_TO",
  "OPERATIONS_ALERT_EMAIL_TO",
  "INFORMATION_AGENT_INBOUND_DOMAIN",
] as const;
export type EmailAddressVariable = (typeof EMAIL_ADDRESS_VARIABLES)[number];
export type EmailAddressEnv = Record<EmailAddressVariable, string | undefined>;

export const EMAIL_SECRET_VARIABLES = [
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "RESEND_ACCOUNT_WEBHOOK_SECRET",
  "INFORMATION_AGENT_PORTAL_SECRET",
] as const;
export type EmailSecretVariable = (typeof EMAIL_SECRET_VARIABLES)[number];

/** Valeurs des variables d'adresses (liste blanche). Sert de source aux fonctions `resolve…` du dépôt. */
export function readEmailAddressEnv(): EmailAddressEnv {
  return {
    ALERT_EMAIL_FROM: process.env.ALERT_EMAIL_FROM,
    NOREPLY_EMAIL_FROM: process.env.NOREPLY_EMAIL_FROM,
    RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
    TRANSACTIONAL_EMAIL_FROM: process.env.TRANSACTIONAL_EMAIL_FROM,
    INFORMATION_AGENT_EMAIL_FROM: process.env.INFORMATION_AGENT_EMAIL_FROM,
    CONTACT_EMAIL_FROM: process.env.CONTACT_EMAIL_FROM,
    EMAIL_REPLY_TO: process.env.EMAIL_REPLY_TO,
    NEXT_PUBLIC_LEGAL_CONTACT_EMAIL: process.env.NEXT_PUBLIC_LEGAL_CONTACT_EMAIL,
    CONTACT_EMAIL_TO: process.env.CONTACT_EMAIL_TO,
    OPERATIONS_ALERT_EMAIL_TO: process.env.OPERATIONS_ALERT_EMAIL_TO,
    INFORMATION_AGENT_INBOUND_DOMAIN: process.env.INFORMATION_AGENT_INBOUND_DOMAIN,
  };
}

/** Un booléen par secret : ni la valeur, ni un préfixe, ni la longueur. */
export function readEmailSecretsConfigured(): Record<EmailSecretVariable, boolean> {
  return {
    RESEND_API_KEY: Boolean(process.env.RESEND_API_KEY?.trim()),
    RESEND_WEBHOOK_SECRET: Boolean(process.env.RESEND_WEBHOOK_SECRET?.trim()),
    RESEND_ACCOUNT_WEBHOOK_SECRET: Boolean(process.env.RESEND_ACCOUNT_WEBHOOK_SECRET?.trim()),
    INFORMATION_AGENT_PORTAL_SECRET: Boolean(process.env.INFORMATION_AGENT_PORTAL_SECRET?.trim()),
  };
}

/** Clé de l'API Resend, pour les seuls appels de lecture du module ; jamais renvoyée au navigateur. */
export function readResendApiKey(): string | null {
  return process.env.RESEND_API_KEY?.trim() || null;
}
