import "server-only";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import {
  ANALYSIS_CHECKOUT_EXPIRY_MINUTES,
  SALE_UNLOCK_CURRENCY,
  SALE_UNLOCK_PRICE_CENTS,
  VAT_EXEMPTION_INVOICE_MENTION,
} from "@/lib/analysis-offer";
import { ConfigurationError, PublicApiError } from "@/lib/api-errors";
import {
  type BillingSessionResponse,
  createStripeCustomer,
  getStripe,
  getUserSubscription,
  resolveBillingOrigin,
  stripeObjectId,
} from "@/lib/billing-stripe";
import {
  recordSaleUnlockAcceptance,
  type SaleUnlockConsent,
  sendCommercialConfirmation,
} from "@/lib/commercial-acceptance";
import { saleDetailPath } from "@/lib/navigation";
import { SALE_UNLOCK_CHECKOUT_RETURN_PARAM } from "@/lib/sale-unlock-checkout-contract";
import {
  assertSaleUnlockCheckoutOpen,
  saleUnlockPriceId,
} from "@/lib/sale-unlock-checkout-readiness";
import {
  attachSaleUnlockCheckout,
  expireSaleUnlockPurchase,
  grantPurchasedSaleUnlock,
  recordSaleUnlockPaymentState,
  reserveSaleUnlockPurchase,
  SaleUnlockGrantRefusedError,
  SaleUnlockPurchaseRefusedError,
} from "@/lib/sale-unlock-purchase";

/**
 * Achat du déblocage d'une vente à l'unité, côté Stripe (lot 3) : session Checkout, contrôle du Price,
 * et ce que le webhook fait d'un achat (paiement, expiration, remboursement, litige). `billing.ts`
 * aiguille les événements ici d'après `metadata.purpose` ; les décisions sont prises par la base
 * (`sale-unlock-purchase.ts`).
 */

/** Valeur de `metadata.purpose` des paiements d'achat d'une vente à l'unité (session et PaymentIntent). */
export const SALE_UNLOCK_PAYMENT_PURPOSE = "sale_unlock";

/** La session Checkout est-elle celle d'un achat à l'unité ? */
export function isSaleUnlockCheckoutSession(session: Pick<Stripe.Checkout.Session, "metadata">) {
  return session.metadata?.purpose === SALE_UNLOCK_PAYMENT_PURPOSE;
}

/** La charge est-elle le paiement d'un achat à l'unité ? (voir `stripePaymentPurpose`) */
export async function isSaleUnlockCharge(charge: Stripe.Charge): Promise<boolean> {
  return (await stripePaymentPurpose(charge)) === SALE_UNLOCK_PAYMENT_PURPOSE;
}

/** Session d'achat expirée sans paiement : l'achat en attente passe à `expired`. */
export function handleSaleUnlockCheckoutExpired(
  session: Stripe.Checkout.Session,
): Promise<boolean> {
  return expireSaleUnlockPurchase(session.id);
}

/**
 * Achat du déblocage d'une vente à l'unité (19 € TTC, paiement unique). La session ne débloque
 * rien : seul le webhook (`handleSaleUnlockCheckoutCompleted`) accorde la vente, après paiement.
 *
 * Ordre : garde d'ouverture (503 sans aucune écriture), contrôle du Price chez Stripe, réservation
 * en base (ses refus deviennent des 409 avec leur code), puis session Checkout, preuve de
 * l'acceptation et rattachement de la session à l'achat. Une réservation en attente dont la session
 * est encore ouverte renvoie cette session ; expirée, elle est remplacée.
 */
