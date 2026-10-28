import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  resolveTransactionalEmailConfig,
  sendResendEmail,
  type ResendEmailMessage,
} from "@/lib/email-alerts";
import { resolveAnalysisOfferLabel } from "@/lib/analysis-offer";
import { PAST_DUE_GRACE_DAYS } from "@/lib/plans";

const dateFormat = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Europe/Paris",
});

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
    ? `Prochain prélèvement automatique : le ${dateFormat.format(new Date(nextAttemptAt * 1000))}.`
    : "Stripe retentera automatiquement le prélèvement dans les prochains jours.";
  const amount = `Montant de l’abonnement : ${priceLabel}.`;
  // Same wording as § 4 of the conditions générales (`PAST_DUE_GRACE_DAYS`).
  const grace = `Votre accès Analyse reste ouvert ${PAST_DUE_GRACE_DAYS} jours à compter de la fin de la période payée pour vous permettre de mettre à jour votre moyen de paiement ; la mensualité reste due. Passé ce délai sans paiement, l’accès est suspendu. Votre compte Découverte et vos données restent accessibles.`;
  const cancel =
    "Si vous ne souhaitez pas poursuivre, vous pouvez résilier à tout moment depuis la page « Mon compte », bouton « Résilier mon abonnement ».";
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
    subject: "Votre paiement Immojudis n'a pas abouti",
    text: lines.join("\n"),
    html: `<p>Bonjour,</p><p>Le dernier paiement de votre abonnement Immojudis Analyse n'a pas abouti. ${escapeHtml(amount)}</p><p>${escapeHtml(retry)} ${escapeHtml(grace)}</p><p><a href="${escapeHtml(accountUrl)}">Mettre à jour mon moyen de paiement</a></p><p>${escapeHtml(cancel)}</p><p>Cordialement,<br />L’équipe Immojudis</p>`,
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
    await sendResendEmail({
      apiKey: config.apiKey,
      idempotencyKey: `immojudis-payment-failed-${invoiceId}`,
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
  const endDate = dateFormat.format(new Date(trialEnd * 1000));
  const firstPayment = `Sans action de votre part, l’abonnement se poursuit et le premier paiement est prélevé le ${endDate} : ${priceLabel}. Il est ensuite renouvelé chaque mois à la même date.`;
  const cancel =
    "Pour résilier avant cette date, rendez-vous sur la page « Mon compte », bouton « Résilier mon abonnement » :";
  const rightsUrl = `${appUrl}/mes-droits`;
  const withdrawal =
    "Vous disposez en principe d’un droit de rétractation de 14 jours à compter de votre souscription (voir « Mes droits »).";
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
  ];
  return {
    from,
    to,
    // The date, not a fixed « dans 3 jours » : the event may arrive earlier or later.
    subject: `Votre essai Immojudis Analyse se termine le ${endDate}`,
    text: lines.join("\n"),
    html: `<p>Bonjour,</p><p>Votre essai gratuit d'Immojudis Analyse se termine le ${escapeHtml(endDate)}. ${escapeHtml(firstPayment)}</p><p>${escapeHtml(cancel)} <a href="${escapeHtml(accountUrl)}">Mon compte</a></p><p>${escapeHtml(withdrawal)} <a href="${escapeHtml(rightsUrl)}">Mes droits</a></p><p>Cordialement,<br />L’équipe Immojudis</p>`,
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
  const config = resolveTransactionalEmailConfig();
  if (!config.configured || !config.apiKey || !config.from || !config.appUrl) return "skipped";
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (error) throw error;
    const recipient = data.user?.email?.trim();
    if (!recipient) return "skipped";
    await sendResendEmail({
      apiKey: config.apiKey,
      idempotencyKey: `immojudis-trial-ending-${subscriptionId}`,
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
  const endDate = dateFormat.format(new Date(accessEndsAt * 1000));
  const receipt =
    "Nous confirmons avoir bien reçu votre demande de résiliation de l’abonnement Immojudis Analyse.";
  const effect =
    kind === "scheduled"
      ? `Votre contrat prend fin le ${endDate}, à la fin de la période en cours : votre accès Analyse reste ouvert jusqu’à cette date, puis l’abonnement n’est pas renouvelé.${trialing ? " Votre essai gratuit n’étant pas terminé, aucun montant ne sera prélevé." : ""}`
      : `Votre contrat a pris fin le ${endDate} : votre accès Analyse est terminé et l’abonnement n’est pas renouvelé.`;
  const remains = "Votre compte Découverte et vos données restent accessibles.";
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
    subject: "Confirmation de votre résiliation",
    text: lines.join("\n"),
    html: `<p>Bonjour,</p><p>${escapeHtml(receipt)}</p><p>${escapeHtml(effect)}</p><p>${escapeHtml(remains)} <a href="${escapeHtml(accountUrl)}">Mon compte</a></p><p>Cordialement,<br />L’équipe Immojudis</p>`,
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
    await sendResendEmail({
      apiKey: config.apiKey,
      idempotencyKey: `immojudis-cancellation-confirmation-${subscriptionId}-${requestedAt}`,
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
