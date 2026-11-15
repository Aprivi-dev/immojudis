import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { LEGAL_DOCUMENTS, publicLegalPublisher } from "@/lib/legal-documents";
import { withdrawalInformationLines } from "@/lib/withdrawal-form";
import { resolveTransactionalEmailConfig } from "@/lib/email-alerts";
import { sendTrackedEmail } from "@/lib/send-tracked-email";
import { ConfigurationError } from "@/lib/api-errors";
import { formatDateTime } from "@/lib/format/dates";
import {
  ANALYSIS_BILLING_MODEL,
  ANALYSIS_OFFER_CODE,
  ANALYSIS_RECURRING_CURRENCY,
  ANALYSIS_RECURRING_LABEL,
  ANALYSIS_SUBSCRIPTION_OFFER_CODE,
  ANALYSIS_SUBSCRIPTION_ONLY_LABEL,
  ANALYSIS_TRIAL_DAYS,
  ANALYSIS_TRIAL_LABEL,
  resolveAnalysisOfferLabel,
  SALE_UNLOCK_CURRENCY,
  SALE_UNLOCK_OFFER_CODE,
  VAT_EXEMPTION_INVOICE_MENTION,
} from "@/lib/analysis-offer";
import { escapeHtml, numberValue, stringValue } from "@/lib/guards";
import {
  emailBreakable,
  emailHeading,
  emailLayout,
  emailLink,
  emailParagraph,
} from "@/lib/email-layout";
import { asRecord as jsonRecord } from "@/lib/guards";
import { normalizeEmail } from "@/lib/account";

export const checkoutConsentSchema = z.object({
  termsAccepted: z.literal(true),
  termsVersion: z.literal(LEGAL_DOCUMENTS.terms.version),
  privacyVersion: z.literal(LEGAL_DOCUMENTS.privacy.version),
  paymentObligationAcknowledged: z.literal(true),
  immediatePerformanceRequested: z.literal(true),
  withdrawalInformationAcknowledged: z.literal(true),
});

export type CheckoutConsent = z.infer<typeof checkoutConsentSchema>;

/**
 * Consentement de l'achat d'une vente à l'unité : celui de l'abonnement, plus la renonciation
 * expresse au droit de rétractation pour un contenu numérique fourni immédiatement (l'analyse de la
 * vente s'ouvre dès le paiement). Un consentement sans elle est refusé.
 */
export const saleUnlockConsentSchema = checkoutConsentSchema.extend({
  withdrawalWaiverAcknowledged: z.literal(true),
});

export type SaleUnlockConsent = z.infer<typeof saleUnlockConsentSchema>;

/** Objet de l'acceptation de l'achat à l'unité (colonne `purpose`). */
export const SALE_UNLOCK_ACCEPTANCE_PURPOSE = "sale_unlock_purchase";

/** Ce que la confirmation dit de l'achat à l'unité : vente débloquée, ou crédit. */
export type SaleUnlockConfirmationOutcome = "unlocked" | "credit";

export type CommercialConfirmationRetrySummary = {
  configured: boolean;
  candidateCount: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
};

export type CommercialAcceptanceOffer = {
  priceId: string;
  offerCode?: string;
  billingModel?: string;
  trialDays?: number;
  amountCents?: number | null;
  currency?: string;
  recurringInterval?: string | null;
  recurringIntervalCount?: number | null;
};

export function assertCommercialConfirmationReadiness(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): void {
  const config = resolveTransactionalEmailConfig(env);
  if (!config.configured) {
    throw new ConfigurationError(
      `Confirmation contractuelle indisponible: ${config.missing.join(", ")}. Le checkout est suspendu.`,
    );
  }
}

