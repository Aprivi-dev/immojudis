import "server-only";
import { assertAdmin } from "@/lib/admin-auth.server";
import type Stripe from "stripe";
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

/**
 * Paiements du client lus en une page. Au-delà, la recherche d'un remboursement déjà émis ne
 * couvrirait plus tous ses paiements : la rétractation est refusée plutôt que de risquer un second
 * remboursement (plus de huit ans de mensualités : à traiter dans Stripe).
 */
const CUSTOMER_CHARGES_LIMIT = 100;

function stripeId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

/**
 * La charge payée de la dernière facture de l'abonnement, parmi les charges du client. Avec la
 * version d'API du code, une facture ne porte plus sa charge : son paiement réglé (`payments`, lu
 * avec elle) désigne un PaymentIntent, ou la charge elle-même pour un paiement sans PaymentIntent.
 * `null` quand cette facture n'a rien encaissé (essai, facture impayée). Une facture qui a encaissé
 * sans charge retrouvée lève une erreur : la demande ne doit pas être close sans remboursement.
 */
function latestInvoiceCharge(
  subscription: Stripe.Subscription,
  charges: readonly Stripe.Charge[],
): Stripe.Charge | null {
  const invoice = subscription.latest_invoice;
  if (!invoice) return null;
  if (typeof invoice === "string") {
    throw new PublicApiError(
      "Dernière facture de l'abonnement illisible : rétractation à reprendre.",
      409,
    );
  }
  const payment = invoice.payments?.data.find((candidate) => candidate.status === "paid")?.payment;
  const chargeId = stripeId(payment?.charge);
  const paymentIntentId = stripeId(payment?.payment_intent);
  const charge =
    charges.find(
      (candidate) =>
        candidate.paid &&
        ((chargeId !== null && candidate.id === chargeId) ||
          (paymentIntentId !== null && stripeId(candidate.payment_intent) === paymentIntentId)),
    ) ?? null;
  if (!charge && invoice.amount_paid > 0) {
    throw new PublicApiError(
      `Paiement de la facture ${invoice.id} introuvable parmi ceux du client : vérifier dans Stripe avant de relancer.`,
      409,
    );
  }
  return charge;
}

/** Le remboursement déjà émis pour cette demande, sur n'importe quelle charge du client. */
function findWithdrawalRefund(
  charges: readonly Stripe.Charge[],
  requestId: string,
): Stripe.Refund | undefined {
  for (const charge of charges) {
    const refund = charge.refunds?.data.find(
      (candidate) =>
        candidate.status !== "failed" &&
        candidate.status !== "canceled" &&
        candidate.metadata?.[WITHDRAWAL_REQUEST_METADATA_KEY] === requestId,
    );
    if (refund) return refund;
  }
  return undefined;
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
  assertAdmin(auth);
  // Defence in depth: the route already validates `confirm: true`; a caller that bypasses it
  // cancels and refunds nothing without the operator's confirmation.
  if ((input.confirm as unknown) !== true) {
    throw new PublicApiError("Confirmez la rétractation avant de l'exécuter.", 400);
  }

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
    // Tout est lu avant d'agir : la dernière facture de l'abonnement avec ses paiements, et les
    // paiements du client avec leurs remboursements.
    const stripeSubscription = await stripe.subscriptions.retrieve(
      subscription.stripe_subscription_id,
      { expand: ["latest_invoice.payments"] },
    );
    const charges = await stripe.charges.list({
      customer: subscription.stripe_customer_id,
      limit: CUSTOMER_CHARGES_LIMIT,
      expand: ["data.refunds"],
    });
    if (charges.has_more) {
      throw new PublicApiError(
        `Plus de ${CUSTOMER_CHARGES_LIMIT} paiements pour ce client : rétractation à traiter dans Stripe, après lecture de ses remboursements.`,
        409,
      );
    }
    const item = stripeSubscription.items.data[0];
    const periodStart = item?.current_period_start
      ? new Date(item.current_period_start * 1000)
      : null;
    const periodEnd = item?.current_period_end ? new Date(item.current_period_end * 1000) : null;
    // C6 (14/11) : la charge visée est celle de la dernière facture de l'abonnement, et non « la
    // première charge payée et pas entièrement remboursée » : en mode `full`, la charge déjà
    // remboursée sortait de cette recherche, et une relance remboursait une autre charge du client.
    const charge = latestInvoiceCharge(stripeSubscription, charges.data);

    if (stripeSubscription.status !== "canceled") {
      await stripe.subscriptions.cancel(stripeSubscription.id);
      subscriptionCancelled = true;
    }

    // C9 puis C6 : une rétractation relancée (clôture de la demande en échec, double clic, nouvel
    // essai le lendemain quand la clé d'idempotence Stripe a expiré) ne rembourse pas une seconde
    // fois. Le remboursement déjà émis est cherché sur toutes les charges du client, pas seulement
    // sur la charge visée.
    const previousRefund = findWithdrawalRefund(charges.data, request.id);
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
      notes.push("Aucun paiement remboursable (essai en cours ou dernière facture non réglée).");
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
