import { createHash } from "node:crypto";
import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { LEGAL_DOCUMENTS } from "@/lib/legal-documents";
import { resolveEmailAlertDeliveryConfig, sendResendEmail } from "@/lib/email-alerts";

export const checkoutConsentSchema = z.object({
  termsAccepted: z.literal(true),
  termsVersion: z.literal(LEGAL_DOCUMENTS.terms.version),
  privacyVersion: z.literal(LEGAL_DOCUMENTS.privacy.version),
  paymentObligationAcknowledged: z.literal(true),
  immediatePerformanceRequested: z.literal(true),
  withdrawalInformationAcknowledged: z.literal(true),
});

export type CheckoutConsent = z.infer<typeof checkoutConsentSchema>;

export type CommercialConfirmationRetrySummary = {
  configured: boolean;
  candidateCount: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
};

export function assertCommercialConfirmationReadiness(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): void {
  const config = resolveEmailAlertDeliveryConfig(env);
  if (!config.configured) {
    throw new Error(
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
}: {
  acceptanceId: string;
  auth: SupabaseAuthContext;
  consent: CheckoutConsent;
  checkoutSessionId: string;
  checkoutCreatedAt: string;
  requestId: string | null;
  userAgent: string | null;
}): Promise<void> {
  const email =
    typeof auth.claims.email === "string" ? auth.claims.email.trim().toLowerCase() : null;
  const { error } = await supabaseAdmin.from("commercial_acceptances").insert({
    id: acceptanceId,
    user_id: auth.userId,
    purpose: "analyse_checkout",
    terms_version: consent.termsVersion,
    terms_sha256: LEGAL_DOCUMENTS.terms.sha256,
    privacy_version: consent.privacyVersion,
    privacy_sha256: LEGAL_DOCUMENTS.privacy.sha256,
    offer_code: "analyse_30_days",
    amount_cents: 2_900,
    currency: "eur",
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
      offer_label: "ImmoJudis Analyse — 30 jours",
      amount_cents: 2900,
      currency: "eur",
      no_automatic_renewal: true,
    },
  });
  if (error) throw error;
}

export async function sendCommercialConfirmation({
  acceptanceId,
  checkoutSessionId,
  userId,
  paidAt,
}: {
  acceptanceId: string;
  checkoutSessionId: string;
  userId: string;
  paidAt: string;
}): Promise<"sent" | "failed"> {
  const config = resolveEmailAlertDeliveryConfig();
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

  const termsUrl = `${config.appUrl}${LEGAL_DOCUMENTS.terms.path}`;
  const privacyUrl = `${config.appUrl}${LEGAL_DOCUMENTS.privacy.path}`;
  const rightsUrl = `${config.appUrl}/mes-droits`;
  const text = [
    "Confirmation de votre commande ImmoJudis Analyse",
    "",
    "Offre : ImmoJudis Analyse — 30 jours",
    "Prix : 29 € TTC, paiement unique sans renouvellement automatique",
    `Commande confirmée le : ${paidAt}`,
    `Référence : ${checkoutSessionId}`,
    `Conditions acceptées : version ${LEGAL_DOCUMENTS.terms.version}`,
    `Politique de confidentialité : version ${LEGAL_DOCUMENTS.privacy.version}`,
    "Exécution : accès immédiat demandé avant la fin du délai de rétractation.",
    "",
    `Conditions générales : ${termsUrl}`,
    `Confidentialité : ${privacyUrl}`,
    `Exercer un droit ou notifier une rétractation : ${rightsUrl}`,
  ].join("\n");

  try {
    const result = await sendResendEmail({
      apiKey: config.apiKey,
      idempotencyKey: `immojudis-contract-${acceptanceId}`,
      fetchImpl: fetch,
      message: {
        from: config.from,
        to: recipient,
        subject: "Confirmation de votre commande ImmoJudis Analyse",
        text,
        html: `<h1>Commande ImmoJudis Analyse confirmée</h1><p><strong>29 € TTC</strong> pour 30 jours, paiement unique sans renouvellement automatique.</p><p>Confirmation : ${escapeHtml(paidAt)}<br>Référence : ${escapeHtml(checkoutSessionId)}</p><p>Conditions version ${LEGAL_DOCUMENTS.terms.version} · Confidentialité version ${LEGAL_DOCUMENTS.privacy.version}</p><p><a href="${termsUrl}">Conditions générales</a> · <a href="${privacyUrl}">Confidentialité</a> · <a href="${rightsUrl}">Mes droits et rétractation</a></p>`,
      },
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

export async function retryFailedCommercialConfirmations({
  limit = 25,
  now = new Date(),
}: {
  limit?: number;
  now?: Date;
} = {}): Promise<CommercialConfirmationRetrySummary> {
  const config = resolveEmailAlertDeliveryConfig();
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
