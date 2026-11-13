import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  resolveNoReplyEmailConfig,
  resolveTransactionalEmailConfig,
  type ResendEmailMessage,
} from "@/lib/email-alerts";
import { formatDate } from "@/lib/format/dates";
import { escapeHtml } from "@/lib/guards";
import { sendTrackedEmail } from "@/lib/send-tracked-email";
import { resolveAnalysisOfferLabel } from "@/lib/analysis-offer";
import {
  emailButton,
  emailLayout,
  emailLink,
  emailNoReplyText,
  emailParagraph,
} from "@/lib/email-layout";
import { PAST_DUE_GRACE_DAYS } from "@/lib/plans";

/** Jour de Paris d'un horodatage Stripe (secondes Unix). */
function stripeDay(seconds: number): string {
  return formatDate(new Date(seconds * 1000).toISOString());
}

/** Formule de politesse des trois messages (même texte qu'avant, seulement mise en forme). */
const SIGNATURE = emailParagraph("Cordialement,<br />L’équipe Immojudis", { marginBottom: 0 });

/**
 * Enveloppe commune des avis de facturation : le texte des messages ne change pas ; seul le cadre
 * (logo, carte, mode sombre) vient du modèle unique. Pas de pied : pas de désinscription pour un
 * message contractuel, seulement la ligne de marque hors carte.
 */
function billingEmail({
  title,
  preheader,
  content,
  noReply = false,
}: {
  title: string;
  preheader: string;
  content: string[];
  /** Message automatique : ajoute la mention « ne pas répondre » au pied. */
  noReply?: boolean;
}): string {
  return emailLayout({
    title,
    preheader,
    content: content.join(""),
    footer: noReply ? { noReply: true } : {},
  });
}

export function buildPaymentFailedMessage({
  from,
  to,
  appUrl,
  nextAttemptAt,
  priceLabel = resolveAnalysisOfferLabel(),
}: {
  from: string;
  to: string;
  appUrl: string;
  /** Unix seconds of the next automatic retry announced by Stripe, if any. */
  nextAttemptAt?: number | null;
  /** Public price of the subscription, e.g. « 59 € TTC / mois ». */
  priceLabel?: string;
}): ResendEmailMessage {
  const accountUrl = `${appUrl}/compte`;
  const retry = nextAttemptAt
    ? `Prochain prélèvement automatique : le ${stripeDay(nextAttemptAt)}.`
    : "Stripe retentera automatiquement le prélèvement dans les prochains jours.";
  const amount = `Montant de l’abonnement : ${priceLabel}.`;
  // Same wording as § 4 of the conditions générales (`PAST_DUE_GRACE_DAYS`).
  const grace = `Votre accès Analyse reste ouvert ${PAST_DUE_GRACE_DAYS} jours à compter de la fin de la période payée pour vous permettre de mettre à jour votre moyen de paiement ; la mensualité reste due. Passé ce délai sans paiement, l’accès est suspendu. Votre compte Découverte et vos données restent accessibles.`;
  const cancel =
    "Si vous ne souhaitez pas poursuivre, vous pouvez résilier à tout moment depuis la page « Mon compte », bouton « Résilier mon abonnement ».";
  const subject = "Votre paiement Immojudis n'a pas abouti";
  const lines = [
    "Bonjour,",
    "",
    "Le dernier paiement de votre abonnement Immojudis Analyse n'a pas abouti.",
    amount,
    retry,
    grace,
    "",
    "Pour éviter toute interruption, mettez à jour votre moyen de paiement :",
    accountUrl,
    "",
    cancel,
    "",
    "Cordialement,",
    "L’équipe Immojudis",
  ];
  return {
    from,
    to,
    subject,
    text: lines.join("\n"),
    html: billingEmail({
      title: subject,
      preheader: "Le dernier paiement de votre abonnement Immojudis Analyse n'a pas abouti.",
      content: [
        emailParagraph("Bonjour,"),
        emailParagraph(
          `Le dernier paiement de votre abonnement Immojudis Analyse n'a pas abouti. ${escapeHtml(amount)}`,
        ),
        emailParagraph(`${escapeHtml(retry)} ${escapeHtml(grace)}`),
        emailButton(accountUrl, "Mettre à jour mon moyen de paiement"),
        emailParagraph(escapeHtml(cancel)),
        SIGNATURE,
      ],
    }),
  };
}

