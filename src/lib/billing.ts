import Stripe from "stripe";
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { normalizePlanCode, type PlanCode, type PlanStatus } from "@/lib/plans";
import { nullableRpcArg } from "@/lib/rpc-args";
import { resolveSiteOrigin } from "@/lib/site-url";
import {
  type CheckoutConsent,
  recordCommercialAcceptance,
  recordSaleUnlockAcceptance,
  type SaleUnlockConsent,
  sendCommercialConfirmation,
} from "@/lib/commercial-acceptance";
import {
  analysisPriceId,
  assertAnalysisCheckoutOpen,
  stripeKeyMode,
} from "@/lib/analysis-checkout-readiness";
import { serverEnv } from "@/lib/env";
import { ConfigurationError, PublicApiError } from "@/lib/api-errors";
import type { BillingPortalIntent } from "@/lib/billing-portal-request";
import {
  sendCancellationConfirmationNotice,
  sendPaymentActionRequiredNotice,
  sendPaymentFailedNotice,
  sendTrialEndingNotice,
  type CancellationNoticeKind,
} from "@/lib/billing-notices";
import {
  ANALYSIS_BILLING_MODEL,
  ANALYSIS_CHECKOUT_EXPIRY_MINUTES,
  ANALYSIS_OFFER_CODE,
  ANALYSIS_RECURRING_CURRENCY,
  ANALYSIS_RECURRING_INTERVAL,
  ANALYSIS_RECURRING_INTERVAL_COUNT,
  ANALYSIS_RECURRING_PRICE_CENTS,
  ANALYSIS_SUBSCRIPTION_BILLING_MODEL,
  ANALYSIS_SUBSCRIPTION_OFFER_CODE,
  ANALYSIS_TRIAL_DAYS,
  resolveAnalysisOfferLabel,
  SALE_UNLOCK_CHECKOUT_RETURN_PARAM,
  SALE_UNLOCK_CURRENCY,
  SALE_UNLOCK_PRICE_CENTS,
  STRIPE_CHECKOUT_TRIAL_OFFERED,
  VAT_EXEMPTION_INVOICE_MENTION,
} from "@/lib/analysis-offer";
import { asJson } from "@/lib/supabase-json";
import { saleDetailPath } from "@/lib/navigation";
import {
  assertSaleUnlockCheckoutOpen,
  saleUnlockPriceId,
} from "@/lib/sale-unlock-checkout-readiness";
import {
  attachSaleUnlockCheckout,
  expireSaleUnlockPurchase,
  grantPurchasedSaleUnlock,
  previewUnitPurchaseDeductionCents,
  recordSaleUnlockPaymentState,
  releaseUnitPurchaseDeduction,
  reserveSaleUnlockPurchase,
  reserveUnitPurchaseDeduction,
  SaleUnlockGrantRefusedError,
  SaleUnlockPurchaseRefusedError,
  settleUnitPurchaseDeduction,
} from "@/lib/sale-unlock-purchase";

type UserSubscriptionRow = Database["public"]["Tables"]["user_subscriptions"]["Row"];

export type BillingSessionResponse = {
  url: string;
};

export type StripeWebhookResult = {
  eventId: string;
  type: string;
  handled: boolean;
  duplicate?: boolean;
};

type StripePaymentLifecycleState = "disputed" | "dispute_lost" | "cleared" | "refunded";
type StripeReconciledPlanStatus = "active" | "paused" | "cancelled" | "expired";

const STRIPE_API_VERSION = "2026-06-24.dahlia";
/** Legacy one-time access (30 days) retained for validating historical webhooks. */
export const ANALYSIS_ACCESS_DAYS = 30;

function resolveAnalysisPriceId(): string {
  const priceId = analysisPriceId();
  if (priceId) return priceId;
  throw new ConfigurationError(
    serverEnv().stripe.analysisPriceId
      ? "Stripe Analyse n'est pas configuré: STRIPE_ANALYSIS_PRICE_ID invalide."
      : "Stripe Analyse n'est pas configuré: STRIPE_ANALYSIS_PRICE_ID manquant pour le tarif validé de 59 € / mois.",
  );
}

let stripeClient: Stripe | undefined;

const ANALYSIS_ALREADY_ATTACHED_MESSAGE =
  "Un abonnement Analyse ou un checkout est déjà associé à ce compte. Gérez-le depuis le portail Stripe.";

function stripeSecretKey(): string {
  const key = serverEnv().stripe.secretKey;
  if (!key) throw new ConfigurationError("Stripe n'est pas configuré: STRIPE_SECRET_KEY manquant.");
  return key;
}

function stripeWebhookSecret(): string {
  const secret = serverEnv().stripe.webhookSecret;
  if (!secret)
    throw new ConfigurationError("Stripe webhook non configuré: STRIPE_WEBHOOK_SECRET manquant.");
  return secret;
}

export function getStripe(): Stripe {
  if (!stripeClient) {
    stripeClient = new Stripe(stripeSecretKey(), {
      apiVersion: STRIPE_API_VERSION,
      maxNetworkRetries: 2,
      typescript: true,
    });
  }

  return stripeClient;
}

export function resolveBillingOrigin(requestOrigin?: string | null): string {
  return resolveSiteOrigin(process.env, requestOrigin || "http://localhost:3000")!;
}

