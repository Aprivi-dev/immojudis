import "server-only";
import { assertAdmin } from "@/lib/admin-auth.server";
import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { PublicApiError } from "@/lib/api-errors";
import { getStripe } from "@/lib/billing";
import {
  updatePrivacyRequestForAdmin,
  type PrivacyRequestAdminSummary,
} from "@/lib/privacy-requests";

export const contractWithdrawalInputSchema = z.object({
  requestId: z.string().guid(),
  /**
   * `prorata`: the customer asked for immediate performance, so the part of
   * the period already provided stays due (art. L221-25 du Code de la
   * consommation). `full`: refund everything (goodwill, or no use of the service).
   */
  refundMode: z.enum(["prorata", "full"]),
  /**
   * The operator confirmed on the compliance screen: the subscription is cancelled and the
   * refund issued at once (same principle as `confirmEmail` for an erasure).
   */
  confirm: z.literal(true),
});

export type ContractWithdrawalInput = z.infer<typeof contractWithdrawalInputSchema>;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Amount to give back, in cents, for one paid period.
 * Nothing is refundable before a charge exists, and the result never exceeds
 * what remains of the charge. What was already refunded on the charge counts
 * toward the amount due (C9, 08/11): a withdrawal run twice tops up to the
 * prorata at most, it never pays the prorata a second time.
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
  const alreadyRefunded = Math.max(0, alreadyRefundedCents);
  const refundable = Math.max(0, chargedCents - alreadyRefunded);
  if (refundable === 0) return 0;
  if (mode === "full") return refundable;

  const periodMs = periodEnd.getTime() - periodStart.getTime();
  if (!(periodMs > 0)) return 0;
  const elapsedMs = Math.min(Math.max(requestedAt.getTime() - periodStart.getTime(), 0), periodMs);
  // Round the provided part up to the next day: a started day is a day provided.
  const providedDays = Math.ceil(elapsedMs / DAY_MS);
  const periodDays = Math.ceil(periodMs / DAY_MS);
  const remainingShare = Math.max(0, (periodDays - providedDays) / periodDays);
  const dueCents = Math.floor(chargedCents * remainingShare);
  return Math.min(refundable, Math.max(0, dueCents - alreadyRefunded));
}

/** Metadata key that ties a Stripe refund to the withdrawal request that issued it. */
const WITHDRAWAL_REQUEST_METADATA_KEY = "withdrawal_request_id";

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
  assertAdmin(auth);

  const { data: request, error: requestError } = await supabaseAdmin
    .from("data_subject_requests")
    .select("id,request_type,status,user_id,identity_status")
    .eq("id", input.requestId)
    .single();
  if (requestError) throw requestError;
  if (request.request_type !== "contract_withdrawal") {
    throw new PublicApiError("Cette demande n'est pas une rétractation.", 409);
  }
  if (request.status === "completed" || request.status === "rejected") {
    throw new PublicApiError("Cette demande est déjà clôturée.", 409);
  }
  if (!request.user_id) {
    throw new PublicApiError("La demande n'est rattachée à aucun compte.", 409);
  }

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
    // C9 : une rétractation relancée (clôture de la demande en échec, double clic, nouvel essai le
    // lendemain quand la clé d'idempotence Stripe a expiré) ne rembourse pas une seconde fois.
    const previousRefund = charge
      ? (await stripe.refunds.list({ charge: charge.id, limit: 100 })).data.find(
          (refund) =>
            refund.status !== "failed" &&
            refund.status !== "canceled" &&
            refund.metadata?.[WITHDRAWAL_REQUEST_METADATA_KEY] === request.id,
        )
      : undefined;
    if (previousRefund) {
      notes.push(
        `Remboursement ${previousRefund.id} déjà émis pour cette rétractation (${previousRefund.amount} centimes) : aucun nouveau remboursement.`,
      );
    } else if (charge && periodStart && periodEnd) {
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
          {
            charge: charge.id,
            amount,
            metadata: {
              reason: "contract_withdrawal",
              [WITHDRAWAL_REQUEST_METADATA_KEY]: request.id,
            },
          },
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