/**
 * Tell a subscriber their renewal failed. The Resend idempotency key makes a
 * replayed Stripe event harmless; a delivery problem never fails the webhook.
 */
export async function sendPaymentFailedNotice({
  userId,
  invoiceId,
  nextAttemptAt,
}: {
  userId: string;
  invoiceId: string;
  nextAttemptAt?: number | null;
}): Promise<"sent" | "skipped" | "failed"> {
  const config = resolveTransactionalEmailConfig();
  if (!config.configured || !config.apiKey || !config.from || !config.appUrl) return "skipped";
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (error) throw error;
    const recipient = data.user?.email?.trim();
    if (!recipient) return "skipped";
    await sendTrackedEmail({
      apiKey: config.apiKey,
      idempotencyKey: `immojudis-payment-failed-${invoiceId}`,
      templateKey: "payment_failed",
      userId,
      fetchImpl: fetch,
      message: buildPaymentFailedMessage({
        from: config.from,
        to: recipient,
        appUrl: config.appUrl,
        nextAttemptAt,
      }),
      category: "billing",
    });
    return "sent";
  } catch (error) {
    console.error("[billing] payment failure notice failed", error);
    return "failed";
  }
}

/** Lien de paiement Stripe accepté dans l'email 3-D Secure ; tout autre lien renvoie vers « Mon compte ». */
function isStripeHostedInvoiceUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "invoice.stripe.com";
  } catch {
    return false;
  }
}

/**
 * 3-D Secure au renouvellement (bloquant C10 du 08/11) : la banque demande au client de confirmer le
 * prélèvement mensuel. Sans action de sa part, le paiement échoue et l'accès finit par être suspendu.
 * Le lien mène à la page de paiement hébergée par Stripe (`hosted_invoice_url`), qui ouvre la
 * confirmation de la banque ; à défaut, à « Mon compte ».
 */
export function buildPaymentActionRequiredMessage({
  from,
  to,
  appUrl,
  hostedInvoiceUrl,
  priceLabel = resolveAnalysisOfferLabel(),
}: {
  from: string;
  to: string;
  appUrl: string;
  /** Page de paiement Stripe de la facture en attente (`invoice.hosted_invoice_url`). */
  hostedInvoiceUrl?: string | null;
  /** Public price of the subscription, e.g. « 59 € TTC / mois ». */
  priceLabel?: string;
}): ResendEmailMessage {
  const accountUrl = `${appUrl}/compte`;
  const confirmUrl = isStripeHostedInvoiceUrl(hostedInvoiceUrl) ? hostedInvoiceUrl : accountUrl;
  const reason =
    "Votre banque demande une confirmation (3-D Secure) pour le renouvellement de votre abonnement Immojudis Analyse. Tant qu’elle n’est pas donnée, le paiement reste en attente.";
  const amount = `Montant de l’abonnement : ${priceLabel}.`;
  const how =
    "Le lien ci-dessous ouvre la page de paiement sécurisée de Stripe, notre prestataire de paiement ; votre banque vous y demande de confirmer, comme lors de votre souscription.";
  const grace = `Votre accès Analyse reste ouvert ${PAST_DUE_GRACE_DAYS} jours à compter de la fin de la période payée ; passé ce délai sans paiement, l’accès est suspendu. Votre compte Découverte et vos données restent accessibles.`;
  const cancel =
    "Si vous ne souhaitez pas poursuivre, vous pouvez résilier à tout moment depuis la page « Mon compte », bouton « Résilier mon abonnement ».";
  const subject = "Confirmez le paiement de votre abonnement Immojudis";
  const lines = [
    "Bonjour,",
    "",
    reason,
    amount,
    "",
    how,
    `Confirmer mon paiement : ${confirmUrl}`,
    "",
    grace,
    cancel,
    "",
    "Cordialement,",
    "L’équipe Immojudis",
  ];
  return {
    from,
    to,
    subject,
    text: lines.join("\n"),
    html: billingEmail({
      title: subject,
      preheader:
        "Votre banque demande une confirmation pour le renouvellement de votre abonnement.",
      content: [
        emailParagraph("Bonjour,"),
        emailParagraph(`${escapeHtml(reason)} ${escapeHtml(amount)}`),
        emailParagraph(escapeHtml(how)),
        emailButton(confirmUrl, "Confirmer mon paiement"),
        emailParagraph(`${escapeHtml(grace)} ${escapeHtml(cancel)}`),
        SIGNATURE,
      ],
    }),
  };
}