export async function createPlanCheckoutSession({
  auth,
  origin,
  plan: _plan,
  consent,
  requestId,
  userAgent,
}: {
  auth: SupabaseAuthContext;
  origin?: string | null;
  plan: Exclude<PlanCode, "decouverte">;
  consent: CheckoutConsent;
  requestId?: string | null;
  userAgent?: string | null;
}): Promise<BillingSessionResponse> {
  // Une seule définition de « paiements ouverts » (`analysisCheckoutReadiness`) : configuration
  // Stripe complète, secret de webhook compris (sans lui, un paiement n'ouvrirait aucun accès),
  // identité légale et canal de confirmation. L'essai gratuit à l'inscription (interrupteur de
  // l'offre de lancement) n'y entre pas : ce contrôle serveur ne le lit pas, et il accepterait donc
  // un checkout demandé pendant l'essai (appel direct à la route).
  //
  // Décision retenue (session du 27/10/2026, n° 17) : l'INTERFACE, elle, reste fermée à la souscription
  // pendant l'essai tant que le paiement n'est pas ouvert. `BillingActions` montre à un compte en
  // essai la mention de l'essai et « Me prévenir de l'ouverture », jamais le bouton de souscription.
  // Souscrire en cours d'essai ferait de toute façon perdre les jours restants (l'abonnement
  // remplace l'essai : `resolvePlanEntitlements` ne donne l'essai qu'à un compte Découverte).
  assertAnalysisCheckoutOpen(process.env);
  const stripe = getStripe();
  const appOrigin = resolveBillingOrigin(origin);
  const priceId = resolveAnalysisPriceId();
  const price = await resolveConfiguredAnalysisPrice(stripe, priceId);
  const reservationToken = randomUUID();
  // Start the Session window before acquiring the database reservation so
  // Customer/history requests cannot make Checkout outlive that reservation.
  const checkoutExpiresAt = Math.floor(Date.now() / 1000) + ANALYSIS_CHECKOUT_EXPIRY_MINUTES * 60;
  let reserved = await reserveAnalyseCheckout(auth.userId, reservationToken);
  // Un checkout abandonné garde la réservation jusqu'à 31 minutes : on libère le Checkout ouvert
  // et abandonné du même compte, puis on réessaie une fois.
  if (!reserved && (await reclaimAbandonedCheckout(stripe, auth).catch(() => false))) {
    reserved = await reserveAnalyseCheckout(auth.userId, reservationToken);
  }
  if (!reserved) {
    throw new PublicApiError(ANALYSIS_ALREADY_ATTACHED_MESSAGE, 409);
  }
  const acceptanceId = randomUUID();

  let session: Stripe.Checkout.Session | null = null;
  let deductionReserved = false;
  let deduction: UnitPurchaseDeduction | null = null;
  try {
    // The account reservation must already exist before Customer creation. The
    // RPC-backed attach below then merges the customer id while retaining this
    // reservation token, so a second first checkout cannot race this request.
    const customerId = await ensureStripeCustomer(auth, reservationToken);
    const subscriptionHistory = await listCustomerSubscriptions(stripe, customerId);
    if (
      subscriptionHistory.some((subscription) =>
        ["trialing", "active", "past_due", "paused", "incomplete"].includes(subscription.status),
      )
    ) {
      throw new PublicApiError(ANALYSIS_ALREADY_ATTACHED_MESSAGE, 409);
    }
    const trialAvailable =
      STRIPE_CHECKOUT_TRIAL_OFFERED &&
      !subscriptionHistory.some(
        (subscription) => subscription.trial_start != null || subscription.trial_end != null,
      );
    const trialDays = trialAvailable ? ANALYSIS_TRIAL_DAYS : 0;
    const offerCode = trialAvailable ? ANALYSIS_OFFER_CODE : ANALYSIS_SUBSCRIPTION_OFFER_CODE;
    const billingModel = trialAvailable
      ? ANALYSIS_BILLING_MODEL
      : ANALYSIS_SUBSCRIPTION_BILLING_MODEL;
    // Premier abonnement (aucun abonnement dans l'historique Stripe du client, même lecture que
    // l'essai) : les achats à l'unité récents sont déduits du premier mois.
    if (subscriptionHistory.length === 0) {
      deductionReserved = true;
      deduction = await prepareUnitPurchaseDeduction(stripe, auth.userId, reservationToken);
    }

    session = await stripe.checkout.sessions.create(
      buildAnalysisCheckoutSessionParams({
        appOrigin,
        customerId,
        userId: auth.userId,
        acceptanceId,
        priceId,
        reservationToken,
        trialDays,
        offerCode,
        billingModel,
        expiresAt: checkoutExpiresAt,
        deduction,
      }),
    );

    if (!session.url) throw new Error("Stripe Checkout session has no URL.");
    await recordCommercialAcceptance({
      acceptanceId,
      auth,
      consent,
      checkoutSessionId: session.id,
      checkoutCreatedAt: new Date(session.created * 1000).toISOString(),
      requestId: requestId ?? null,
      userAgent: userAgent ?? null,
      offer: {
        priceId,
        offerCode,
        billingModel,
        trialDays,
        amountCents: price.unit_amount,
        currency: price.currency,
        recurringInterval: price.recurring?.interval ?? null,
        recurringIntervalCount: price.recurring?.interval_count ?? null,
      },
    });
    return { url: session.url };
  } catch (error) {
    let canReleaseReservation = canReleaseCheckoutReservationAfterFailure(session?.status, false);
    if (session?.status === "open") {
      try {
        await stripe.checkout.sessions.expire(session.id);
        canReleaseReservation = true;
      } catch {
        // Keep the reservation until Stripe emits `checkout.session.expired`.
      }
    }
    if (canReleaseReservation) {
      await releaseAnalyseCheckout(auth.userId, reservationToken).catch(() => undefined);
      // La déduction a pu être réservée sans que son bon soit créé : on la rend dans tous les cas.
      if (deductionReserved) {
        await releaseUnitPurchaseDeduction(reservationToken).catch(() => undefined);
      }
      if (deduction) await stripe.coupons.del(deduction.couponId).catch(() => undefined);
    }
    throw error;
  }
}

/** Déduction des achats à l'unité portée par un checkout d'abonnement : bon Stripe et montant. */
type UnitPurchaseDeduction = { couponId: string; amountCents: number };

/** Métadonnées de la session d'abonnement qui portent la déduction (règlement, libération). */
const UNIT_PURCHASE_DEDUCTION_COUPON_METADATA = "unit_purchase_deduction_coupon";
const UNIT_PURCHASE_DEDUCTION_CENTS_METADATA = "unit_purchase_deduction_cents";

/**
 * Réserve en base la déduction des achats à l'unité pour ce checkout et crée le bon Stripe qui la
 * porte : montant fixe en euros, valable une fois, limité au produit Analyse quand
 * `STRIPE_ANALYSIS_PRODUCT_ID` est posé. `null` : rien à déduire.
 */
async function prepareUnitPurchaseDeduction(
  stripe: Stripe,
  userId: string,
  reservationToken: string,
): Promise<UnitPurchaseDeduction | null> {
  const amountCents = await reserveUnitPurchaseDeduction(userId, reservationToken, new Date());
  if (amountCents <= 0) return null;
  const productId = serverEnv().stripe.analysisProductId;
  const coupon = await stripe.coupons.create(
    {
      amount_off: amountCents,
      currency: ANALYSIS_RECURRING_CURRENCY,
      duration: "once",
      max_redemptions: 1,
      name: "Achats à l’unité déduits du premier mois",
      ...(productId ? { applies_to: { products: [productId] } } : {}),
      metadata: {
        user_id: userId,
        checkout_reservation_token: reservationToken,
        purpose: "unit_purchase_deduction",
      },
    },
    { idempotencyKey: `immojudis-unit-deduction-${reservationToken}` },
  );
  return { couponId: coupon.id, amountCents };
}

/**
 * Checkout d'abonnement expiré, abandonné ou en échec : la déduction réservée est rendue et son bon
 * supprimé chez Stripe (déjà supprimé : rien à faire).
 */
async function releaseUnitPurchaseDeductionOf(
  stripe: Stripe,
  session: Pick<Stripe.Checkout.Session, "metadata">,
): Promise<void> {
  const token = session.metadata?.checkout_reservation_token;
  const couponId = session.metadata?.[UNIT_PURCHASE_DEDUCTION_COUPON_METADATA];
  if (!token || !couponId) return;
  await releaseUnitPurchaseDeduction(token);
  try {
    await stripe.coupons.del(couponId);
  } catch (error) {
    if (!isStripeMissingOrCancelled(error)) throw error;
  }
}

/** A Session younger than this may belong to a request still creating it: never taken over. */
const ABANDONED_CHECKOUT_MIN_AGE_SECONDS = 60;

/**
 * Le client a quitté Stripe Checkout sans payer : la réservation de son compte tient encore
 * jusqu'à 31 minutes (`checkout.session.expired` ne tombe qu'à l'expiration). Plutôt que de lui
 * refuser un nouveau checkout, on expire ses Sessions ouvertes (créées par nous pour ce compte,
 * depuis plus d'une minute) et on libère leur réservation. Ne touche jamais une Session payée :
 * seules les Sessions `open` sont listées, et `expire` échoue sur une Session déjà complétée.
 */
async function reclaimAbandonedCheckout(
  stripe: Stripe,
  auth: SupabaseAuthContext,
): Promise<boolean> {
  const subscription = await getUserSubscription(auth);
  const customerId = subscription?.stripe_customer_id;
  if (!customerId) return false;
  const sessions = await stripe.checkout.sessions.list({
    customer: customerId,
    status: "open",
    limit: 10,
  });
  const cutoff = Math.floor(Date.now() / 1000) - ABANDONED_CHECKOUT_MIN_AGE_SECONDS;
  let reclaimed = false;
  for (const session of sessions.data) {
    const token = session.metadata?.checkout_reservation_token;
    if (!token || session.metadata?.user_id !== auth.userId || session.created > cutoff) continue;
    try {
      await stripe.checkout.sessions.expire(session.id);
    } catch {
      continue;
    }
    await releaseAnalyseCheckout(auth.userId, token).catch(() => undefined);
    // Sans cela, la déduction resterait réservée par l'ancien checkout jusqu'à son webhook
    // d'expiration, et le nouveau checkout n'en porterait aucune.
    await releaseUnitPurchaseDeductionOf(stripe, session).catch(() => undefined);
    reclaimed = true;
  }
  return reclaimed;
}