export async function createSaleUnlockCheckoutSession({
  auth,
  origin,
  saleId,
  consent,
  requestId,
  userAgent,
}: {
  auth: SupabaseAuthContext;
  origin?: string | null;
  saleId: string;
  consent: SaleUnlockConsent;
  requestId?: string | null;
  userAgent?: string | null;
}): Promise<BillingSessionResponse> {
  assertSaleUnlockCheckoutOpen(process.env);
  const priceId = saleUnlockPriceId();
  if (!priceId) throw new ConfigurationError("STRIPE_SALE_UNLOCK_PRICE_ID manquant ou invalide.");
  const stripe = getStripe();
  const appOrigin = resolveBillingOrigin(origin);
  await resolveConfiguredSaleUnlockPrice(stripe, priceId);

  let { purchaseId, existingSessionId } = await reserveSaleUnlockPurchase(auth.userId, saleId);
  if (existingSessionId) {
    const reusable = await reusableSaleUnlockSessionUrl(stripe, existingSessionId);
    if (reusable) return { url: reusable };
    // Session expirée dont le webhook n'est pas encore passé : on fait ce qu'il ferait (l'achat en
    // attente passe à `expired`), puis on réserve un nouvel achat.
    await expireSaleUnlockPurchase(existingSessionId);
    ({ purchaseId, existingSessionId } = await reserveSaleUnlockPurchase(auth.userId, saleId));
    if (existingSessionId) throw saleUnlockCheckoutInProgress();
  }

  const customerId =
    (await getUserSubscription(auth))?.stripe_customer_id ??
    (await createStripeCustomer(stripe, auth)).id;
  const acceptanceId = randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + ANALYSIS_CHECKOUT_EXPIRY_MINUTES * 60;
  const session = await stripe.checkout.sessions.create(
    buildSaleUnlockCheckoutSessionParams({
      appOrigin,
      customerId,
      userId: auth.userId,
      saleId,
      purchaseId,
      acceptanceId,
      priceId,
      expiresAt,
    }),
    // Propre à cette demande : les nouvelles tentatives du SDK ne créent pas de seconde session, et
    // une demande précédente en échec ne bloque pas celle-ci. Deux demandes simultanées créent deux
    // sessions, mais la base n'en rattache qu'une à l'achat : l'autre est expirée ci-dessous.
    { idempotencyKey: `immojudis-sale-unlock-${purchaseId}-${acceptanceId}` },
  );

  const checkoutUrl = session.url;
  let attached = false;
  try {
    if (!checkoutUrl) throw new Error("Stripe Checkout session has no URL.");
    await recordSaleUnlockAcceptance({
      acceptanceId,
      auth,
      consent,
      checkoutSessionId: session.id,
      checkoutCreatedAt: new Date(session.created * 1000).toISOString(),
      requestId: requestId ?? null,
      userAgent: userAgent ?? null,
      priceId,
      amountCents: SALE_UNLOCK_PRICE_CENTS,
      saleId,
      purchaseId,
    });
    attached = await attachSaleUnlockCheckout(purchaseId, session.id, acceptanceId);
  } finally {
    // Sans preuve d'acceptation ni rattachement à l'achat, la session ne doit pas pouvoir être payée.
    if (!attached && session.status === "open") {
      await stripe.checkout.sessions.expire(session.id).catch(() => undefined);
    }
  }
  if (attached && checkoutUrl) return { url: checkoutUrl };
  // L'achat porte déjà une autre session (demande concurrente) : on renvoie celle-là si elle est ouverte.
  const current = await reserveSaleUnlockPurchase(auth.userId, saleId);
  const url = current.existingSessionId
    ? await reusableSaleUnlockSessionUrl(stripe, current.existingSessionId)
    : null;
  if (!url) throw saleUnlockCheckoutInProgress();
  return { url };
}

function saleUnlockCheckoutInProgress(): PublicApiError {
  return new PublicApiError(
    "Un paiement est déjà en préparation pour cette vente. Réessayez dans un instant.",
    409,
  );
}

/**
 * URL d'une session d'achat encore ouverte, à réutiliser ; `null` si elle a expiré ou n'existe pas. Payée, elle lève
 * le refus `already_unlocked` : le webhook accorde la vente (ou l'a fait), rien n'est à repayer.
 */