export async function recordCommercialAcceptance({
  acceptanceId,
  auth,
  consent,
  checkoutSessionId,
  checkoutCreatedAt,
  requestId,
  userAgent,
  offer,
}: {
  acceptanceId: string;
  auth: SupabaseAuthContext;
  consent: CheckoutConsent;
  checkoutSessionId: string;
  checkoutCreatedAt: string;
  requestId: string | null;
  userAgent: string | null;
  offer: CommercialAcceptanceOffer;
}): Promise<void> {
  const email =
    normalizeEmail(typeof auth.claims.email === "string" ? auth.claims.email : null) || null;
  const currency = offer.currency ?? ANALYSIS_RECURRING_CURRENCY;
  const offerCode = offer.offerCode ?? ANALYSIS_OFFER_CODE;
  const billingModel = offer.billingModel ?? ANALYSIS_BILLING_MODEL;
  const trialDays = offer.trialDays ?? ANALYSIS_TRIAL_DAYS;
  const offerLabel = resolveAnalysisOfferLabel();
  const { error } = await supabaseAdmin.from("commercial_acceptances").insert({
    id: acceptanceId,
    user_id: auth.userId,
    purpose: "analyse_checkout",
    terms_version: consent.termsVersion,
    terms_sha256: LEGAL_DOCUMENTS.terms.sha256,
    privacy_version: consent.privacyVersion,
    privacy_sha256: LEGAL_DOCUMENTS.privacy.sha256,
    offer_code: offerCode,
    amount_cents: offer.amountCents ?? null,
    currency,
    terms_accepted: consent.termsAccepted,
    payment_obligation_acknowledged: consent.paymentObligationAcknowledged,
    immediate_performance_requested: consent.immediatePerformanceRequested,
    withdrawal_information_acknowledged: consent.withdrawalInformationAcknowledged,
    requester_email_hash: digest(email),
    request_id: requestId,
    user_agent_hash: digest(userAgent),
    checkout_session_id: checkoutSessionId,
    checkout_created_at: checkoutCreatedAt,
    evidence: {
      source: "checkout_confirmation_dialog",
      offer_label: offerLabel,
      amount_cents: offer.amountCents ?? null,
      currency,
      price_id: offer.priceId,
      billing_model: billingModel,
      trial_days: trialDays,
      trial_label: trialDays > 0 ? ANALYSIS_TRIAL_LABEL : null,
      recurring_label: trialDays > 0 ? ANALYSIS_RECURRING_LABEL : ANALYSIS_SUBSCRIPTION_ONLY_LABEL,
      payment_method_required: true,
      recurring_interval: offer.recurringInterval ?? null,
      recurring_interval_count: offer.recurringIntervalCount ?? null,
    },
  });
  if (error) throw error;
}

/**
 * Preuve de l'acceptation avant la session d'achat d'une vente à l'unité. Même table que
 * l'abonnement ; l'objet (`sale_unlock_purchase`), le code d'offre et la renonciation au droit de
 * rétractation la distinguent. La renonciation est portée par `evidence` tant que la table n'a pas de
 * colonne dédiée.
 */
export async function recordSaleUnlockAcceptance({
  acceptanceId,
  auth,
  consent,
  checkoutSessionId,
  checkoutCreatedAt,
  requestId,
  userAgent,
  priceId,
  amountCents,
  saleId,
  purchaseId,
}: {
  acceptanceId: string;
  auth: SupabaseAuthContext;
  consent: SaleUnlockConsent;
  checkoutSessionId: string;
  checkoutCreatedAt: string;
  requestId: string | null;
  userAgent: string | null;
  priceId: string;
  amountCents: number;
  saleId: string;
  purchaseId: string;
}): Promise<void> {
  const email =
    normalizeEmail(typeof auth.claims.email === "string" ? auth.claims.email : null) || null;
  const { error } = await supabaseAdmin.from("commercial_acceptances").insert({
    id: acceptanceId,
    user_id: auth.userId,
    purpose: SALE_UNLOCK_ACCEPTANCE_PURPOSE,
    terms_version: consent.termsVersion,
    terms_sha256: LEGAL_DOCUMENTS.terms.sha256,
    privacy_version: consent.privacyVersion,
    privacy_sha256: LEGAL_DOCUMENTS.privacy.sha256,
    offer_code: SALE_UNLOCK_OFFER_CODE,
    amount_cents: amountCents,
    currency: SALE_UNLOCK_CURRENCY,
    terms_accepted: consent.termsAccepted,
    payment_obligation_acknowledged: consent.paymentObligationAcknowledged,
    immediate_performance_requested: consent.immediatePerformanceRequested,
    withdrawal_information_acknowledged: consent.withdrawalInformationAcknowledged,
    requester_email_hash: digest(email),
    request_id: requestId,
    user_agent_hash: digest(userAgent),
    checkout_session_id: checkoutSessionId,
    checkout_created_at: checkoutCreatedAt,
    evidence: {
      source: "sale_unlock_checkout_dialog",
      offer_label: SALE_UNLOCK_OFFER_LABEL,
      amount_cents: amountCents,
      currency: SALE_UNLOCK_CURRENCY,
      price_id: priceId,
      billing_model: "one_time_payment",
      sale_id: saleId,
      purchase_id: purchaseId,
      payment_method_required: true,
      withdrawal_waiver_acknowledged: consent.withdrawalWaiverAcknowledged,
    },
  });
  if (error) throw error;
}