export function canReleaseCheckoutReservationAfterFailure(
  status: Stripe.Checkout.Session.Status | null | undefined,
  expirationSucceeded: boolean,
): boolean {
  if (status == null || status === "expired") return true;
  return status === "open" && expirationSucceeded;
}

export async function resolveAnalysisCheckoutAvailability(
  auth: SupabaseAuthContext,
): Promise<{ trialAvailable: boolean }> {
  if (!STRIPE_CHECKOUT_TRIAL_OFFERED) return { trialAvailable: false };
  const subscription = await getUserSubscription(auth);
  if (!subscription?.stripe_customer_id) return { trialAvailable: true };
  const history = await listCustomerSubscriptions(getStripe(), subscription.stripe_customer_id);
  return {
    trialAvailable: !history.some((item) => item.trial_start != null || item.trial_end != null),
  };
}

async function listCustomerSubscriptions(
  stripe: Stripe,
  customerId: string,
): Promise<Stripe.Subscription[]> {
  const data: Stripe.Subscription[] = [];
  let startingAfter: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const page = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    data.push(...page.data);
    hasMore = page.has_more;
    startingAfter = page.data.at(-1)?.id;
    if (!startingAfter) hasMore = false;
  }

  return data;
}

export function buildAnalysisCheckoutSessionParams({
  appOrigin,
  customerId,
  userId,
  acceptanceId,
  priceId,
  reservationToken,
  trialDays = ANALYSIS_TRIAL_DAYS,
  offerCode = ANALYSIS_OFFER_CODE,
  billingModel = ANALYSIS_BILLING_MODEL,
  expiresAt,
  deduction = null,
}: {
  appOrigin: string;
  customerId: string;
  userId: string;
  acceptanceId?: string;
  priceId?: string;
  reservationToken?: string;
  trialDays?: number;
  offerCode?: string;
  billingModel?: string;
  expiresAt?: number;
  /** Achats à l'unité déduits du premier mois : seule remise de la session (ni code promo ni autre bon). */
  deduction?: UnitPurchaseDeduction | null;
}): Stripe.Checkout.SessionCreateParams {
  const recurringPriceId = priceId ?? resolveAnalysisPriceId();
  const offerLabel = resolveAnalysisOfferLabel();
  return {
    mode: "subscription",
    customer: customerId,
    client_reference_id: userId,
    line_items: [
      {
        price: recurringPriceId,
        quantity: 1,
      },
    ],
    payment_method_collection: "always",
    // Professionals need an invoice in their company's name: collect the
    // billing address and an optional VAT number, and keep them on the customer.
    billing_address_collection: "required",
    tax_id_collection: { enabled: true },
    customer_update: { name: "auto", address: "auto" },
    subscription_data: {
      ...(trialDays > 0 ? { trial_period_days: trialDays } : {}),
      metadata: {
        user_id: userId,
        plan_code: "analyse",
        billing_model: billingModel,
        trial_days: String(trialDays),
        offer_code: offerCode,
        offer_label: offerLabel,
        ...(reservationToken ? { checkout_reservation_token: reservationToken } : {}),
        ...(acceptanceId ? { commercial_acceptance_id: acceptanceId } : {}),
      },
    },
    locale: "fr",
    success_url: `${appOrigin}/offres?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appOrigin}/offres?checkout=cancelled`,
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    ...(deduction ? { discounts: [{ coupon: deduction.couponId }] } : {}),
    metadata: {
      user_id: userId,
      plan_code: "analyse",
      billing_model: billingModel,
      trial_days: String(trialDays),
      offer_code: offerCode,
      offer_label: offerLabel,
      ...(reservationToken ? { checkout_reservation_token: reservationToken } : {}),
      ...(acceptanceId ? { commercial_acceptance_id: acceptanceId } : {}),
      ...(deduction
        ? {
            [UNIT_PURCHASE_DEDUCTION_COUPON_METADATA]: deduction.couponId,
            [UNIT_PURCHASE_DEDUCTION_CENTS_METADATA]: String(deduction.amountCents),
          }
        : {}),
    },
  };
}

async function resolveConfiguredAnalysisPrice(
  stripe: Stripe,
  priceId: string,
): Promise<Stripe.Price> {
  const price = await stripe.prices.retrieve(priceId);
  if (
    !price.active ||
    price.type !== "recurring" ||
    price.currency !== ANALYSIS_RECURRING_CURRENCY ||
    !price.recurring ||
    price.unit_amount !== ANALYSIS_RECURRING_PRICE_CENTS ||
    price.recurring.interval !== ANALYSIS_RECURRING_INTERVAL ||
    price.recurring.interval_count !== ANALYSIS_RECURRING_INTERVAL_COUNT
  ) {
    throw new ConfigurationError(
      "Le Price Stripe Analyse doit être actif et récurrent à 59 € / mois en EUR.",
    );
  }
  // TVA (n° 45) : le tarif de 59 € est le prix final payé. Un Price « exclusive » ou sans comportement
  // fiscal (« unspecified ») pourrait faire ajouter une taxe au-dessus de 59 €, en contradiction avec
  // le prix annoncé : le checkout est refusé tant que le Price n'est pas « inclusive ».
  // DÉCISION DU 09/11/2026 : franchise en base de TVA (art. 293 B du CGI). Aucun taux n'est appliqué
  // (ni Stripe Tax ni `default_tax_rates`) ; chaque facture porte `VAT_EXEMPTION_INVOICE_MENTION`
  // (pied de facture du client Stripe, voir `ensureStripeCustomer`). En cas de sortie de la franchise,
  // brancher un taux ici et retirer la mention.
  if (price.tax_behavior !== "inclusive") {
    throw new ConfigurationError(
      "Le Price Stripe Analyse doit avoir un comportement fiscal « inclusive » (prix de 59 € TTC).",
    );
  }
  return price;
}

async function reserveAnalyseCheckout(userId: string, checkoutToken: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("reserve_analyse_checkout", {
    p_checkout_token: checkoutToken,
    p_user_id: userId,
  });
  if (error) throw new Error(error.message || "Analyse checkout reservation failed.");
  return data === true;
}