/**
 * Ask a subscriber to confirm a renewal their bank holds for 3-D Secure. One email per invoice (the
 * Resend idempotency key absorbs a replayed event); a delivery problem never fails the webhook.
 */
export async function sendPaymentActionRequiredNotice({
  userId,
  invoiceId,
  hostedInvoiceUrl,
}: {
  userId: string;
  invoiceId: string;
  hostedInvoiceUrl?: string | null;
}): Promise<"sent" | "skipped" | "failed"> {
  const config = resolveTransactionalEmailConfig();
  if (!config.configured || !config.apiKey || !config.from || !config.appUrl) return "skipped";
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (error) throw error;
    const recipient = data.user?.email?.trim();
    if (!recipient) return "skipped";
    await sendTrackedEmail({
      apiKey: config.apiKey,
      idempotencyKey: `immojudis-payment-action-required-${invoiceId}`,
      templateKey: "payment_action_required",
      userId,
      fetchImpl: fetch,
      message: buildPaymentActionRequiredMessage({
        from: config.from,
        to: recipient,
        appUrl: config.appUrl,
        hostedInvoiceUrl,
      }),
      category: "billing",
    });
    return "sent";
  } catch (error) {
    console.error("[billing] payment action required notice failed", error);
    return "failed";
  }
}

export function buildTrialEndingMessage({
  from,
  to,
  appUrl,
  trialEnd,
  priceLabel = resolveAnalysisOfferLabel(),
}: {
  from: string;
  to: string;
  appUrl: string;
  /** Unix seconds of the end of the free trial. */
  trialEnd: number;
  /** Public price of the subscription, e.g. « 59 € TTC / mois ». */
  priceLabel?: string;
}): ResendEmailMessage {
  const accountUrl = `${appUrl}/compte`;
  const endDate = stripeDay(trialEnd);
  const firstPayment = `Sans action de votre part, l’abonnement se poursuit et le premier paiement est prélevé le ${endDate} : ${priceLabel}. Il est ensuite renouvelé chaque mois à la même date.`;
  const cancel =
    "Pour résilier avant cette date, rendez-vous sur la page « Mon compte », bouton « Résilier mon abonnement » :";
  const rightsUrl = `${appUrl}/mes-droits`;
  const withdrawal =
    "Vous disposez en principe d’un droit de rétractation de 14 jours à compter de votre souscription (voir « Mes droits »).";
  const subject = `Votre essai Immojudis Analyse se termine le ${endDate}`;
  const lines = [
    "Bonjour,",
    "",
    `Votre essai gratuit d'Immojudis Analyse se termine le ${endDate}.`,
    firstPayment,
    "",
    cancel,
    accountUrl,
    "",
    `${withdrawal} ${rightsUrl}`,
    "",
    "Cordialement,",
    "L’équipe Immojudis",
    "",
    emailNoReplyText(),
  ];
  return {
    from,
    to,
    // Message automatique : aucune adresse de réponse.
    replyTo: null,
    // The date, not a fixed « dans 3 jours » : the event may arrive earlier or later.
    subject,
    text: lines.join("\n"),
    html: billingEmail({
      noReply: true,
      title: subject,
      preheader: `Votre essai gratuit d'Immojudis Analyse se termine le ${endDate}.`,
      content: [
        emailParagraph("Bonjour,"),
        emailParagraph(
          `Votre essai gratuit d'Immojudis Analyse se termine le ${escapeHtml(endDate)}. ${escapeHtml(firstPayment)}`,
        ),
        emailParagraph(`${escapeHtml(cancel)} ${emailLink(accountUrl, "Mon compte")}`),
        emailParagraph(`${escapeHtml(withdrawal)} ${emailLink(rightsUrl, "Mes droits")}`),
        SIGNATURE,
      ],
    }),
  };
}

/** Warn a subscriber that the trial is about to turn into a paid subscription. */
export async function sendTrialEndingNotice({
  userId,
  subscriptionId,
  trialEnd,
}: {
  userId: string;
  subscriptionId: string;
  trialEnd: number;
}): Promise<"sent" | "skipped" | "failed"> {
  // Message automatique « ne pas répondre » ; sans NOREPLY_EMAIL_FROM, l'expéditeur de la facturation, comme avant.
  const config = resolveNoReplyEmailConfig(process.env, resolveTransactionalEmailConfig());
  if (!config.configured || !config.apiKey || !config.from || !config.appUrl) return "skipped";
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (error) throw error;
    const recipient = data.user?.email?.trim();
    if (!recipient) return "skipped";
    await sendTrackedEmail({
      apiKey: config.apiKey,
      idempotencyKey: `immojudis-trial-ending-${subscriptionId}`,
      templateKey: "trial_ending",
      userId,
      fetchImpl: fetch,
      message: buildTrialEndingMessage({
        from: config.from,
        to: recipient,
        appUrl: config.appUrl,
        trialEnd,
      }),
      category: "billing",
    });
    return "sent";
  } catch (error) {
    console.error("[billing] trial ending notice failed", error);
    return "failed";
  }
}