const SALE_UNLOCK_OFFER_LABEL = "Déblocage d’une vente à l’unité";

export async function sendCommercialConfirmation({
  acceptanceId,
  checkoutSessionId,
  userId,
  paidAt,
  saleUnlockOutcome,
}: {
  acceptanceId: string;
  checkoutSessionId: string;
  userId: string;
  paidAt: string;
  /**
   * Achat à l'unité : ce que le paiement a donné. Absent (relance d'un envoi échoué) : la
   * confirmation explique les deux issues possibles.
   */
  saleUnlockOutcome?: SaleUnlockConfirmationOutcome;
}): Promise<"sent" | "failed"> {
  const config = resolveTransactionalEmailConfig();
  const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (authError) throw authError;
  const recipient = authUser.user?.email?.trim() || null;
  const { data: previous } = await supabaseAdmin
    .from("commercial_confirmation_deliveries")
    .select("attempt_count,status")
    .eq("acceptance_id", acceptanceId)
    .maybeSingle();
  if (previous?.status === "sent") return "sent";
  const attemptCount = (previous?.attempt_count ?? 0) + 1;

  const { data: acceptance, error: acceptanceError } = await supabaseAdmin
    .from("commercial_acceptances")
    .select(
      "offer_code,amount_cents,currency,evidence,terms_version,terms_sha256,privacy_version,privacy_sha256",
    )
    .eq("id", acceptanceId)
    .maybeSingle();
  if (acceptanceError) throw acceptanceError;
  if (acceptance?.offer_code === SALE_UNLOCK_OFFER_CODE) {
    const accepted = {
      termsVersion: acceptance.terms_version,
      termsSha256: acceptance.terms_sha256,
      privacyVersion: acceptance.privacy_version,
    };
    return deliverConfirmation({
      config,
      recipient,
      acceptanceId,
      checkoutSessionId,
      attemptCount,
      paidAt,
      userId,
      build: (appUrl) =>
        saleUnlockConfirmationContent({
          appUrl,
          evidence: jsonRecord(acceptance.evidence),
          amountCents: acceptance.amount_cents,
          currency: acceptance.currency,
          accepted,
          paidAt,
          checkoutSessionId,
          outcome: saleUnlockOutcome,
        }),
    });
  }
  const { data: subscription, error: subscriptionError } = await supabaseAdmin
    .from("user_subscriptions")
    .select("metadata")
    .eq("user_id", userId)
    .maybeSingle();
  if (subscriptionError) throw subscriptionError;

  // L'ancien accès de 30 jours sans renouvellement n'est décrit que pour une acceptation qui le porte
  // explicitement (ancien code d'offre). Une acceptation illisible ou absente est décrite comme
  // l'offre actuelle, l'abonnement mensuel : jamais comme un « accès 30 jours ».
  const isRecurringOffer =
    !acceptance?.offer_code ||
    acceptance.offer_code === ANALYSIS_OFFER_CODE ||
    acceptance.offer_code === ANALYSIS_SUBSCRIPTION_OFFER_CODE;
  const evidence = jsonRecord(acceptance?.evidence);
  const trialDays = numberValue(evidence.trial_days) ?? 0;
  const offerLabel =
    typeof evidence.offer_label === "string"
      ? evidence.offer_label
      : isRecurringOffer
        ? resolveAnalysisOfferLabel()
        : "Immojudis Analyse — 30 jours";
  const subscriptionEvidence = jsonRecord(subscription?.metadata);
  const amountCents =
    acceptance?.amount_cents ?? numberValue(subscriptionEvidence.stripe_price_amount_cents);
  const currency =
    acceptance?.currency ??
    stringValue(subscriptionEvidence.stripe_price_currency) ??
    ANALYSIS_RECURRING_CURRENCY;
  // Périodicité : celle enregistrée avec l'acceptation (le Price relu au paiement), à défaut celle
  // de l'abonnement synchronisé.
  const interval =
    stringValue(evidence.recurring_interval) ??
    stringValue(subscriptionEvidence.stripe_price_interval);
  const intervalCount =
    numberValue(evidence.recurring_interval_count) ??
    numberValue(subscriptionEvidence.stripe_price_interval_count);
  const recurringPrice =
    amountCents != null
      ? `Tarif : ${formatMoney(amountCents, currency)}${formatInterval(interval, intervalCount)}`
      : "Tarif : montant affiché dans Stripe Checkout";
  const trialEnd = stringValue(subscriptionEvidence.stripe_trial_end);
  const firstInvoiceAt = stringValue(subscriptionEvidence.stripe_first_invoice_at);
  const offerDescription = isRecurringOffer
    ? [
        trialDays > 0
          ? `${ANALYSIS_TRIAL_LABEL}, puis ${ANALYSIS_RECURRING_LABEL.toLocaleLowerCase("fr-FR")}.`
          : `${ANALYSIS_SUBSCRIPTION_ONLY_LABEL}.`,
        recurringPrice,
        "L’abonnement est conclu sans durée limitée et prélevé automatiquement chaque mois, à la même date, jusqu’à sa résiliation. Vous pouvez le résilier à tout moment depuis la page « Mon compte » : la résiliation prend effet à la fin de la période payée.",
        trialEnd ? `Fin de l’essai prévue le : ${formatDateTime(trialEnd, trialEnd)}` : null,
        firstInvoiceAt
          ? `Premier prélèvement prévu le : ${formatDateTime(firstInvoiceAt, firstInvoiceAt)}`
          : null,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n")
    : acceptance?.amount_cents != null
      ? `${formatMoney(acceptance.amount_cents, acceptance.currency)}, paiement unique sans renouvellement automatique.`
      : "Accès Analyse selon les conditions indiquées au paiement.";

  // Le courriel cite ce que le client a accepté (version et empreinte enregistrées avec
  // l'acceptation), pas la version en vigueur le jour de l'envoi ou de la relance.
  const accepted = {
    termsVersion: acceptance?.terms_version ?? LEGAL_DOCUMENTS.terms.version,
    termsSha256: acceptance?.terms_sha256 ?? LEGAL_DOCUMENTS.terms.sha256,
    privacyVersion: acceptance?.privacy_version ?? LEGAL_DOCUMENTS.privacy.version,
  };
  return deliverConfirmation({
    config,
    recipient,
    acceptanceId,
    checkoutSessionId,
    attemptCount,
    paidAt,
    userId,
    build: (appUrl) => {
      const termsUrl = `${appUrl}${LEGAL_DOCUMENTS.terms.path}`;
      const privacyUrl = `${appUrl}${LEGAL_DOCUMENTS.privacy.path}`;
      const rightsUrl = `${appUrl}/mes-droits`;
      const withdrawalLines = withdrawalInformationLines({
        publisher: publicLegalPublisher(),
        rightsUrl,
        orderedOn: paidAt,
      });
      const subject = isRecurringOffer
        ? "Confirmation de votre abonnement Immojudis Analyse"
        : "Confirmation de votre commande Immojudis Analyse";
      const text = [
        subject,
        "",
        `Offre : ${offerLabel}`,
        offerDescription,
        `Commande confirmée le : ${paidAt}`,
        `Référence : ${checkoutSessionId}`,
        `Conditions acceptées : version ${accepted.termsVersion}`,
        `Politique de confidentialité : version ${accepted.privacyVersion}`,
        "Exécution : accès immédiat demandé avant la fin du délai de rétractation.",
        "",
        `Conditions générales : ${termsUrl}`,
        `Confidentialité : ${privacyUrl}`,
        `Exercer un droit ou notifier une rétractation : ${rightsUrl}`,
        "",
        ...withdrawalLines,
        "",
        `Empreinte SHA-256 des conditions acceptées : ${accepted.termsSha256}`,
      ].join("\n");
      const html = emailLayout({
        title: subject,
        preheader: `Offre : ${offerLabel}`,
        // Même contenu qu'avant, seulement mis en forme : aucun texte ni aucune date ne change.
        content: [
          emailHeading(
            `${isRecurringOffer ? "Abonnement" : "Commande"} Immojudis Analyse confirmé${isRecurringOffer ? "" : "e"}`,
          ),
          emailParagraph(
            `<strong>${escapeHtml(offerLabel)}</strong><br>${escapeHtml(offerDescription).replace(/\n/g, "<br>")}`,
          ),
          emailParagraph(
            `Confirmation : ${escapeHtml(paidAt)}<br>Référence : ${emailBreakable(checkoutSessionId)}`,
          ),
          emailParagraph(
            `Conditions version ${escapeHtml(accepted.termsVersion)} · Confidentialité version ${escapeHtml(accepted.privacyVersion)}`,
          ),
          emailParagraph(
            `${emailLink(termsUrl, "Conditions générales")} · ${emailLink(privacyUrl, "Confidentialité")} · ${emailLink(rightsUrl, "Mes droits et rétractation")}`,
          ),
          emailParagraph(escapeHtml(withdrawalLines.join("\n")).replace(/\n/g, "<br>")),
          emailParagraph(
            `Empreinte SHA-256 des conditions acceptées : ${emailBreakable(accepted.termsSha256)}`,
            { marginBottom: 0 },
          ),
        ].join(""),
        footer: {},
      });
      return { subject, text, html };
    },
  });
}

type ConfirmationContent = { subject: string; text: string; html: string };

/**
 * Envoi suivi d'une confirmation contractuelle et trace de la tentative (relancée par
 * `retryFailedCommercialConfirmations` en cas d'échec). Sans destinataire ni configuration, la
 * tentative est enregistrée en échec.
 */
async function deliverConfirmation({
  config,
  recipient,
  acceptanceId,
  checkoutSessionId,
  attemptCount,
  paidAt,
  userId,
  build,
}: {
  config: ReturnType<typeof resolveTransactionalEmailConfig>;
  recipient: string | null;
  acceptanceId: string;
  checkoutSessionId: string;
  attemptCount: number;
  paidAt: string;
  userId: string;
  build: (appUrl: string) => ConfirmationContent;
}): Promise<"sent" | "failed"> {
  if (!recipient || !config.configured || !config.apiKey || !config.from || !config.appUrl) {
    await recordConfirmationDelivery({
      acceptanceId,
      checkoutSessionId,
      attemptCount,
      paidAt,
      recipient,
      status: "failed",
      errorMessage: recipient
        ? `Configuration email incomplète: ${config.missing.join(", ")}`
        : "Adresse email du compte indisponible.",
    });
    return "failed";
  }
  const { subject, text, html } = build(config.appUrl);

  try {
    const result = await sendTrackedEmail({
      apiKey: config.apiKey,
      idempotencyKey: `immojudis-contract-${acceptanceId}`,
      templateKey: "commercial_confirmation",
      userId,
      fetchImpl: fetch,
      message: { from: config.from, to: recipient, subject, text, html },
      category: "acceptance",
    });
    await recordConfirmationDelivery({
      acceptanceId,
      checkoutSessionId,
      attemptCount,
      paidAt,
      recipient,
      status: "sent",
      providerMessageId: result.id,
      sentAt: new Date().toISOString(),
    });
    return "sent";
  } catch (error) {
    await recordConfirmationDelivery({
      acceptanceId,
      checkoutSessionId,
      attemptCount,
      paidAt,
      recipient,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "Envoi impossible.",
    });
    return "failed";
  }
}

/**
 * Confirmation de l'achat d'une vente à l'unité (support durable) : objet, vente, montant, mention
 * de TVA, rappel de la renonciation au droit de rétractation et, pour un crédit, son explication.
 */
function saleUnlockConfirmationContent({
  appUrl,
  evidence,
  amountCents,
  currency,
  accepted,
  paidAt,
  checkoutSessionId,
  outcome,
}: {
  appUrl: string;
  evidence: Record<string, unknown>;
  amountCents: number | null;
  currency: string;
  accepted: { termsVersion: string; termsSha256: string; privacyVersion: string };
  paidAt: string;
  checkoutSessionId: string;
  outcome: SaleUnlockConfirmationOutcome | undefined;
}): ConfirmationContent {
  const saleId = stringValue(evidence.sale_id);
  const saleUrl = saleId ? `${appUrl}/sales/${encodeURIComponent(saleId)}` : null;
  const termsUrl = `${appUrl}${LEGAL_DOCUMENTS.terms.path}`;
  const privacyUrl = `${appUrl}${LEGAL_DOCUMENTS.privacy.path}`;
  const rightsUrl = `${appUrl}/mes-droits`;
  const subject = "Confirmation de votre achat Immojudis : déblocage d’une vente";
  const amount =
    amountCents != null
      ? `Montant payé : ${formatMoney(amountCents, currency)}, paiement unique sans renouvellement.`
      : "Montant payé : celui affiché dans Stripe Checkout, paiement unique sans renouvellement.";
  const waiver =
    "Exécution immédiate et renonciation : avant le paiement, vous avez demandé l’accès immédiat à l’analyse de la vente et renoncé expressément à votre droit de rétractation, qui ne s’applique plus une fois cet accès fourni (article L. 221-28, 13°, du code de la consommation).";
  const result =
    outcome === "unlocked"
      ? "Résultat : la vente est débloquée sur votre compte."
      : outcome === "credit"
        ? "Résultat : cette vente n’était plus débloquable au moment du paiement (retirée de la publication, ou déjà débloquée sur votre compte). Votre paiement n’est pas perdu : un crédit a été ajouté à votre compte. Il permet de débloquer une autre vente de votre choix, depuis sa fiche, sans nouveau paiement."
        : "Résultat : la vente est débloquée sur votre compte. Si elle n’était plus débloquable au moment du paiement, un crédit a été ajouté à votre compte à la place : il permet de débloquer une autre vente de votre choix, sans nouveau paiement.";
  const lines = [
    subject,
    "",
    `Offre : ${SALE_UNLOCK_OFFER_LABEL}`,
    saleUrl ? `Vente : ${saleUrl}` : null,
    amount,
    VAT_EXEMPTION_INVOICE_MENTION,
    result,
    `Commande confirmée le : ${paidAt}`,
    `Référence : ${checkoutSessionId}`,
    `Conditions acceptées : version ${accepted.termsVersion}`,
    `Politique de confidentialité : version ${accepted.privacyVersion}`,
    waiver,
    "",
    `Conditions générales : ${termsUrl}`,
    `Confidentialité : ${privacyUrl}`,
    `Exercer un droit : ${rightsUrl}`,
    "",
    `Empreinte SHA-256 des conditions acceptées : ${accepted.termsSha256}`,
  ].filter((line): line is string => line !== null);
  const html = emailLayout({
    title: subject,
    preheader: `Offre : ${SALE_UNLOCK_OFFER_LABEL}`,
    content: [
      emailHeading("Achat Immojudis confirmé"),
      emailParagraph(
        [
          `<strong>${escapeHtml(SALE_UNLOCK_OFFER_LABEL)}</strong>`,
          saleUrl ? `Vente : ${emailLink(saleUrl, "voir la fiche de la vente")}` : null,
          escapeHtml(amount),
          escapeHtml(VAT_EXEMPTION_INVOICE_MENTION),
        ]
          .filter(Boolean)
          .join("<br>"),
      ),
      emailParagraph(escapeHtml(result)),
      emailParagraph(
        `Confirmation : ${escapeHtml(paidAt)}<br>Référence : ${emailBreakable(checkoutSessionId)}`,
      ),
      emailParagraph(
        `Conditions version ${escapeHtml(accepted.termsVersion)} · Confidentialité version ${escapeHtml(accepted.privacyVersion)}`,
      ),
      emailParagraph(escapeHtml(waiver)),
      emailParagraph(
        `${emailLink(termsUrl, "Conditions générales")} · ${emailLink(privacyUrl, "Confidentialité")} · ${emailLink(rightsUrl, "Mes droits")}`,
      ),
      emailParagraph(
        `Empreinte SHA-256 des conditions acceptées : ${emailBreakable(accepted.termsSha256)}`,
        { marginBottom: 0 },
      ),
    ].join(""),
    footer: {},
  });
  return { subject, text: lines.join("\n"), html };
}

export async function retryFailedCommercialConfirmations({
  limit = 25,
  now = new Date(),
}: {
  limit?: number;
  now?: Date;
} = {}): Promise<CommercialConfirmationRetrySummary> {
  const config = resolveTransactionalEmailConfig();
  if (!config.configured) {
    return {
      configured: false,
      candidateCount: 0,
      sentCount: 0,
      failedCount: 0,
      skippedCount: 0,
    };
  }

  const retryBefore = new Date(now.getTime() - 15 * 60_000).toISOString();
  const { data: candidates, error } = await supabaseAdmin
    .from("commercial_confirmation_deliveries")
    .select("acceptance_id,attempt_count,checkout_session_id,paid_at")
    .eq("status", "failed")
    .lt("attempt_count", 8)
    .lte("updated_at", retryBefore)
    .order("updated_at", { ascending: true })
    .limit(Math.min(Math.max(Math.trunc(limit), 1), 100));
  if (error) throw error;

  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  for (const candidate of candidates ?? []) {
    const { data: acceptance, error: acceptanceError } = await supabaseAdmin
      .from("commercial_acceptances")
      .select("user_id")
      .eq("id", candidate.acceptance_id)
      .maybeSingle();
    if (acceptanceError) throw acceptanceError;
    if (!acceptance?.user_id) {
      skippedCount += 1;
      continue;
    }

    const outcome = await sendCommercialConfirmation({
      acceptanceId: candidate.acceptance_id,
      checkoutSessionId: candidate.checkout_session_id,
      userId: acceptance.user_id,
      paidAt: candidate.paid_at,
    });
    if (outcome === "sent") sentCount += 1;
    else failedCount += 1;
  }

  return {
    configured: true,
    candidateCount: candidates?.length ?? 0,
    sentCount,
    failedCount,
    skippedCount,
  };
}

async function recordConfirmationDelivery({
  acceptanceId,
  checkoutSessionId,
  attemptCount,
  paidAt,
  recipient,
  status,
  providerMessageId = null,
  errorMessage = null,
  sentAt = null,
}: {
  acceptanceId: string;
  checkoutSessionId: string;
  attemptCount: number;
  paidAt: string;
  recipient: string | null;
  status: "sent" | "failed";
  providerMessageId?: string | null;
  errorMessage?: string | null;
  sentAt?: string | null;
}) {
  const { error } = await supabaseAdmin.from("commercial_confirmation_deliveries").upsert(
    {
      acceptance_id: acceptanceId,
      checkout_session_id: checkoutSessionId,
      status,
      attempt_count: attemptCount,
      paid_at: paidAt,
      recipient_hash: digest(recipient?.toLowerCase() ?? null),
      provider_message_id: providerMessageId,
      error_message: errorMessage?.slice(0, 2000) ?? null,
      sent_at: sentAt,
    },
    { onConflict: "acceptance_id" },
  );
  if (error) throw error;
}

function digest(value: string | null): string | null {
  return value ? createHash("sha256").update(value).digest("hex") : null;
}

function formatMoney(amountCents: number, currency: string): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amountCents / 100);
}

function formatInterval(interval: string | null, count: number | null): string {
  if (!interval) return "";
  const normalizedCount = count && count > 1 ? ` tous les ${count}` : " chaque";
  const label = interval === "month" ? "mois" : interval === "year" ? "an" : interval;
  return `${normalizedCount} ${label}`;
}
