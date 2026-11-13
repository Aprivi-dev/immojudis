import "server-only";
import { renderTrialEndEmail } from "../../emails/trial-end";
import type { ResendEmailMessage } from "@/lib/email-alerts";
import { emailNoReplyText } from "@/lib/email-layout";
import { formatDate } from "@/lib/format/dates";
import { createUnsubscribeToken } from "@/lib/email-unsubscribe-token";
import {
  LAUNCH_OFFER_END_NEEDS_ANALYSIS,
  LAUNCH_OFFER_END_STAYS,
} from "@/lib/launch-offer-end-lists";
import { LAUNCH_OFFER_DATA_TEXT } from "@/lib/launch-offer";
import { analysisCheckoutReadiness } from "@/lib/analysis-checkout-readiness";

/**
 * Email unique de fin d'essai gratuit, à J+5 après la confirmation de l'adresse (l'essai dure 7 jours).
 * Sans pression : ce qui reste gratuit, ce qui se ferme, le fait que rien ne devient payant, et un seul
 * lien : « Être prévenu de l'ouverture » (la liste d'attente de l'offre Analyse, avec son propre
 * consentement) tant que le paiement est fermé, « Voir l'offre Analyse » une fois ouvert. Ni compte à
 * rebours, ni remise, ni appel pressant à s'abonner.
 *
 * Mêmes listes que le bloc « fin de l'essai » de /compte (`launch-offer-end-lists.ts`) : le message ne
 * peut pas promettre autre chose que l'écran. Lien de désinscription signé (portée `launch-offer-end`,
 * liste d'exclusion `launch_offer_end_notice_optouts`), aussi en en-tête `List-Unsubscribe` avec la
 * désinscription en un clic (RFC 8058). Aucun prix, aucune donnée de vente.
 *
 * Texte à faire relire par `juridique-rgpd` avant d'ouvrir `TRIAL_END_EMAIL_MODE=on`.
 */

export const TRIAL_END_OPENING_LABEL = "Être prévenu de l’ouverture";

/**
 * Dernière phrase du message selon la garde d'ouverture du paiement (C12, 08/11 :
 * `analysisCheckoutReadiness`). Fermée : la liste d'attente. Ouverte : la page Offres, sans prix ni appel
 * pressant, puisque l'offre se souscrit déjà.
 */
export const TRIAL_END_OPENING_TEXT =
  "Si l’offre Analyse vous intéresse, vous pouvez demander à être prévenu de son ouverture :";
export const TRIAL_END_OFFER_TEXT =
  "Si l’offre Analyse vous intéresse, elle est ouverte à la souscription sur la page Offres :";
export const TRIAL_END_OFFER_LABEL = "Voir l’offre Analyse";

/** La phrase qui rassure, reprise des CGV et de la page Offres : rien ne se déclenche tout seul. */
export const TRIAL_END_NO_CHARGE_TEXT =
  "Rien ne devient payant automatiquement : aucune carte bancaire ne vous a été demandée et aucun prélèvement n’aura lieu.";

/** « 14 novembre 2026 » (« 1er novembre 2026 »), le jour de Paris. */
export function trialEndDayLabel(endsAt: string | Date): string {
  const date = endsAt instanceof Date ? endsAt : new Date(endsAt);
  if (Number.isNaN(date.getTime())) throw new Error("Trial end email: invalid end date.");
  return formatDate(date.toISOString());
}

export function trialEndSubject(endsAt: string | Date, internal: boolean): string {
  return `${internal ? "[Test interne] " : ""}Votre essai gratuit de l’offre Analyse se termine le ${trialEndDayLabel(endsAt)}`;
}

export async function buildTrialEndMessage({
  userId,
  endsAt,
  recipientEmail,
  from,
  appUrl,
  internal = false,
  now = new Date(),
  env,
  checkoutOpen,
}: {
  userId: string;
  /** Fin de l'essai du compte (ISO), déjà lue en base (`app_private.signup_trial_ends_at`). */
  endsAt: string | Date;
  recipientEmail: string;
  from: string;
  appUrl: string;
  /** Mode d'essai (`TRIAL_END_EMAIL_MODE=internal`) : l'objet et l'en-tête le disent. */
  internal?: boolean;
  now?: Date;
  env?: Pick<NodeJS.ProcessEnv, string>;
  /** Garde d'ouverture du paiement ; par défaut, `analysisCheckoutReadiness` lue sur `env`. */
  checkoutOpen?: boolean;
}): Promise<ResendEmailMessage & { unsubscribeUrl: string }> {
  const open = checkoutOpen ?? analysisCheckoutReadiness(env ?? process.env).open;
  const openingText = open ? TRIAL_END_OFFER_TEXT : TRIAL_END_OPENING_TEXT;
  const openingLabel = open ? TRIAL_END_OFFER_LABEL : TRIAL_END_OPENING_LABEL;
  const endsOnLabel = trialEndDayLabel(endsAt);
  const unsubscribeUrl = `${appUrl}/api/notification-preferences/unsubscribe?token=${encodeURIComponent(
    createUnsubscribeToken({ userId, scope: { kind: "launch-offer-end" }, now, env }),
  )}`;
  const settingsUrl = `${appUrl}/compte`;
  const openingUrl = `${appUrl}/offres`;

  const html = await renderTrialEndEmail({
    endsOnLabel,
    stays: LAUNCH_OFFER_END_STAYS,
    needsAnalysis: LAUNCH_OFFER_END_NEEDS_ANALYSIS,
    dataText: LAUNCH_OFFER_DATA_TEXT,
    noChargeText: TRIAL_END_NO_CHARGE_TEXT,
    openingUrl,
    openingText,
    openingLabel,
    settingsUrl,
    unsubscribeUrl,
    internal,
    title: trialEndSubject(endsAt, internal),
  });

  const text = [
    ...(internal
      ? ["Test interne : ce message d’exemple n’est envoyé qu’aux administrateurs.", ""]
      : []),
    "Bonjour,",
    "",
    `Votre essai gratuit de l’offre Analyse se termine le ${endsOnLabel}. À cette date, votre compte revient à l’offre Découverte, gratuite et sans limite de durée. Ce message est le seul que nous vous envoyons à ce sujet.`,
    "",
    "Ce qui reste gratuit",
    ...LAUNCH_OFFER_END_STAYS.map((item) => `- ${item}`),
    "",
    "Ce qui se ferme",
    "Ces fonctions font partie de l’offre Analyse. Elles ne sont plus accessibles une fois l’essai terminé :",
    ...LAUNCH_OFFER_END_NEEDS_ANALYSIS.map((item) => `- ${item}`),
    "",
    TRIAL_END_NO_CHARGE_TEXT,
    LAUNCH_OFFER_DATA_TEXT,
    "",
    openingText,
    `${openingLabel} : ${openingUrl}`,
    "",
    "Vous recevez ce message parce que votre compte Immojudis est en essai gratuit. Une seule fois, pour cet essai.",
    `Mon compte : ${settingsUrl}`,
    `Ne plus recevoir ce message : ${unsubscribeUrl}`,
    "",
    emailNoReplyText(),
  ].join("\n");

  return {
    from,
    to: recipientEmail,
    // Message automatique : aucune adresse de réponse.
    replyTo: null,
    subject: trialEndSubject(endsAt, internal),
    html,
    text,
    unsubscribeUrl,
    oneClickUnsubscribe: true,
  };
}
