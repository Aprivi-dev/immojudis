import "server-only";
import { assertAdmin } from "@/lib/admin-auth.server";
import type Stripe from "stripe";
import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ANALYSIS_CHECKOUT_EXPIRY_MINUTES } from "@/lib/analysis-offer";
import { PublicApiError } from "@/lib/api-errors";
import { getStripe } from "@/lib/billing";
import { formatPriceWithCents } from "@/lib/format/numbers";
import { withinWithdrawalPeriod } from "@/lib/privacy-deadline";
import {
  hasLiveDeductionReservation,
  isDeductedPurchase,
  updatePrivacyRequestForAdmin,
  withdrawalPurchaseIdOf,
  type PrivacyRequestAdminSummary,
} from "@/lib/privacy-requests";

/*
 * Règle métier de la rétractation (CGU, version 2026-11-15.3, articles 2 bis et 6) :
 * - le consommateur dispose de 14 jours à compter de la conclusion du contrat (pour un achat à l'unité :
 *   du paiement) pour se rétracter (art. L. 221-18) ; le remboursement est dû au plus tard 14 jours après
 *   la notification (art. L. 221-24 : échéance `due_at` de la demande) ;
 * - abonnement Analyse : l'exécution immédiate demandée laisse dû un montant proportionné au service déjà
 *   fourni (mode `prorata`) ; le droit n'est perdu qu'en cas d'exécution complète ;
 * - achat d'une vente à l'unité : « l'analyse de la vente est fournie dès la confirmation du paiement, à la
 *   demande expresse du client, qui reconnaît avant le paiement perdre son droit de rétractation une fois
 *   l'accès fourni » (art. 6). Ce code n'en tire AUCUN refus automatique : savoir si l'accès a été fourni
 *   (vente débloquée, crédit utilisé ou non) et si la renonciation est valable (confirmation sur support
 *   durable, art. L. 221-28 13°) relève de l'opérateur. Le panneau lui montre ces faits
 *   (`getContractWithdrawalContext`), il décide : exécuter (remboursement intégral de l'achat) ou refuser
 *   la demande avec ses motifs.
 */

