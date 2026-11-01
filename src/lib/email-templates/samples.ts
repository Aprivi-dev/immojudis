import type { ResendEmailMessage } from "@/lib/email-alerts";
import type { EmailSampleVariant } from "./types";

/**
 * Données fictives des aperçus. Rien ici ne vient de la base ni de l'environnement : les jetons des
 * liens (désinscription, clic) sont signés avec `SAMPLE_ENV`, une clé factice, donc inutilisables en
 * production. Dates fixes : un aperçu est le même d'un jour à l'autre.
 */
export const SAMPLE_APP_URL = "https://immojudis.com";
export const SAMPLE_FROM = "Immojudis <exemple@immojudis.com>";
export const SAMPLE_RECIPIENT = "marie.durand@exemple.fr";
export const SAMPLE_NOW = new Date("2026-11-02T08:00:00Z");
/** 6 novembre 2026, 10 h UTC, en secondes Unix (dates de Stripe). */
export const SAMPLE_UNIX_SECONDS = 1_793_959_200;

export const SAMPLE_USER_ID = "11111111-1111-4111-8111-111111111111";
export const SAMPLE_SALE_A = "22222222-2222-4222-8222-222222222222";
export const SAMPLE_SALE_B = "33333333-3333-4333-8333-333333333333";
export const SAMPLE_SALE_C = "44444444-4444-4444-8444-444444444444";
export const SAMPLE_ALERT_A = "55555555-5555-4555-8555-555555555555";
export const SAMPLE_ALERT_B = "66666666-6666-4666-8666-666666666666";

/** Clé de signature factice, passée aux constructeurs à la place de l'environnement du serveur. */
export const SAMPLE_ENV: Pick<NodeJS.ProcessEnv, string> = {
  EMAIL_UNSUBSCRIBE_SECRET: "apercu-factice-apercu-factice-apercu-factice",
  SITE_URL: SAMPLE_APP_URL,
};

/** Un message Resend construit par un constructeur du dépôt, ramené à une variante d'aperçu. */
export function variantFromMessage(
  key: string,
  label: string,
  message: Pick<ResendEmailMessage, "subject" | "html" | "text">,
): EmailSampleVariant {
  return { key, label, subject: message.subject, html: message.html, text: message.text };
}
