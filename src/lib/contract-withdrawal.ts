import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getStripe } from "@/lib/billing";
import {
  updatePrivacyRequestForAdmin,
  type PrivacyRequestAdminSummary,
} from "@/lib/privacy-requests";

export const contractWithdrawalInputSchema = z.object({
  requestId: z.string().uuid(),
  /**
   * `prorata`: the customer asked for immediate performance, so the part of
   * the period already provided stays due (art. L221-25 du Code de la
   * consommation). `full`: refund everything (goodwill, or no use of the service).
   */
  refundMode: z.enum(["prorata", "full"]),
});

export type ContractWithdrawalInput = z.infer<typeof contractWithdrawalInputSchema>;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Amount to give back, in cents, for one paid period.
 * Nothing is refundable before a charge exists, and the result never exceeds
 * what remains of the charge.
 */
export function computeWithdrawalRefundCents({
  chargedCents,
  alreadyRefundedCents = 0,
  periodStart,
  periodEnd,
  requestedAt,
  mode,
}: {
  chargedCents: number;
  alreadyRefundedCents?: number;
  periodStart: Date;
  periodEnd: Date;
  requestedAt: Date;
  mode: "prorata" | "full";
}): number {
  const refundable = Math.max(0, chargedCents - Math.max(0, alreadyRefundedCents));
  if (refundable === 0) return 0;
  if (mode === "full") return refundable;

  const periodMs = periodEnd.getTime() - periodStart.getTime();
  if (!(periodMs > 0)) return 0;
  const elapsedMs = Math.min(Math.max(requestedAt.getTime() - periodStart.getTime(), 0), periodMs);
  // Round the provided part up to the next day: a started day is a day provided.
  const providedDays = Math.ceil(elapsedMs / DAY_MS);
  const periodDays = Math.ceil(periodMs / DAY_MS);
  const remainingShare = Math.max(0, (periodDays - providedDays) / periodDays);
  return Math.min(refundable, Math.floor(chargedCents * remainingShare));
}

export type ContractWithdrawalResult = {
  request: PrivacyRequestAdminSummary;
  subscriptionCancelled: boolean;
  refundedCents: number;
};

/**
 * Handle a `contract_withdrawal` request end to end: cancel the Stripe
 * subscription now, refund the right amount, end the local entitlement and
 * close the request with an auditable note.
 */
export async function executeContractWithdrawal({
  auth,
  input,
  now = new Date(),
}: {
  auth: SupabaseAuthContext;
  input: ContractWithdrawalInput;
  now?: Date;
}): Promise<ContractWithdrawalResult> {
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");

  const { data: request, error: requestError } = await supabaseAdmin
    .from("data_subject_requests")
    .select("id,request_type,status,user_id,identity_status")
    .eq("id", input.requestId)
    .single();
  if (requestError) throw requestError;
  if (request.request_type !== "contract_withdrawal") {
    throw new Error("Cette demande n'est pas une rétractation.");
  }
  if (request.status === "completed" || request.status === "rejected") {
    throw new Error("Cette demande est déjà clôturée.");
  }
  if (!request.user_id) throw new Error("La demande n'est rattachée à aucun compte.");

  const { data: subscription, error: subscriptionError } = await supabaseAdmin
    .from("user_subscriptions")
    .select("stripe_customer_id,stripe_subscription_id,current_period_end")
    .eq("user_id", request.user_id)
    .maybeSingle();
  if (subscriptionError) throw subscriptionError;

  let refundedCents = 0;
  let subscriptionCancelled = false;
  const notes: string[] = [];

  if (subscription?.stripe_subscription_id && subscription.stripe_customer_id) {
    const stripe = getStripe();
    const stripeSubscription = await stripe.subscriptions.retrieve(
      subscription.stripe_subscription_id,
    );
    const item = stripeSubscription.items.data[0];
    const periodStart = item?.current_period_start
      ? new Date(item.current_period_start * 1000)
      : null;
    const periodEnd = item?.current_period_end ? new Date(item.current_period_end * 1000) : null;

    if (stripeSubscription.status !== "canceled") {
      await stripe.subscriptions.cancel(stripeSubscription.id);
      subscriptionCancelled = true;
    }

    const charges = await stripe.charges.list({
      customer: subscription.stripe_customer_id,
      limit: 5,
    });
    const charge = charges.data.find((candidate) => candidate.paid && !candidate.refunded);
    if (charge && periodStart && periodEnd) {
      const amount = computeWithdrawalRefundCents({
        chargedCents: charge.amount,
        alreadyRefundedCents: charge.amount_refunded,
        periodStart,
        periodEnd,
        requestedAt: now,
        mode: input.refundMode,
      });
      if (amount > 0) {
        await stripe.refunds.create(
          { charge: charge.id, amount, metadata: { reason: "contract_withdrawal" } },
          { idempotencyKey: `immojudis-withdrawal-${request.id}` },
        );
        refundedCents = amount;
      }
      notes.push(`Charge ${charge.id} : ${charge.amount} centimes, remboursé ${amount}.`);
    } else {
      notes.push("Aucun paiement remboursable (essai en cours ou déjà remboursé).");
    }
  } else {
    notes.push("Aucun abonnement Stripe associé au compte.");
  }

  // The refund webhooks also end the access; do it now so the customer cannot
  // keep using the service between the two events.
  const { error: endError } = await supabaseAdmin
    .from("user_subscriptions")
    .update({ status: "cancelled", current_period_end: now.toISOString() })
    .eq("user_id", request.user_id);
  if (endError) throw endError;

  const updated = await updatePrivacyRequestForAdmin({
    auth,
    input: {
      requestId: request.id,
      status: "completed",
      identityStatus: "authenticated",
      resolutionCode: "withdrawal_executed",
      operatorNotes: [
        `Rétractation exécutée le ${now.toISOString()} (${input.refundMode}).`,
        subscriptionCancelled ? "Abonnement Stripe résilié." : "Abonnement déjà résilié.",
        ...notes,
      ].join(" "),
    },
  });
  return { request: updated, subscriptionCancelled, refundedCents };
}