async function releaseAnalyseCheckout(userId: string, checkoutToken: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc("release_analyse_checkout", {
    p_checkout_token: checkoutToken,
    p_user_id: userId,
  });
  if (error) throw new Error(error.message || "Analyse checkout release failed.");
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
 * URL d'une session d'achat encore ouverte, à réutiliser ; `null` si elle a expiré. Payée, elle lève
 * le refus `already_unlocked` : le webhook accorde la vente (ou l'a fait), rien n'est à repayer.
 */
async function reusableSaleUnlockSessionUrl(
  stripe: Stripe,
  sessionId: string,
): Promise<string | null> {
  const existing = await stripe.checkout.sessions.retrieve(sessionId);
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
 * Ce qui serait déduit du premier mois d'abonnement pour ce compte s'il souscrivait maintenant
 * (lecture seule, pour `/api/billing/offer`). Un compte qui a déjà eu un abonnement Stripe n'a pas de
 * premier mois : 0. Le checkout refait le calcul en base et lit l'historique chez Stripe.
 */
export async function previewFirstMonthDeductionCents(auth: SupabaseAuthContext): Promise<number> {
  const subscription = await getUserSubscription(auth);
  if (subscription?.stripe_subscription_id) return 0;
  return previewUnitPurchaseDeductionCents(auth.userId);
}

export function billingPortalReturnUrl(appOrigin: string): string {
  return `${appOrigin}/offres?billing=portal`;
}

/** Where Stripe sends the subscriber back once the cancellation flow is completed. */
export function billingPortalCancelReturnUrl(appOrigin: string): string {
  return `${appOrigin}/compte`;
}

/** Subscription statuses for which the cancellation flow of the portal is offered. */
const CANCELLABLE_SUBSCRIPTION_STATUSES: readonly string[] = ["trialing", "active", "past_due"];

export function buildBillingPortalSessionParams({
  appOrigin,
  customerId,
  cancelSubscriptionId,
}: {
  appOrigin: string;
  customerId: string;
  /** Stripe id read from the signed-in user's own row, never from the request. */
  cancelSubscriptionId?: string | null;
}): Stripe.BillingPortal.SessionCreateParams {
  return {
    customer: customerId,
    return_url: billingPortalReturnUrl(appOrigin),
    locale: "fr",
    ...(cancelSubscriptionId
      ? {
          flow_data: {
            type: "subscription_cancel",
            subscription_cancel: { subscription: cancelSubscriptionId },
            after_completion: {
              type: "redirect",
              redirect: { return_url: billingPortalCancelReturnUrl(appOrigin) },
            },
          },
        }
      : {}),
  };
}

export async function createBillingPortalSession({
  auth,
  origin,
  intent = "manage",
}: {
  auth: SupabaseAuthContext;
  origin?: string | null;
  intent?: BillingPortalIntent;
}): Promise<BillingSessionResponse> {
  const stripe = getStripe();
  const appOrigin = resolveBillingOrigin(origin);
  const subscription = await getUserSubscription(auth);

  if (!subscription?.stripe_customer_id) {
    throw new PublicApiError("Aucun compte Stripe n'est encore associé à ce compte.", 409);
  }

  let cancelSubscriptionId: string | null = null;
  if (intent === "cancel") {
    cancelSubscriptionId = subscription.stripe_subscription_id;
    if (!cancelSubscriptionId || !CANCELLABLE_SUBSCRIPTION_STATUSES.includes(subscription.status)) {
      throw new PublicApiError(
        "Aucun abonnement Analyse à résilier n'est associé à ce compte.",
        409,
      );
    }
  }

  const session = await stripe.billingPortal.sessions.create(
    buildBillingPortalSessionParams({
      appOrigin,
      customerId: subscription.stripe_customer_id,
      cancelSubscriptionId,
    }),
  );

  return { url: session.url };
}

export async function handleStripeWebhook({
  payload,
  signature,
}: {
  payload: string;
  signature: string | null;
}): Promise<StripeWebhookResult> {
  if (!signature) throw new Error("Stripe webhook signature is missing.");

  const stripe = getStripe();
  const event = stripe.webhooks.constructEvent(payload, signature, stripeWebhookSecret());
  if (stripeEventModeMismatch(event.livemode, stripeSecretKey())) {
    throw new PublicApiError(
      "Mode de l’événement Stripe différent de celui de la clé secrète : événement refusé.",
      400,
    );
  }
  const isNewEvent = await beginStripeWebhookEvent(event);
  if (!isNewEvent) {
    // Un événement encore « processing » n'est pas un doublon traité : le premier passage a pu
    // être interrompu. Répondre 200 ferait abandonner l'événement par Stripe ; on répond une erreur
    // réessayable, et la base reprend l'événement bloqué au-delà de 15 minutes.
    if ((await readStripeWebhookEventStatus(event.id)) === "processing") {
      throw new PublicApiError("Événement en cours de traitement : réessayez plus tard.", 503);
    }
    return { eventId: event.id, type: event.type, handled: true, duplicate: true };
  }

  try {
    let handled = false;
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        handled = await handleCheckoutCompleted(
          event.data.object as Stripe.Checkout.Session,
          event,
        );
        break;
      case "checkout.session.expired":
        handled = await handleCheckoutExpired(event.data.object as Stripe.Checkout.Session);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
        handled = await syncStripeSubscription(
          event.data.object as Stripe.Subscription,
          null,
          event.created,
          {
            eventType: event.type,
            previousAttributes: (
              event.data as { previous_attributes?: Partial<Stripe.Subscription> }
            ).previous_attributes,
          },
        );
        break;
      case "customer.subscription.trial_will_end":
        handled = await handleTrialWillEnd(event.data.object as Stripe.Subscription);
        break;
      case "invoice.payment_failed":
        handled = await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
        break;
      case "invoice.payment_action_required":
        handled = await handleInvoicePaymentActionRequired(event.data.object as Stripe.Invoice);
        break;
      case "charge.refunded":
        handled = await handleChargeRefunded(event.data.object as Stripe.Charge, event);
        break;
      case "charge.dispute.created":
      case "charge.dispute.closed":
        handled = await handleChargeDispute(event.data.object as Stripe.Dispute, event);
        break;
      default:
        handled = false;
    }
    await completeStripeWebhookEvent(event.id, handled ? "processed" : "ignored", null);
    return { eventId: event.id, type: event.type, handled };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await completeStripeWebhookEvent(event.id, "failed", message).catch(() => undefined);
    throw error;
  }
}

/**
 * C3 (14/11) : un événement dont le mode (`livemode`) n'est pas celui de la clé secrète est refusé
 * (400), avant d'être journalisé ou traité. Un point de terminaison de test branché sur une clé
 * réelle (ou l'inverse) n'ouvre ni ne retire aucun accès ; Stripe rejoue l'événement refusé, ce qui
 * rend l'erreur de configuration visible dans son tableau de bord. Clé d'une forme inconnue : rien à
 * comparer.
 */
function stripeEventModeMismatch(livemode: boolean, secretKey: string): boolean {
  const keyMode = stripeKeyMode(secretKey);
  return keyMode !== null && (keyMode === "live") !== livemode;
}

export function stripeRefundRequiresAccessRevocation(
  amount: number | null | undefined,
  amountRefunded: number | null | undefined,
): boolean {
  return Boolean(amount && amount > 0 && amountRefunded != null && amountRefunded >= amount);
}

/**
 * Un litige clos en faveur du commerçant, ou qui n'a jamais abouti : `won`, mais aussi
 * `warning_closed` (demande d'information close sans contestation) et `prevented` (litige évité).
 * L'accès est rendu ; `lost` l'enlève, tout autre statut (ouvert, en examen) le suspend.
 */
export function stripeDisputeIsCleared(status: Stripe.Dispute.Status | string): boolean {
  return status === "won" || status === "warning_closed" || status === "prevented";
}

/**
 * Statut d'accès d'une ligne SANS abonnement Stripe (ancien paiement unique) : seule la date de fin
 * en base peut dire si l'accès rendu court encore. Une ligne qui porte un abonnement Stripe ne passe
 * pas par ici : à la clôture du litige, l'abonnement est relu chez Stripe et synchronisé
 * (`syncStripeSubscription`), au lieu de déduire « active » d'une date.
 */
export function stripeDisputeStatusToPlanStatus(
  status: Stripe.Dispute.Status | string,
  currentPeriodEnd: string | null,
  now = new Date(),
): StripeReconciledPlanStatus {
  if (stripeDisputeIsCleared(status)) {
    return currentPeriodEnd && Date.parse(currentPeriodEnd) > now.getTime() ? "active" : "expired";
  }
  if (status === "lost") return "cancelled";
  return "paused";
}

export function stripeDisputeStatusToPaymentState(
  status: Stripe.Dispute.Status | string,
): Exclude<StripePaymentLifecycleState, "refunded"> {
  if (stripeDisputeIsCleared(status)) return "cleared";
  if (status === "lost") return "dispute_lost";
  return "disputed";
}

export function stripeSubscriptionStatusToPlanStatus(
  status: Stripe.Subscription.Status | string,
): PlanStatus {
  switch (status) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
      return "past_due";
    // `incomplete` (first payment not confirmed) and `unpaid` (retries exhausted)
    // never grant access. They map to `paused`: no access, but the customer
    // still has a live Stripe subscription to repair from the billing portal.
    case "incomplete":
    case "unpaid":
    case "paused":
      return "paused";
    case "canceled":
      return "cancelled";
    case "incomplete_expired":
      return "expired";
    default:
      return "expired";
  }
}

export function stripeCurrentPeriodEndIso(
  subscription: Pick<Stripe.Subscription, "ended_at" | "items" | "trial_end">,
): string | null {
  const periodEnd =
    subscription.items.data[0]?.current_period_end ??
    subscription.trial_end ??
    subscription.ended_at ??
    null;
  return periodEnd ? new Date(periodEnd * 1000).toISOString() : null;
}

/**
 * Value stored as `current_period_end`, which the database turns into the end
 * of access. For `past_due` Stripe has already moved the period forward to the
 * unpaid renewal; keeping that end would grant a whole free month plus the
 * grace. The grace therefore counts from the start of the unpaid period, that
 * is from the first failed payment, and stays fixed across the retries.
 */
export function stripeAccessPeriodEndIso(
  subscription: Pick<Stripe.Subscription, "ended_at" | "items" | "trial_end">,
  planStatus: PlanStatus,
): string | null {
  if (planStatus === "past_due") {
    const periodStart = subscription.items.data[0]?.current_period_start;
    if (periodStart) return new Date(periodStart * 1000).toISOString();
  }
  return stripeCurrentPeriodEndIso(subscription);
}

// Défini avec les autres constantes de l'offre : la confirmation de l'achat à l'unité le cite aussi.
export { VAT_EXEMPTION_INVOICE_MENTION };

export function stripeCustomerIdempotencyKey(userId: string): string {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) throw new Error("Stripe customer: user id is missing.");
  return `immojudis-customer-${normalizedUserId}`;
}

