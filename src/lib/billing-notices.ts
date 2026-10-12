import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  resolveEmailAlertDeliveryConfig,
  sendResendEmail,
  type ResendEmailMessage,
} from "@/lib/email-alerts";
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
}: {
  from: string;
  to: string;
  appUrl: string;
  /** Unix seconds of the next automatic retry announced by Stripe, if any. */
  nextAttemptAt?: number | null;
}): ResendEmailMessage {
  const accountUrl = `${appUrl}/compte`;
  const retry = nextAttemptAt
    ? `Stripe retentera automatiquement le prélèvement le ${dateFormat.format(new Date(nextAttemptAt * 1000))}.`
    : "Stripe retentera automatiquement le prélèvement dans les prochains jours.";
  const lines = [
    "Bonjour,",
    "",
    "Le dernier paiement de votre abonnement Immojudis Analyse n'a pas abouti.",
    `Votre accès reste ouvert pendant ${PAST_DUE_GRACE_DAYS} jours après la fin de la période payée.`,
    retry,
    "",
    "Pour éviter toute interruption, mettez à jour votre moyen de paiement :",
    accountUrl,
    "",
    "Si vous ne souhaitez pas poursuivre, vous pouvez aussi résilier depuis la même page.",
  ];
  return {
    from,
    to,
    subject: "Votre paiement Immojudis n'a pas abouti",
    text: lines.join("\n"),
    html: `<p>Bonjour,</p><p>Le dernier paiement de votre abonnement Immojudis Analyse n'a pas abouti. Votre accès reste ouvert pendant ${PAST_DUE_GRACE_DAYS} jours après la fin de la période payée.</p><p>${escapeHtml(retry)}</p><p><a href="${escapeHtml(accountUrl)}">Mettre à jour mon moyen de paiement</a></p><p>Si vous ne souhaitez pas poursuivre, vous pouvez aussi résilier depuis la même page.</p>`,
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
  const config = resolveEmailAlertDeliveryConfig();
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
}: {
  from: string;
  to: string;
  appUrl: string;
  /** Unix seconds of the end of the free trial. */
  trialEnd: number;
}): ResendEmailMessage {
  const accountUrl = `${appUrl}/compte`;
  const endDate = dateFormat.format(new Date(trialEnd * 1000));
  const lines = [
    "Bonjour,",
    "",
    `Votre essai gratuit d'Immojudis Analyse se termine le ${endDate}.`,
    "Sans action de votre part, l'abonnement se poursuit et le premier paiement est prélevé ce jour-là.",
    "",
    "Pour résilier avant cette date ou consulter votre abonnement :",
    accountUrl,
  ];
  return {
    from,
    to,
    subject: "Votre essai Immojudis se termine dans 3 jours",
    text: lines.join("\n"),
    html: `<p>Bonjour,</p><p>Votre essai gratuit d'Immojudis Analyse se termine le ${escapeHtml(endDate)}. Sans action de votre part, l'abonnement se poursuit et le premier paiement est prélevé ce jour-là.</p><p><a href="${escapeHtml(accountUrl)}">Résilier ou consulter mon abonnement</a></p>`,
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
  const config = resolveEmailAlertDeliveryConfig();
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
    });
    return "sent";
  } catch (error) {
    console.error("[billing] trial ending notice failed", error);
    return "failed";
  }
}