async function reusableSaleUnlockSessionUrl(
  stripe: Stripe,
  sessionId: string,
): Promise<string | null> {
  let existing: Stripe.Checkout.Session;
  try {
    existing = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (error) {
    // Session inconnue de la clé courante (changement de compte ou de mode Stripe) : elle ne sera
    // jamais payée, on la traite comme expirée au lieu de bloquer l'achat de cette vente.
    if ((error as { code?: unknown } | null)?.code === "resource_missing") return null;
    throw error;
  }
  if (existing.status === "open" && existing.url) return existing.url;
  if (existing.status === "complete") throw new SaleUnlockPurchaseRefusedError("already_unlocked");
  return null;
}

export function buildSaleUnlockCheckoutSessionParams({
  appOrigin,
  customerId,
  userId,
  saleId,
  purchaseId,
  acceptanceId,
  priceId,
  expiresAt,
}: {
  appOrigin: string;
  customerId: string;
  userId: string;
  saleId: string;
  purchaseId: string;
  acceptanceId: string;
  priceId: string;
  expiresAt: number;
}): Stripe.Checkout.SessionCreateParams {
  // Les mêmes métadonnées sur la session et sur le PaymentIntent : un remboursement ou un litige
  // (événements de charge) est aiguillé sur l'achat par celles du PaymentIntent.
  const metadata = {
    purpose: SALE_UNLOCK_PAYMENT_PURPOSE,
    user_id: userId,
    sale_id: saleId,
    purchase_id: purchaseId,
    commercial_acceptance_id: acceptanceId,
  };
  const salePage = `${appOrigin}${saleDetailPath(saleId)}`;
  return {
    mode: "payment",
    customer: customerId,
    client_reference_id: userId,
    line_items: [{ price: priceId, quantity: 1 }],
    payment_method_types: ["card"],
    // Facture du paiement, avec la mention de la franchise de TVA en pied.
    invoice_creation: {
      enabled: true,
      invoice_data: { footer: VAT_EXEMPTION_INVOICE_MENTION, metadata },
    },
    payment_intent_data: { metadata },
    metadata,
    locale: "fr",
    expires_at: expiresAt,
    // Le retour ne fait que relire l'état du déblocage : seul le webhook l'accorde.
    success_url: `${salePage}?${SALE_UNLOCK_CHECKOUT_RETURN_PARAM}=success`,
    cancel_url: `${salePage}?${SALE_UNLOCK_CHECKOUT_RETURN_PARAM}=cancelled`,
  };
}

/**
 * Le Price de l'achat à l'unité, relu chez Stripe avant chaque session : actif, paiement unique,
 * 19 € en EUR, comportement fiscal « inclusive » (prix final, franchise de TVA), comme celui de
 * l'abonnement (`resolveConfiguredAnalysisPrice`).
 */
async function resolveConfiguredSaleUnlockPrice(
  stripe: Stripe,
  priceId: string,
): Promise<Stripe.Price> {
  const price = await stripe.prices.retrieve(priceId);
  if (
    !price.active ||
    price.type !== "one_time" ||
    price.currency !== SALE_UNLOCK_CURRENCY ||
    price.unit_amount !== SALE_UNLOCK_PRICE_CENTS ||
    price.tax_behavior !== "inclusive"
  ) {
    throw new ConfigurationError(
      "Le Price Stripe de l’achat à l’unité doit être actif, en paiement unique, à 19 € en EUR et « inclusive ».",
    );
  }
  return price;
}

/**
 * Session d'achat d'une vente à l'unité payée. Le déblocage n'est accordé qu'ici, jamais au retour
 * du navigateur : paiement encaissé, 19 € en EUR, puis la base accorde la vente (ou un crédit si elle
 * n'est plus débloquable) une seule fois par achat, quel que soit le nombre d'événements.
 */
export async function handleSaleUnlockCheckoutCompleted(
  session: Stripe.Checkout.Session,
  event: Stripe.Event,
): Promise<boolean> {
  const metadata = session.metadata ?? {};
  if (
    session.mode !== "payment" ||
    session.payment_status !== "paid" ||
    session.amount_total !== SALE_UNLOCK_PRICE_CENTS ||
    session.currency !== SALE_UNLOCK_CURRENCY
  ) {
    return false;
  }
  const paymentIntentId = stripeObjectId(session.payment_intent);
  const { user_id: userId, sale_id: saleId, purchase_id: purchaseId } = metadata;
  if (!userId || !saleId || !purchaseId || !paymentIntentId) return false;
  const paidAt = new Date(event.created * 1000).toISOString();
  let grant: Awaited<ReturnType<typeof grantPurchasedSaleUnlock>>;
  try {
    grant = await grantPurchasedSaleUnlock({
      purchaseId,
      userId,
      saleId,
      checkoutSessionId: session.id,
      paymentIntentId,
      amountCents: session.amount_total,
      currency: session.currency,
      eventId: event.id,
      paidAt,
    });
  } catch (error) {
    // Refus définitif de la base (achat inconnu ou qui ne correspond pas) : rejouer n'y changerait
    // rien. L'événement reste « ignoré » et le rapprochement signale le paiement sans achat payé.
    if (!(error instanceof SaleUnlockGrantRefusedError)) throw error;
    console.error("[billing] sale unlock payment refused by the database", {
      session: session.id,
      reason: error.message,
    });
    return false;
  }
  const acceptanceId = metadata.commercial_acceptance_id;
  if (grant.granted && acceptanceId) {
    await sendCommercialConfirmation({
      acceptanceId,
      checkoutSessionId: session.id,
      userId,
      paidAt,
      saleUnlockOutcome: grant.outcome ?? undefined,
    }).catch((confirmationError) => {
      console.error("[billing] durable confirmation failed", confirmationError);
    });
  }
  return grant.granted;
}

/**
 * Objet du paiement d'une charge, lu dans les métadonnées de son PaymentIntent (posées par la session
 * d'achat à l'unité) : sur le PaymentIntent développé, sinon sur la charge, sinon relu chez Stripe.
 * Une erreur de Stripe se propage : le webhook est rejoué plutôt que de traiter le paiement comme
 * celui d'un abonnement.
 */
async function stripePaymentPurpose(charge: Stripe.Charge): Promise<string | null> {
  const paymentIntent = charge.payment_intent;
  if (paymentIntent && typeof paymentIntent === "object") {
    return paymentIntent.metadata?.purpose || null;
  }
  if (charge.metadata?.purpose) return charge.metadata.purpose;
  if (!paymentIntent) return null;
  const retrieved = await getStripe().paymentIntents.retrieve(paymentIntent);
  return retrieved.metadata?.purpose || null;
}

/**
 * Remboursement ou litige d'un achat à l'unité : seul l'achat est mis à jour. Ni `user_subscriptions`,
 * ni l'abonnement Stripe du compte ne sont touchés (un remboursement de 19 € ne coupe pas un abonné).
 */
export async function recordSaleUnlockChargeState(
  charge: Stripe.Charge,
  state: "refunded" | "disputed" | "dispute_lost" | "paid",
  event: Stripe.Event,
): Promise<boolean> {
  const paymentIntentId = stripeObjectId(charge.payment_intent);
  if (!paymentIntentId) return false;
  return recordSaleUnlockPaymentState({
    paymentIntentId,
    state,
    eventId: event.id,
    eventCreated: event.created,
  });
}