/**
 * Crée le client Stripe du compte. Mêmes paramètres et même clé d'idempotence pour l'abonnement et
 * l'achat à l'unité : deux créations dans les 24 heures de la clé rendent le même client, et des
 * paramètres différents feraient refuser la seconde par Stripe.
 */
function createStripeCustomer(stripe: Stripe, auth: SupabaseAuthContext): Promise<Stripe.Customer> {
  return stripe.customers.create(
    {
      email: typeof auth.claims.email === "string" ? auth.claims.email : undefined,
      // Franchise en base de TVA : mention obligatoire sur chaque facture émise par Stripe.
      invoice_settings: { footer: VAT_EXEMPTION_INVOICE_MENTION },
      metadata: {
        user_id: auth.userId,
        source: "immojudis",
      },
    },
    {
      idempotencyKey: stripeCustomerIdempotencyKey(auth.userId),
    },
  );
}

async function ensureStripeCustomer(
  auth: SupabaseAuthContext,
  reservationToken: string,
): Promise<string> {
  const subscription = await getUserSubscription(auth);
  if (subscription?.stripe_customer_id) return subscription.stripe_customer_id;

  const customer = await createStripeCustomer(getStripe(), auth);
  const { data, error } = await supabaseAdmin.rpc("attach_analyse_checkout_customer", {
    p_checkout_token: reservationToken,
    p_stripe_customer_id: customer.id,
    p_user_id: auth.userId,
  });
  if (error) {
    throw new Error(error.message || "Stripe customer attachment failed.");
  }
  if (!data) throw new Error("Stripe customer attachment returned no row.");
  return data;
}