export const contractWithdrawalInputSchema = z.object({
  requestId: z.string().guid(),
  /**
   * `prorata`: the customer asked for immediate performance, so the part of
   * the period already provided stays due (art. L221-25 du Code de la
   * consommation). `full`: refund everything (goodwill, or no use of the service).
   * Ignored for a sale unlock purchase: its payment is refunded in full.
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
    .select("id,request_type,status,user_id,identity_status,operator_notes,metadata")
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

  const purchaseId = withdrawalPurchaseIdOf(request.metadata);
  if (purchaseId) {
    const refund = await refundSaleUnlockPurchase({
      requestId: request.id,
      userId: request.user_id,
      purchaseId,
      now,
    });
    const updated = await closeWithdrawal({
      auth,
      request,
      note: [
        `Rétractation de l'achat à l'unité ${purchaseId} exécutée le ${now.toISOString()}.`,
        refund.note,
      ],
      refundedCents: refund.refundedCents,
    });
    return { request: updated, subscriptionCancelled: false, refundedCents: refund.refundedCents };
  }

  const { data: subscription, error: subscriptionError } = await supabaseAdmin
    .from("user_subscriptions")
    .select("stripe_customer_id,stripe_subscription_id,current_period_end")
    .eq("user_id", request.user_id)
    .maybeSingle();
  if (subscriptionError) throw subscriptionError;
  // M4 (b) : rien à résilier ni à rembourser. La demande reste ouverte et l'accès n'est pas touché :
  // l'opérateur la clôt lui-même (refus motivé, ou sans objet) après vérification.
  if (!subscription?.stripe_subscription_id || !subscription.stripe_customer_id) {
    throw new PublicApiError(
      "Aucun abonnement Stripe ni achat à l'unité à rembourser pour ce compte : rien n'a été modifié. Vérifiez la commande visée, puis clôturez la demande avec vos motifs.",
      409,
    );
  }

  let refundedCents = 0;
  let subscriptionCancelled = false;
  const notes: string[] = [];

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

  // The refund webhooks also end the access; do it now so the customer cannot
  // keep using the service between the two events.
  const { error: endError } = await supabaseAdmin
    .from("user_subscriptions")
    .update({ status: "cancelled", current_period_end: now.toISOString() })
    .eq("user_id", request.user_id);
  if (endError) throw endError;

  const updated = await closeWithdrawal({
    auth,
    request,
    note: [
      `Rétractation exécutée le ${now.toISOString()} (${input.refundMode}).`,
      subscriptionCancelled ? "Abonnement Stripe résilié." : "Abonnement déjà résilié.",
      ...notes,
    ],
    refundedCents,
    requesterNote: "Votre abonnement Analyse est résilié.",
  });
  return { request: updated, subscriptionCancelled, refundedCents };
}

/**
 * Clôt la demande : la note s'AJOUTE au journal opérateur (F3), l'identité vérifiée n'est pas touchée,
 * et l'email de clôture dit au demandeur ce qui a été fait.
 */
async function closeWithdrawal({
  auth,
  request,
  note,
  refundedCents,
  requesterNote,
}: {
  auth: SupabaseAuthContext;
  request: { id: string; operator_notes: string | null };
  note: string[];
  refundedCents: number;
  requesterNote?: string;
}): Promise<PrivacyRequestAdminSummary> {
  const refund =
    refundedCents > 0
      ? `Un remboursement de ${formatPriceWithCents(refundedCents / 100)} a été émis sur le moyen de paiement utilisé.`
      : null;
  return updatePrivacyRequestForAdmin({
    auth,
    input: {
      requestId: request.id,
      status: "completed",
      resolutionCode: "withdrawal_executed",
      operatorNotes: [request.operator_notes, note.join(" ")]
        .filter(Boolean)
        .join("\n")
        .slice(0, 8000),
      response: [requesterNote, refund].filter(Boolean).join(" ") || undefined,
    },
  });
}

/** Clé d'idempotence stable par achat : un achat n'est remboursé qu'une fois, quelle que soit la demande. */
function saleUnlockWithdrawalIdempotencyKey(purchaseId: string): string {
  return `immojudis-sale-unlock-withdrawal-${purchaseId}`;
}

/**
 * Rembourse intégralement le paiement d'un achat à l'unité (son PaymentIntent). Le webhook existant fait
 * le reste : `charge.refunded` est aiguillé par `payment_intent.metadata.purpose === "sale_unlock"` vers
 * l'achat seul (passage à `refunded`, retrait du déblocage), sans toucher l'abonnement ni
 * `user_subscriptions` (`handleChargeRefunded`, `billing.ts`).
 */
async function refundSaleUnlockPurchase({
  requestId,
  userId,
  purchaseId,
  now,
}: {
  requestId: string;
  userId: string;
  purchaseId: string;
  now: Date;
}): Promise<{ refundedCents: number; note: string }> {
  const { data: purchase, error } = await supabaseAdmin
    .from("sale_unlock_purchases")
    .select(
      "id,user_id,state,payment_intent_id,amount_cents,deducted_checkout_session_id,deduction_reserved_token,deduction_reserved_at",
    )
    .eq("id", purchaseId)
    .maybeSingle();
  if (error) throw error;
  if (!purchase || purchase.user_id !== userId) {
    throw new PublicApiError("Achat à l'unité introuvable pour ce compte.", 409);
  }
  if (purchase.state === "refunded") {
    return { refundedCents: 0, note: "Achat déjà remboursé : aucun nouveau remboursement." };
  }
  // Son prix a déjà été rendu par la remise sur le premier mois de l'abonnement : le rembourser aussi
  // le paierait deux fois. La rétractation porte alors sur l'abonnement.
  if (isDeductedPurchase(purchase)) {
    throw new PublicApiError(
      "Achat déduit du premier mois d'un abonnement : il n'est plus remboursable seul, rien n'a été remboursé. Traitez la rétractation de l'abonnement, ou clôturez la demande avec vos motifs.",
      409,
    );
  }
  if (hasLiveDeductionReservation(purchase, now)) {
    throw new PublicApiError(
      `Achat réservé pour la remise d'un paiement d'abonnement en cours : rien n'a été remboursé. Relancez une fois ce paiement abouti ou expiré (${ANALYSIS_CHECKOUT_EXPIRY_MINUTES} minutes au plus).`,
      409,
    );
  }
  if (purchase.state !== "paid" || !purchase.payment_intent_id) {
    throw new PublicApiError(
      `Achat à l'unité non remboursable en l'état (${purchase.state}) : à traiter dans Stripe.`,
      409,
    );
  }
  const stripe = getStripe();
  // Un remboursement déjà émis sur ce paiement (relance après la clé d'idempotence de 24 heures,
  // remboursement fait à la main dans Stripe) : on n'en émet pas un second.
  const existing = await stripe.refunds.list({
    payment_intent: purchase.payment_intent_id,
    limit: 100,
  });
  const previous = existing.data.find(
    (refund) => refund.status !== "failed" && refund.status !== "canceled",
  );
  if (previous) {
    return {
      refundedCents: 0,
      note: `Remboursement ${previous.id} déjà émis sur ce paiement (${previous.amount} centimes) : aucun nouveau remboursement.`,
    };
  }
  const refund = await stripe.refunds.create(
    {
      payment_intent: purchase.payment_intent_id,
      metadata: {
        reason: "contract_withdrawal",
        [WITHDRAWAL_REQUEST_METADATA_KEY]: requestId,
        purchase_id: purchase.id,
      },
    },
    { idempotencyKey: saleUnlockWithdrawalIdempotencyKey(purchase.id) },
  );
  return {
    refundedCents: refund.amount,
    note: `Paiement ${purchase.payment_intent_id} remboursé : ${refund.amount} centimes (${refund.id}).`,
  };
}

export type ContractWithdrawalContext =
  | { target: "subscription"; hasStripeSubscription: boolean }
  | {
      target: "sale_unlock_purchase";
      purchase: {
        id: string;
        state: string;
        paidAt: string | null;
        amountCents: number;
        currency: string;
        /** Payé depuis moins de 14 jours (délai de rétractation, à compter du paiement). */
        withinWithdrawalPeriod: boolean;
        /** Une vente a été ouverte avec cet achat (vente achetée, ou crédit utilisé). */
        accessProvided: boolean;
        /** Déduit du premier mois d'un abonnement : plus remboursable seul (l'exécution est refusée). */
        deducted: boolean;
        /** Renonciation expresse cochée avant le paiement (preuve d'acceptation) ; `null` : introuvable. */
        waiverAcknowledged: boolean | null;
        /** Confirmation de commande envoyée (support durable) ; `null` : aucune trace. */
        confirmationSent: boolean | null;
      } | null;
    };

/**
 * Ce que l'opérateur doit voir avant de décider d'une rétractation : l'objet (abonnement ou achat), et
 * pour un achat les faits dont dépend la renonciation des CGU. Aucune décision n'est prise ici.
 */
export async function getContractWithdrawalContext({
  auth,
  requestId,
}: {
  auth: SupabaseAuthContext;
  requestId: string;
}): Promise<ContractWithdrawalContext> {
  assertAdmin(auth);
  const { data: request, error } = await supabaseAdmin
    .from("data_subject_requests")
    .select("id,request_type,user_id,metadata")
    .eq("id", requestId)
    .single();
  if (error) throw error;
  if (request.request_type !== "contract_withdrawal") {
    throw new PublicApiError("Cette demande n'est pas une rétractation.", 409);
  }
  const purchaseId = withdrawalPurchaseIdOf(request.metadata);
  if (!purchaseId) {
    if (!request.user_id) return { target: "subscription", hasStripeSubscription: false };
    const { data: subscription, error: subscriptionError } = await supabaseAdmin
      .from("user_subscriptions")
      .select("stripe_subscription_id")
      .eq("user_id", request.user_id)
      .maybeSingle();
    if (subscriptionError) throw subscriptionError;
    return {
      target: "subscription",
      hasStripeSubscription: Boolean(subscription?.stripe_subscription_id),
    };
  }
  const { data: purchase, error: purchaseError } = await supabaseAdmin
    .from("sale_unlock_purchases")
    .select(
      "id,user_id,state,paid_at,amount_cents,currency,commercial_acceptance_id,deducted_checkout_session_id",
    )
    .eq("id", purchaseId)
    .maybeSingle();
  if (purchaseError) throw purchaseError;
  if (!purchase || purchase.user_id !== request.user_id) {
    return { target: "sale_unlock_purchase", purchase: null };
  }
  const acceptanceId = purchase.commercial_acceptance_id;
  const [unlocks, acceptance, confirmation] = await Promise.all([
    supabaseAdmin
      .from("user_sale_unlocks")
      .select("id", { count: "exact", head: true })
      .eq("purchase_id", purchase.id),
    acceptanceId
      ? supabaseAdmin
          .from("commercial_acceptances")
          .select("evidence")
          .eq("id", acceptanceId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    acceptanceId
      ? supabaseAdmin
          .from("commercial_confirmation_deliveries")
          .select("status")
          .eq("acceptance_id", acceptanceId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (unlocks.error) throw unlocks.error;
  if (acceptance.error) throw acceptance.error;
  if (confirmation.error) throw confirmation.error;
  const evidence = acceptance.data?.evidence as Record<string, unknown> | null | undefined;
  return {
    target: "sale_unlock_purchase",
    purchase: {
      id: purchase.id,
      state: purchase.state,
      paidAt: purchase.paid_at,
      amountCents: purchase.amount_cents,
      currency: purchase.currency,
      withinWithdrawalPeriod: withinWithdrawalPeriod(purchase.paid_at),
      accessProvided: (unlocks.count ?? 0) > 0,
      deducted: isDeductedPurchase(purchase),
      waiverAcknowledged: evidence ? evidence.withdrawal_waiver_acknowledged === true : null,
      confirmationSent: confirmation.data ? confirmation.data.status === "sent" : null,
    },
  };
}