export type CancellationNoticeKind = "scheduled" | "immediate";

export function buildCancellationConfirmationMessage({
  from,
  to,
  appUrl,
  kind,
  accessEndsAt,
  trialing = false,
}: {
  from: string;
  to: string;
  appUrl: string;
  /**
   * `scheduled`: the cancellation takes effect at the end of the current period (access stays
   * open until then). `immediate`: the subscription is already cancelled (access is over).
   */
  kind: CancellationNoticeKind;
  /** Unix seconds of the end of Analyse access. */
  accessEndsAt: number;
  /** True while the free trial is running: nothing will be charged. */
  trialing?: boolean;
}): ResendEmailMessage {
  const accountUrl = `${appUrl}/compte`;
  const endDate = stripeDay(accessEndsAt);
  const receipt =
    "Nous confirmons avoir bien reçu votre demande de résiliation de l’abonnement Immojudis Analyse.";
  const effect =
    kind === "scheduled"
      ? `Votre contrat prend fin le ${endDate}, à la fin de la période en cours : votre accès Analyse reste ouvert jusqu’à cette date, puis l’abonnement n’est pas renouvelé.${trialing ? " Votre essai gratuit n’étant pas terminé, aucun montant ne sera prélevé." : ""}`
      : `Votre contrat a pris fin le ${endDate} : votre accès Analyse est terminé et l’abonnement n’est pas renouvelé.`;
  const remains = "Votre compte Découverte et vos données restent accessibles.";
  const subject = "Confirmation de votre résiliation";
  const lines = [
    "Bonjour,",
    "",
    receipt,
    effect,
    remains,
    "",
    `Mon compte : ${accountUrl}`,
    "",
    "Cordialement,",
    "L’équipe Immojudis",
  ];
  return {
    from,
    to,
    subject,
    text: lines.join("\n"),
    html: billingEmail({
      title: subject,
      preheader: receipt,
      content: [
        emailParagraph("Bonjour,"),
        emailParagraph(escapeHtml(receipt)),
        emailParagraph(escapeHtml(effect)),
        emailParagraph(`${escapeHtml(remains)} ${emailLink(accountUrl, "Mon compte")}`),
        SIGNATURE,
      ],
    }),
  };
}

/**
 * Confirm a cancellation on a durable medium (code de la consommation, L. 215-1-1). The Resend
 * idempotency key (subscription + moment of the request) absorbs a retried webhook; the decision
 * to send only once per cancellation is taken by the caller from the Stripe event. A delivery
 * problem never fails the webhook.
 */
export async function sendCancellationConfirmationNotice({
  userId,
  subscriptionId,
  requestedAt,
  kind,
  accessEndsAt,
  trialing,
}: {
  userId: string;
  subscriptionId: string;
  /** Unix seconds of the cancellation request, part of the idempotency key. */
  requestedAt: number;
  kind: CancellationNoticeKind;
  accessEndsAt: number;
  trialing?: boolean;
}): Promise<"sent" | "skipped" | "failed"> {
  const config = resolveTransactionalEmailConfig();
  if (!config.configured || !config.apiKey || !config.from || !config.appUrl) return "skipped";
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (error) throw error;
    const recipient = data.user?.email?.trim();
    if (!recipient) return "skipped";
    await sendTrackedEmail({
      apiKey: config.apiKey,
      idempotencyKey: `immojudis-cancellation-confirmation-${subscriptionId}-${requestedAt}`,
      templateKey: "cancellation",
      userId,
      fetchImpl: fetch,
      message: buildCancellationConfirmationMessage({
        from: config.from,
        to: recipient,
        appUrl: config.appUrl,
        kind,
        accessEndsAt,
        trialing,
      }),
      category: "billing",
    });
    return "sent";
  } catch (error) {
    console.error("[billing] cancellation confirmation failed", error);
    return "failed";
  }
}