async function getUserSubscription(auth: SupabaseAuthContext): Promise<UserSubscriptionRow | null> {
  const { data, error } = await auth.supabase
    .from("user_subscriptions")
    .select("*")
    .eq("user_id", auth.userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
  event: Stripe.Event,
): Promise<boolean> {
  const userId = session.metadata?.user_id || session.client_reference_id;
  if (!userId) return false;

  if (session.metadata?.purpose === SALE_UNLOCK_PAYMENT_PURPOSE) {
    return handleSaleUnlockCheckoutCompleted(session, event);
  }

  if (session.mode === "payment") {
    if (session.payment_status !== "paid") return false;
    if (normalizePlanCode(session.metadata?.plan_code) !== "analyse") return false;
    if (
      session.amount_total !== ANALYSIS_RECURRING_PRICE_CENTS ||
      session.currency !== ANALYSIS_RECURRING_CURRENCY
    ) {
      return false;
    }
    if (session.metadata?.access_duration_days !== String(ANALYSIS_ACCESS_DAYS)) return false;
    const paymentIntentId = stripeObjectId(session.payment_intent);
    if (!paymentIntentId) return false;
    const { data, error } = await supabaseAdmin.rpc("grant_analysis_access_from_payment", {
      p_amount_total: session.amount_total,
      p_checkout_session_id: session.id,
      p_currency: session.currency,
      p_duration_days: ANALYSIS_ACCESS_DAYS,
      p_event_created: event.created,
      p_event_id: event.id,
      p_paid_at: new Date(event.created * 1000).toISOString(),
      p_payment_intent_id: paymentIntentId,
      p_stripe_customer_id: nullableRpcArg(stripeObjectId(session.customer)),
      p_user_id: userId,
    });

    if (error) throw error;
    const granted = Boolean(data?.[0]?.granted);
    const acceptanceId = session.metadata?.commercial_acceptance_id;
    if (granted && acceptanceId) {
      await sendCommercialConfirmation({
        acceptanceId,
        checkoutSessionId: session.id,
        userId,
        paidAt: new Date(event.created * 1000).toISOString(),
      }).catch((confirmationError) => {
        console.error("[billing] durable confirmation failed", confirmationError);
      });
    }
    return granted;
  }

  if (session.mode !== "subscription") return false;

  // Le bon de réduction des achats à l'unité a servi : la déduction réservée est acquise. Une erreur
  // de la base fait rejouer l'événement (la synchronisation qui suit est idempotente).
  const deductionToken = session.metadata?.checkout_reservation_token;
  if (deductionToken && session.metadata?.[UNIT_PURCHASE_DEDUCTION_COUPON_METADATA]) {
    await settleUnitPurchaseDeduction(deductionToken, session.id);
  }

  const subscriptionValue = session.subscription;
  const subscription =
    typeof subscriptionValue === "string"
      ? await getStripe().subscriptions.retrieve(subscriptionValue)
      : subscriptionValue;

  if (subscription?.object === "subscription") {
    const synced = await syncStripeSubscription(subscription, userId, event.created);
    if (synced) await releaseCheckoutReservation(session);
    const acceptanceId = session.metadata?.commercial_acceptance_id;
    if (synced && acceptanceId) {
      await sendCommercialConfirmation({
        acceptanceId,
        checkoutSessionId: session.id,
        userId,
        paidAt: new Date(event.created * 1000).toISOString(),
      }).catch((confirmationError) => {
        console.error("[billing] durable confirmation failed", confirmationError);
      });
    }
    return synced;
  }

  // Session d'abonnement sans objet abonnement lisible (n° 47) : on n'écrit jamais « active » sur la
  // seule foi de la session, sans les gardes de `syncStripeSubscription` (Price de l'offre, fin de
  // période, litige ouvert, ordre des événements). L'accès vient des événements `customer.subscription.*`
  // et du rapprochement ; la session reste « ignorée » dans le journal.
  return false;
}

/**
 * Session d'achat d'une vente à l'unité payée. Le déblocage n'est accordé qu'ici, jamais au retour
 * du navigateur : paiement encaissé, 19 € en EUR, puis la base accorde la vente (ou un crédit si elle
 * n'est plus débloquable) une seule fois par achat, quel que soit le nombre d'événements.
 */
async function handleSaleUnlockCheckoutCompleted(
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

async function handleCheckoutExpired(session: Stripe.Checkout.Session): Promise<boolean> {
  if (session.metadata?.purpose === SALE_UNLOCK_PAYMENT_PURPOSE) {
    return expireSaleUnlockPurchase(session.id);
  }
  const userId = session.metadata?.user_id || session.client_reference_id;
  const reservationToken = session.metadata?.checkout_reservation_token;
  if (!userId || !reservationToken) return false;
  await releaseAnalyseCheckout(userId, reservationToken);
  await releaseUnitPurchaseDeductionOf(getStripe(), session);
  return true;
}

async function releaseCheckoutReservation(session: Stripe.Checkout.Session): Promise<void> {
  const userId = session.metadata?.user_id || session.client_reference_id;
  const reservationToken = session.metadata?.checkout_reservation_token;
  if (!userId || !reservationToken) return;
  await releaseAnalyseCheckout(userId, reservationToken).catch((error) => {
    console.error("[billing] checkout reservation release failed", error);
  });
}

async function beginStripeWebhookEvent(event: Stripe.Event): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("begin_stripe_webhook_event", {
    p_event_id: event.id,
    p_event_type: event.type,
    p_livemode: event.livemode,
  });
  if (error) throw new Error(error.message || "Stripe webhook journal read failed.");
  return data === true;
}

async function readStripeWebhookEventStatus(eventId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("stripe_webhook_events")
    .select("processing_status")
    .eq("event_id", eventId)
    .maybeSingle();
  if (error) throw new Error(error.message || "Stripe webhook journal read failed.");
  return data?.processing_status ?? null;
}

async function completeStripeWebhookEvent(
  eventId: string,
  status: "processed" | "ignored" | "failed",
  errorMessage: string | null,
): Promise<void> {
  const { error } = await supabaseAdmin.rpc("complete_stripe_webhook_event", {
    p_error_message: nullableRpcArg(errorMessage),
    p_event_id: eventId,
    p_processing_status: status,
  });
  if (error) throw new Error(error.message || "Stripe webhook journal update failed.");
}

/** Valeur de `metadata.purpose` des paiements d'achat d'une vente à l'unité (session et PaymentIntent). */
export const SALE_UNLOCK_PAYMENT_PURPOSE = "sale_unlock";

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
async function recordSaleUnlockChargeState(
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

async function handleChargeRefunded(charge: Stripe.Charge, event: Stripe.Event): Promise<boolean> {
  if (!stripeRefundRequiresAccessRevocation(charge.amount, charge.amount_refunded)) return false;
  // Aiguillage d'abord : un paiement unitaire ne touche jamais l'abonnement, et inversement.
  if ((await stripePaymentPurpose(charge)) === SALE_UNLOCK_PAYMENT_PURPOSE) {
    return recordSaleUnlockChargeState(charge, "refunded", event);
  }
  const userId = await stripeUserIdFromPaymentObject(charge);
  const paymentIntentId = stripeObjectId(charge.payment_intent);
  if (!userId || !paymentIntentId) return false;
  const recorded = await recordStripePaymentState({
    userId,
    paymentIntentId,
    state: "refunded",
    status: "cancelled",
    event,
    revokeImmediately: true,
  });
  // A refunded customer must not be charged again at the next renewal, and the
  // subscription events that follow must report a cancelled state.
  if (recorded) await cancelStripeSubscriptionForUser(userId);
  return recorded;
}

async function handleChargeDispute(dispute: Stripe.Dispute, event: Stripe.Event): Promise<boolean> {
  const charge =
    typeof dispute.charge === "string"
      ? await getStripe().charges.retrieve(dispute.charge)
      : dispute.charge;
  if ((await stripePaymentPurpose(charge)) === SALE_UNLOCK_PAYMENT_PURPOSE) {
    const state = stripeDisputeStatusToPaymentState(dispute.status);
    return recordSaleUnlockChargeState(charge, state === "cleared" ? "paid" : state, event);
  }
  const userId = await stripeUserIdFromPaymentObject(charge);
  const paymentIntentId = stripeObjectId(charge.payment_intent);
  if (!userId || !paymentIntentId) return false;

  const { data, error } = await supabaseAdmin
    .from("user_subscriptions")
    .select("current_period_end,stripe_subscription_id,stripe_event_created")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  // Litige clos en faveur du compte (n° 46) et abonnement Stripe connu : l'état d'accès vient de
  // l'abonnement relu chez Stripe, pas d'une date en base. Entre l'enregistrement du litige et la
  // relecture, l'accès reste suspendu (échec fermé : si Stripe ne répond pas, le webhook est rejoué).
  const subscriptionId = stripeDisputeIsCleared(dispute.status)
    ? (data?.stripe_subscription_id ?? null)
    : null;
  const status: StripeReconciledPlanStatus = subscriptionId
    ? "paused"
    : stripeDisputeStatusToPlanStatus(dispute.status, data?.current_period_end ?? null);
  const recorded = await recordStripePaymentState({
    userId,
    paymentIntentId,
    state: stripeDisputeStatusToPaymentState(dispute.status),
    status,
    event,
    revokeImmediately: status === "cancelled",
  });
  if (recorded && status === "cancelled") await cancelStripeSubscriptionForUser(userId);
  if (recorded && subscriptionId) {
    let current: Stripe.Subscription | null = null;
    try {
      current = await getStripe().subscriptions.retrieve(subscriptionId);
    } catch (retrieveError) {
      if (!isStripeMissingOrCancelled(retrieveError)) throw retrieveError;
    }
    if (!current) {
      // Abonnement introuvable chez Stripe (404) : rien à relire. On ne laisse pas « paused » à vie ;
      // on applique la règle des lignes sans abonnement (date de fin en base). Même événement, donc
      // l'enregistrement est rejoué sans effet de bord sur l'état du paiement.
      await recordStripePaymentState({
        userId,
        paymentIntentId,
        state: stripeDisputeStatusToPaymentState(dispute.status),
        status: stripeDisputeStatusToPlanStatus(dispute.status, data?.current_period_end ?? null),
        event,
        revokeImmediately: false,
      });
    }
    if (current) {
      // Le litige n'est plus « ouvert » (état « cleared » enregistré ci-dessus). La relecture vient
      // d'être faite : on la date du plus récent de l'événement et du dernier état appliqué, pour
      // qu'un événement d'abonnement livré dans le désordre ne la fasse pas écarter comme périmée.
      await syncStripeSubscription(
        current,
        userId,
        Math.max(event.created, data?.stripe_event_created ?? 0),
      );
    }
  }
  return recorded;
}

/** Stripe sends this three days before a trial ends. */
async function handleTrialWillEnd(subscription: Stripe.Subscription): Promise<boolean> {
  const userId = await findUserIdForSubscription(subscription);
  if (!userId || !subscription.trial_end) return false;
  await sendTrialEndingNotice({
    userId,
    subscriptionId: subscription.id,
    trialEnd: subscription.trial_end,
  });
  return true;
}

/**
 * One free trial per payment card.  When the card behind a trial already
 * started a trial for another account, the trial ends now and the first
 * payment is taken immediately.
 */
export async function enforceSingleTrialPerCard(
  subscription: Stripe.Subscription,
  userId: string,
): Promise<"claimed" | "reused" | "unknown"> {
  if (subscription.status !== "trialing") return "unknown";
  const stripe = getStripe();
  let paymentMethodId = stripeObjectId(subscription.default_payment_method);
  if (!paymentMethodId) {
    const customerId = stripeObjectId(subscription.customer);
    if (customerId) {
      const customer = await stripe.customers.retrieve(customerId);
      if (!("deleted" in customer && customer.deleted)) {
        paymentMethodId = stripeObjectId(
          (customer as Stripe.Customer).invoice_settings?.default_payment_method,
        );
      }
    }
  }
  if (!paymentMethodId) return "unknown";
  const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
  const fingerprint = paymentMethod.card?.fingerprint;
  if (!fingerprint) return "unknown";
  const { data, error } = await supabaseAdmin.rpc("claim_trial_card", {
    p_fingerprint_hash: createHash("sha256").update(fingerprint).digest("hex"),
    p_user_id: userId,
  });
  if (error) throw new Error(error.message || "Card trial check failed.");
  if (data === true) return "claimed";

  await stripe.subscriptions.update(subscription.id, { trial_end: "now" });
  console.warn("[billing] trial ended early: card already used for another trial", {
    subscription: subscription.id,
  });
  return "reused";
}

async function userIdForInvoiceCustomer(invoice: Stripe.Invoice): Promise<string | null> {
  const customerId = stripeObjectId(invoice.customer);
  if (!customerId) return null;
  const { data, error } = await supabaseAdmin
    .from("user_subscriptions")
    .select("user_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  if (error) throw error;
  return data?.user_id ?? null;
}

/**
 * 3-D Secure au renouvellement (C10) : la banque retient le prélèvement jusqu'à la confirmation du
 * client. La première facture passe par Checkout, qui gère lui-même la confirmation : seules les
 * factures de renouvellement déclenchent l'email.
 */
async function handleInvoicePaymentActionRequired(invoice: Stripe.Invoice): Promise<boolean> {
  if (!invoice.id || invoice.billing_reason === "subscription_create") return false;
  const userId = await userIdForInvoiceCustomer(invoice);
  if (!userId) return false;
  await sendPaymentActionRequiredNotice({
    userId,
    invoiceId: invoice.id,
    hostedInvoiceUrl: invoice.hosted_invoice_url,
  });
  return true;
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<boolean> {
  if (!invoice.id) return false;
  const userId = await userIdForInvoiceCustomer(invoice);
  if (!userId) return false;
  await sendPaymentFailedNotice({
    userId,
    invoiceId: invoice.id,
    nextAttemptAt: invoice.next_payment_attempt,
  });
  return true;
}

function isStripeMissingOrCancelled(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    code === "resource_missing" ||
    (typeof message === "string" &&
      /already.*cancel|cancel.*subscription|no such subscription/i.test(message))
  );
}

async function cancelStripeSubscriptionForUser(userId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("user_subscriptions")
    .select("stripe_subscription_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  const subscriptionId = data?.stripe_subscription_id;
  if (!subscriptionId) return;
  try {
    await getStripe().subscriptions.cancel(subscriptionId);
  } catch (cancelError) {
    if (!isStripeMissingOrCancelled(cancelError)) throw cancelError;
  }
}

async function stripeUserIdFromPaymentObject(charge: Stripe.Charge): Promise<string | null> {
  if (charge.metadata?.user_id) return charge.metadata.user_id;
  const paymentIntentValue = charge.payment_intent;
  if (paymentIntentValue) {
    const paymentIntent =
      typeof paymentIntentValue === "string"
        ? await getStripe().paymentIntents.retrieve(paymentIntentValue)
        : paymentIntentValue;
    if (paymentIntent.metadata?.user_id) return paymentIntent.metadata.user_id;
  }
  // Subscription invoices carry no ImmoJudis metadata: the Stripe customer is
  // the reliable link to the account.
  const customerId = stripeObjectId(charge.customer);
  if (!customerId) return null;
  const { data, error } = await supabaseAdmin
    .from("user_subscriptions")
    .select("user_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  if (error) throw error;
  return data?.user_id ?? null;
}

async function recordStripePaymentState({
  userId,
  paymentIntentId,
  state,
  status,
  event,
  revokeImmediately,
}: {
  userId: string;
  paymentIntentId: string;
  state: StripePaymentLifecycleState;
  status: StripeReconciledPlanStatus;
  event: Stripe.Event;
  revokeImmediately: boolean;
}): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("record_stripe_payment_state", {
    p_entitlement_status: status,
    p_event_created: event.created,
    p_event_id: event.id,
    p_event_type: event.type,
    p_payment_intent_id: paymentIntentId,
    p_revoke_immediately: revokeImmediately,
    p_state: state,
    p_user_id: userId,
  });
  if (error) throw new Error(error.message || "Stripe payment reconciliation failed.");
  return data?.[0]?.recorded === true;
}

async function retrieveCurrentSubscription(
  subscription: Stripe.Subscription,
): Promise<Stripe.Subscription> {
  try {
    return await getStripe().subscriptions.retrieve(subscription.id);
  } catch (error) {
    if (isStripeMissingOrCancelled(error)) return subscription;
    throw error;
  }
}

/**
 * Every Price of the Analyse offer: the one used by new checkouts (`analysisPriceId`, absent when
 * `STRIPE_ANALYSIS_PRICE_ID` is malformed) and the former ones still billed to existing subscribers
 * (`STRIPE_ANALYSIS_LEGACY_PRICE_IDS`, comma separated). Changing the Price of the offer therefore
 * does not cut the access of subscribers who stay on the previous one.
 */
export function analysisSubscriptionPriceIds(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): string[] {
  const { legacyAnalysisPriceIds } = serverEnv(env).stripe;
  return [analysisPriceId(env), ...(legacyAnalysisPriceIds ?? "").split(",")]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
}

/**
 * True when the price belongs to the Analyse offer. Fermé par défaut (n° 47) : sans Price configuré,
 * ou pour un abonnement dont le Price est absent, rien n'est reconnu et aucun accès n'est ouvert.
 */
export function isAnalysisSubscriptionPrice(
  priceId: string | null | undefined,
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): boolean {
  return Boolean(priceId) && analysisSubscriptionPriceIds(env).includes(priceId as string);
}

/**
 * Le Price d'un abonnement ouvre-t-il l'offre Analyse ? Il doit figurer dans la configuration, et le
 * Price COURANT (celui que vend le checkout, `analysisPriceId`) doit valoir 59 € (5 900 centimes) :
 * un Price courant mal créé n'ouvre pas l'accès. Les anciens Price
 * (`STRIPE_ANALYSIS_LEGACY_PRICE_IDS`) restent acceptés quel que soit leur montant : l'exploitant
 * les a déclarés pour des abonnés qui paient encore un ancien tarif.
 */
export function isRecognisedAnalysisPrice(
  price: { id?: string | null; unit_amount?: number | null } | null | undefined,
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): boolean {
  if (!price || !isAnalysisSubscriptionPrice(price.id, env)) return false;
  if (price.id === analysisPriceId(env)) {
    return price.unit_amount === ANALYSIS_RECURRING_PRICE_CENTS;
  }
  return true;
}

async function userHasOpenPaymentDispute(userId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("stripe_payment_lifecycle")
    .select("payment_intent_id")
    .eq("user_id", userId)
    .eq("state", "disputed")
    .limit(1);
  if (error) throw new Error(error.message || "Stripe dispute read failed.");
  return (data?.length ?? 0) > 0;
}

/** `apply_stripe_subscription_state` refusal for an old subscription id that no longer matters. */
const SUPERSEDED_SUBSCRIPTION_REASON = "superseded_subscription";

/**
 * Store the state Stripe holds now, not the one in the (possibly late or
 * replayed) payload. The database applies it only if it is not older than the
 * newest applied event, not a reactivation of a refunded subscription, and not
 * the inactive state of an old subscription replaced by one that grants access.
 * The id read back from Stripe is the one sent to the database, which compares
 * it with the stored subscription under the user lock.
 */
async function syncStripeSubscription(
  subscription: Stripe.Subscription,
  fallbackUserId: string | null | undefined,
  eventCreated: number,
  cancellationContext?: {
    eventType: string;
    previousAttributes?: Partial<Stripe.Subscription>;
  },
): Promise<boolean> {
  const userId = fallbackUserId || (await findUserIdForSubscription(subscription));
  if (!userId) return false;

  const current = await retrieveCurrentSubscription(subscription);
  const customerId = stripeObjectId(current.customer);
  const price = current.items.data[0]?.price;
  let status = stripeSubscriptionStatusToPlanStatus(current.status);
  // Un litige ouvert l'emporte : un `subscription.updated` (même tardif) ne rouvre pas l'accès
  // que `charge.dispute.created` a suspendu. Le litige gagné ou perdu règle ensuite l'accès.
  if (
    (status === "trialing" || status === "active" || status === "past_due") &&
    (await userHasOpenPaymentDispute(userId))
  ) {
    console.warn("[billing] subscription kept paused: payment dispute still open", {
      subscription: current.id,
    });
    status = "paused";
  }
  const plan: PlanCode = isRecognisedAnalysisPrice(price)
    ? resolveStripePlanCode({
        metadataPlanCode: current.metadata?.plan_code,
        priceId: price?.id ?? null,
      })
    : "decouverte";
  if (plan === "decouverte") {
    console.warn("[billing] subscription with an unrecognised price ignored", {
      subscription: current.id,
      price: price?.id ?? null,
      amount: price?.unit_amount ?? null,
    });
  }
  const { data, error } = await supabaseAdmin.rpc("apply_stripe_subscription_state", {
    p_current_period_end: nullableRpcArg(stripeAccessPeriodEndIso(current, status)),
    p_event_created: eventCreated,
    p_metadata: asJson({
      stripe_status: current.status,
      stripe_price_id: price?.id ?? null,
      stripe_product_id: stripeObjectId(price?.product),
      stripe_price_amount_cents: price?.unit_amount ?? null,
      stripe_price_currency: price?.currency ?? null,
      stripe_price_interval: price?.recurring?.interval ?? null,
      stripe_price_interval_count: price?.recurring?.interval_count ?? null,
      stripe_subscription_created_at: unixToIso(current.created),
      stripe_trial_start: unixToIso(current.trial_start),
      stripe_trial_end: unixToIso(current.trial_end),
      stripe_first_invoice_at: unixToIso(current.trial_end ?? current.created),
      stripe_current_period_end: stripeCurrentPeriodEndIso(current),
      cancel_at_period_end: current.cancel_at_period_end,
      canceled_at: unixToIso(current.canceled_at),
      synced_at: new Date().toISOString(),
    }),
    p_plan_code: plan,
    p_status: status,
    p_stripe_customer_id: nullableRpcArg(customerId),
    p_stripe_subscription_id: current.id,
    p_user_id: userId,
  });
  if (error) throw new Error(error.message || "Stripe subscription sync failed.");
  const result = data?.[0];
  if (result?.applied && current.status === "trialing") {
    try {
      await enforceSingleTrialPerCard(current, userId);
    } catch (trialError) {
      // Never block access synchronisation on the anti-abuse check.
      console.error("[billing] single-trial check failed", trialError);
    }
  }
  if (result && !result.applied) {
    console.info("[billing] stale, reversed or superseded subscription event ignored", {
      subscription: current.id,
      reason: result.reason,
    });
  }
  // The confirmation does not depend on the event being the newest one applied (a stale event
  // may be the only one carrying the cancellation), but never concerns a replaced subscription.
  if (cancellationContext && result?.reason !== SUPERSEDED_SUBSCRIPTION_REASON) {
    await confirmCancellationIfRequested({
      userId,
      current,
      payloadSubscription: subscription,
      eventType: cancellationContext.eventType,
      previousAttributes: cancellationContext.previousAttributes,
      eventCreated,
    });
  }
  // A superseded event (an old subscription reported after a re-subscription) is
  // fully handled: the row already holds the newer subscription, so the webhook
  // is a success without change and must not be reported as failed or replayed.
  return result?.applied === true || result?.reason === SUPERSEDED_SUBSCRIPTION_REASON;
}

/**
 * Which confirmation of cancellation (code de la consommation, L. 215-1-1) a subscription event
 * calls for, if any. It is decided from the event itself, so a given cancellation yields one
 * confirmation: the event journal (`begin_stripe_webhook_event`) drops a replayed event, and the
 * other events of the same cancellation do not carry the transition.
 *
 * - `scheduled`: `customer.subscription.updated` where `cancel_at_period_end` just turned true
 *   (`previous_attributes.cancel_at_period_end === false`) and is still true at Stripe.
 * - `immediate`: `customer.subscription.deleted` of a subscription that was not already scheduled
 *   to end (otherwise the cancellation was confirmed when it was scheduled) and that Stripe did
 *   not cancel for non-payment or a dispute.
 */
export function cancellationNoticeKind({
  eventType,
  previousAttributes,
  payloadSubscription,
  current,
}: {
  eventType: string;
  previousAttributes?: Partial<Stripe.Subscription>;
  payloadSubscription: Pick<Stripe.Subscription, "cancel_at_period_end">;
  current: Pick<Stripe.Subscription, "status" | "cancel_at_period_end" | "cancellation_details">;
}): CancellationNoticeKind | null {
  if (eventType === "customer.subscription.updated") {
    const justScheduled =
      payloadSubscription.cancel_at_period_end === true &&
      previousAttributes?.cancel_at_period_end === false;
    return justScheduled && current.cancel_at_period_end === true && current.status !== "canceled"
      ? "scheduled"
      : null;
  }
  if (eventType === "customer.subscription.deleted") {
    const reason = current.cancellation_details?.reason;
    if (payloadSubscription.cancel_at_period_end === true) return null;
    if (reason === "payment_failed" || reason === "payment_disputed") return null;
    return current.status === "canceled" ? "immediate" : null;
  }
  return null;
}

async function confirmCancellationIfRequested({
  userId,
  current,
  payloadSubscription,
  eventType,
  previousAttributes,
  eventCreated,
}: {
  userId: string;
  current: Stripe.Subscription;
  payloadSubscription: Stripe.Subscription;
  eventType: string;
  previousAttributes?: Partial<Stripe.Subscription>;
  eventCreated: number;
}): Promise<void> {
  const kind = cancellationNoticeKind({
    eventType,
    previousAttributes,
    payloadSubscription,
    current,
  });
  if (!kind) return;

  const accessEndsAt =
    kind === "scheduled"
      ? (current.cancel_at ??
        current.items.data[0]?.current_period_end ??
        current.trial_end ??
        eventCreated)
      : (current.ended_at ?? current.canceled_at ?? eventCreated);
  // Never throws: a delivery problem must not fail (and replay) the subscription sync.
  await sendCancellationConfirmationNotice({
    userId,
    subscriptionId: current.id,
    requestedAt: current.canceled_at ?? eventCreated,
    kind,
    accessEndsAt,
    trialing: kind === "scheduled" && current.status === "trialing",
  });
}

export function resolveCheckoutPlanCode(_value: unknown): Exclude<PlanCode, "decouverte"> {
  return "analyse";
}

export function resolveStripePlanCode({
  metadataPlanCode,
  priceId,
}: {
  metadataPlanCode?: string | null;
  priceId?: string | null;
}): Exclude<PlanCode, "decouverte"> {
  void metadataPlanCode;
  void priceId;
  return "analyse";
}

async function findUserIdForSubscription(
  subscription: Stripe.Subscription,
): Promise<string | null> {
  const userId = subscription.metadata?.user_id;
  if (userId) return userId;

  const bySubscription = await supabaseAdmin
    .from("user_subscriptions")
    .select("user_id")
    .eq("stripe_subscription_id", subscription.id)
    .maybeSingle();
  if (bySubscription.error) throw bySubscription.error;
  if (bySubscription.data?.user_id) return bySubscription.data.user_id;

  const customerId = stripeObjectId(subscription.customer);
  if (!customerId) return null;

  const byCustomer = await supabaseAdmin
    .from("user_subscriptions")
    .select("user_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  if (byCustomer.error) throw byCustomer.error;
  return byCustomer.data?.user_id ?? null;
}

function stripeObjectId(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "id" in value && typeof value.id === "string") {
    return value.id;
  }
  return null;
}

function unixToIso(value: number | null | undefined): string | null {
  return value ? new Date(value * 1000).toISOString() : null;
}
