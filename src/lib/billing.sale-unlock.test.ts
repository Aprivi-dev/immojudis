import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { LEGAL_DOCUMENTS } from "@/lib/legal-documents";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  constructEvent: vi.fn(),
  sessionsCreate: vi.fn(),
  sessionsRetrieve: vi.fn(),
  sessionsExpire: vi.fn(),
  pricesRetrieve: vi.fn(),
  customersCreate: vi.fn(),
  customersSearch: vi.fn(),
  paymentIntentsRetrieve: vi.fn(),
  chargesRetrieve: vi.fn(),
  subscriptionsRetrieve: vi.fn(),
  subscriptionsCancel: vi.fn(),
  recordSaleUnlockAcceptance: vi.fn(),
  sendCommercialConfirmation: vi.fn(),
  requireAuth: vi.fn(),
  enforceUser: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc, from: mocks.from },
}));
vi.mock("stripe", () => ({
  default: class FakeStripe {
    webhooks = { constructEvent: mocks.constructEvent };
    checkout = {
      sessions: {
        create: mocks.sessionsCreate,
        retrieve: mocks.sessionsRetrieve,
        expire: mocks.sessionsExpire,
      },
    };
    prices = { retrieve: mocks.pricesRetrieve };
    customers = { create: mocks.customersCreate, search: mocks.customersSearch };
    paymentIntents = { retrieve: mocks.paymentIntentsRetrieve };
    charges = { retrieve: mocks.chargesRetrieve };
    subscriptions = { retrieve: mocks.subscriptionsRetrieve, cancel: mocks.subscriptionsCancel };
  },
}));
// La configuration des paiements Analyse (clé, webhook, identité légale, emails) est supposée
// complète : seuls le Price et l'interrupteur de l'achat à l'unité décident ici.
vi.mock("@/lib/analysis-checkout-readiness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analysis-checkout-readiness")>()),
  analysisCheckoutReadiness: () => ({
    open: true,
    missing: [],
    keyModeMismatch: false,
    salesClosed: false,
  }),
}));
vi.mock("@/lib/commercial-acceptance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/commercial-acceptance")>()),
  recordSaleUnlockAcceptance: mocks.recordSaleUnlockAcceptance,
  recordCommercialAcceptance: vi.fn(),
  sendCommercialConfirmation: mocks.sendCommercialConfirmation,
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: mocks.enforceUser }));

import type Stripe from "stripe";
import { ConfigurationError } from "@/lib/api-errors";
import {
  ANALYSIS_RECURRING_PRICE_CENTS,
  SALE_UNLOCK_OFFER_CODE,
  SALE_UNLOCK_PRICE_CENTS,
  VAT_EXEMPTION_INVOICE_MENTION,
} from "@/lib/analysis-offer";
import { SALE_UNLOCK_PURCHASE_REFUSAL_CODES } from "@/lib/sale-unlock-checkout-contract";
import { handleStripeWebhook } from "@/lib/billing";
import { createSaleUnlockCheckoutSession } from "@/lib/billing-sale-unlock";
import type { SaleUnlockConsent } from "@/lib/commercial-acceptance";
import { POST } from "@/app/api/billing/sale-unlock-checkout/route";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SALE_ID = "33333333-3333-4333-8333-333333333333";
const PURCHASE_ID = "44444444-4444-4444-8444-444444444444";
const NEW_PURCHASE_ID = "55555555-5555-4555-8555-555555555555";

const consent: SaleUnlockConsent = {
  termsAccepted: true,
  termsVersion: LEGAL_DOCUMENTS.terms.version,
  privacyVersion: LEGAL_DOCUMENTS.privacy.version,
  paymentObligationAcknowledged: true,
  immediatePerformanceRequested: true,
  withdrawalInformationAcknowledged: true,
  withdrawalWaiverAcknowledged: true,
};

/** `from()` chaînable et attendable (journal des événements, abonnements). */
function tableAnswer(result: { data: unknown; error: unknown }) {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "limit"]) query[method] = () => query;
  query.maybeSingle = () => Promise.resolve(result);
  query.then = (resolveValue: (value: unknown) => unknown) =>
    Promise.resolve(result).then(resolveValue);
  return query;
}

function authContext(customerId: string | null = "cus_existing"): SupabaseAuthContext {
  const row = { user_id: USER_ID, stripe_customer_id: customerId, stripe_subscription_id: null };
  return {
    supabase: { from: () => tableAnswer({ data: row, error: null }) } as never,
    userId: USER_ID,
    claims: { sub: USER_ID, email: "acheteur@example.test" },
    accountTier: "free",
    userRole: "user",
    isAdmin: false,
  };
}

const rpcCalls = (name: string) => mocks.rpc.mock.calls.filter(([called]) => called === name);
const completionStatus = () => rpcCalls("complete_stripe_webhook_event").at(-1)?.[1];

type RpcAnswer = { data: unknown; error: unknown };

/** Base simulée : journal neuf par défaut ; `answers` remplace la réponse d'une fonction. */
function stubDatabase(answers: Record<string, RpcAnswer | ((args: never) => RpcAnswer)> = {}) {
  mocks.rpc.mockImplementation(async (name: string, args: never) => {
    const answer = answers[name];
    if (typeof answer === "function") return answer(args);
    if (answer) return answer;
    if (name === "begin_stripe_webhook_event") return { data: true, error: null };
    if (name === "reserve_sale_unlock_purchase") {
      return { data: [{ purchase_id: PURCHASE_ID, existing_session_id: null }], error: null };
    }
    if (name === "attach_sale_unlock_checkout") return { data: true, error: null };
    if (name === "grant_purchased_sale_unlock") {
      return { data: [{ granted: true, outcome: "unlocked" }], error: null };
    }
    if (name === "record_sale_unlock_payment_state") return { data: true, error: null };
    if (name === "record_stripe_payment_state") {
      return { data: [{ recorded: true, entitlement_updated: true }], error: null };
    }
    if (name === "expire_sale_unlock_purchase") return { data: true, error: null };
    return { data: null, error: null };
  });
}

function deliver(
  type: string,
  object: unknown,
  { id = `evt_${type}`, livemode = false }: { id?: string; livemode?: boolean } = {},
) {
  mocks.constructEvent.mockReturnValue({
    id,
    type,
    created: 1_800_000_500,
    livemode,
    data: { object },
  });
  return handleStripeWebhook({ payload: "{}", signature: "sig" });
}

function paidSession(overrides: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session {
  return {
    id: "cs_unit",
    object: "checkout.session",
    mode: "payment",
    payment_status: "paid",
    amount_total: 1_900,
    currency: "eur",
    payment_intent: "pi_unit",
    customer: "cus_existing",
    client_reference_id: USER_ID,
    metadata: {
      purpose: "sale_unlock",
      user_id: USER_ID,
      sale_id: SALE_ID,
      purchase_id: PURCHASE_ID,
      commercial_acceptance_id: "66666666-6666-4666-8666-666666666666",
    },
    ...overrides,
  } as Stripe.Checkout.Session;
}

function post(body: unknown) {
  return POST(
    new Request("https://immojudis.test/api/billing/sale-unlock-checkout", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_unit");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_unit");
  vi.stubEnv("STRIPE_ANALYSIS_PRICE_ID", "price_analysis");
  vi.stubEnv("STRIPE_SALE_UNLOCK_PRICE_ID", "price_unit");
  vi.stubEnv("STRIPE_SALE_UNLOCK_SALES_OPEN", "true");
  stubDatabase();
  mocks.from.mockImplementation((table: string) =>
    tableAnswer({
      data: table === "stripe_webhook_events" ? { processing_status: "processed" } : null,
      error: null,
    }),
  );
  mocks.requireAuth.mockResolvedValue(authContext());
  mocks.enforceUser.mockResolvedValue(1);
  mocks.pricesRetrieve.mockResolvedValue({
    id: "price_unit",
    active: true,
    type: "one_time",
    currency: "eur",
    unit_amount: 1_900,
    tax_behavior: "inclusive",
  });
  mocks.sessionsCreate.mockResolvedValue({
    id: "cs_new",
    url: "https://checkout.stripe.test/cs_new",
    created: 1_800_000_000,
    status: "open",
  });
  mocks.sessionsExpire.mockResolvedValue({});
  mocks.customersSearch.mockResolvedValue({ data: [], has_more: false });
  mocks.recordSaleUnlockAcceptance.mockResolvedValue(undefined);
  mocks.sendCommercialConfirmation.mockResolvedValue("sent");
  mocks.paymentIntentsRetrieve.mockResolvedValue({ metadata: {} });
});

describe("prix de l'achat à l'unité", () => {
  it("vaut en TypeScript ce que la base fixe (1 900 centimes, plafond de déduction 5 900, code d'offre)", () => {
    const migration = readFileSync(
      resolve("supabase/migrations/20261122100000_sale_unlock_purchases.sql"),
      "utf8",
    );
    const body = (name: string) =>
      new RegExp(`function app_private\\.${name}\\(\\)[\\s\\S]*?select (\\d+);`).exec(migration);
    const amount = body("sale_unlock_purchase_amount_cents");
    const cap = body("unit_purchase_deduction_cap_cents");
    expect(Number(amount?.[1])).toBe(SALE_UNLOCK_PRICE_CENTS);
    expect(Number(cap?.[1])).toBe(ANALYSIS_RECURRING_PRICE_CENTS);
    expect(migration).toContain(`'${SALE_UNLOCK_OFFER_CODE}'`);
  });
});

describe("création de la session d'achat", () => {
  it("crée une session de paiement unique de 19 €, métadonnées sur la session et le PaymentIntent", async () => {
    const result = await createSaleUnlockCheckoutSession({
      auth: authContext(),
      origin: "https://immojudis.test",
      saleId: SALE_ID,
      consent,
    });

    expect(result).toEqual({ url: "https://checkout.stripe.test/cs_new" });
    const [params, options] = mocks.sessionsCreate.mock.calls[0]!;
    const metadata = {
      purpose: "sale_unlock",
      user_id: USER_ID,
      sale_id: SALE_ID,
      purchase_id: PURCHASE_ID,
      commercial_acceptance_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    };
    expect(params).toMatchObject({
      mode: "payment",
      customer: "cus_existing",
      line_items: [{ price: "price_unit", quantity: 1 }],
      payment_method_types: ["card"],
      invoice_creation: {
        enabled: true,
        invoice_data: { footer: VAT_EXEMPTION_INVOICE_MENTION },
      },
      payment_intent_data: { metadata },
      metadata,
      locale: "fr",
    });
    // Stripe exige au moins 30 minutes : la marge d'une minute absorbe le délai de la requête.
    const now = Math.floor(Date.now() / 1000);
    expect(params.expires_at).toBeGreaterThanOrEqual(now + 30 * 60);
    expect(params.expires_at).toBeLessThanOrEqual(now + 32 * 60);
    expect(params).not.toHaveProperty("discounts");
    expect(params).not.toHaveProperty("allow_promotion_codes");
    expect(options.idempotencyKey).toContain(PURCHASE_ID);
    expect(rpcCalls("attach_sale_unlock_checkout")[0]![1]).toMatchObject({
      p_purchase_id: PURCHASE_ID,
      p_checkout_session_id: "cs_new",
      p_commercial_acceptance_id: metadata.commercial_acceptance_id,
    });
    expect(mocks.recordSaleUnlockAcceptance).toHaveBeenCalledWith(
      expect.objectContaining({ saleId: SALE_ID, purchaseId: PURCHASE_ID, amountCents: 1_900 }),
    );
  });

  it("(c) le retour du navigateur ne fait que relire l'état : rien n'est accordé sans webhook", async () => {
    await createSaleUnlockCheckoutSession({
      auth: authContext(),
      origin: "https://immojudis.test",
      saleId: SALE_ID,
      consent,
    });

    const [params] = mocks.sessionsCreate.mock.calls[0]!;
    expect(params.success_url).toBe(
      `https://immojudis.test/sales/${SALE_ID}?unlock_checkout=success`,
    );
    expect(params.cancel_url).toBe(
      `https://immojudis.test/sales/${SALE_ID}?unlock_checkout=cancelled`,
    );
    expect(rpcCalls("grant_purchased_sale_unlock")).toHaveLength(0);
    expect(rpcCalls("redeem_sale_unlock_credit")).toHaveLength(0);
  });

  it("crée le client Stripe du compte qui n'en a pas, avec la clé de l'abonnement, sans l'écrire en base", async () => {
    mocks.customersCreate.mockResolvedValue({ id: "cus_new" });

    await createSaleUnlockCheckoutSession({
      auth: authContext(null),
      origin: "https://immojudis.test",
      saleId: SALE_ID,
      consent,
    });

    expect(mocks.customersCreate.mock.calls[0]![1]).toEqual({
      idempotencyKey: `immojudis-customer-${USER_ID}`,
    });
    expect(mocks.sessionsCreate.mock.calls[0]![0]).toMatchObject({ customer: "cus_new" });
    expect(rpcCalls("attach_analyse_checkout_customer")).toHaveLength(0);
  });

  it("réutilise le client Stripe déjà créé par un achat précédent, sans en créer un second", async () => {
    mocks.customersSearch.mockResolvedValue({
      data: [{ id: "cus_previous", created: 1_700_000_000 }],
      has_more: false,
    });

    await createSaleUnlockCheckoutSession({
      auth: authContext(null),
      origin: "https://immojudis.test",
      saleId: SALE_ID,
      consent,
    });

    expect(mocks.customersSearch.mock.calls[0]![0]).toMatchObject({
      query: `metadata['user_id']:'${USER_ID}'`,
    });
    expect(mocks.customersCreate).not.toHaveBeenCalled();
    expect(mocks.sessionsCreate.mock.calls[0]![0]).toMatchObject({ customer: "cus_previous" });
  });

  it("refuse un Price qui n'est pas un paiement unique de 19 € en EUR, avant toute réservation", async () => {
    mocks.pricesRetrieve.mockResolvedValue({
      active: true,
      type: "recurring",
      currency: "eur",
      unit_amount: 1_900,
      tax_behavior: "inclusive",
    });

    await expect(
      createSaleUnlockCheckoutSession({ auth: authContext(), saleId: SALE_ID, consent }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    mocks.pricesRetrieve.mockResolvedValue({
      active: true,
      type: "one_time",
      currency: "eur",
      unit_amount: 2_000,
      tax_behavior: "inclusive",
    });
    await expect(
      createSaleUnlockCheckoutSession({ auth: authContext(), saleId: SALE_ID, consent }),
    ).rejects.toThrow(/19 €/);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.sessionsCreate).not.toHaveBeenCalled();
  });

  it("(j) renvoie la session encore ouverte d'un achat en attente, sans en créer d'autre", async () => {
    stubDatabase({
      reserve_sale_unlock_purchase: {
        data: [{ purchase_id: PURCHASE_ID, existing_session_id: "cs_pending" }],
        error: null,
      },
    });
    mocks.sessionsRetrieve.mockResolvedValue({
      id: "cs_pending",
      status: "open",
      url: "https://checkout.stripe.test/cs_pending",
    });

    await expect(
      createSaleUnlockCheckoutSession({ auth: authContext(), saleId: SALE_ID, consent }),
    ).resolves.toEqual({ url: "https://checkout.stripe.test/cs_pending" });
    expect(mocks.sessionsCreate).not.toHaveBeenCalled();
    expect(mocks.recordSaleUnlockAcceptance).not.toHaveBeenCalled();
  });

  it("(j) traite une session en attente inconnue de Stripe (resource_missing) comme expirée", async () => {
    let reservations = 0;
    stubDatabase({
      reserve_sale_unlock_purchase: () => {
        reservations += 1;
        return reservations === 1
          ? { data: [{ purchase_id: PURCHASE_ID, existing_session_id: "cs_gone" }], error: null }
          : { data: [{ purchase_id: NEW_PURCHASE_ID, existing_session_id: null }], error: null };
      },
    });
    mocks.sessionsRetrieve.mockRejectedValue(
      Object.assign(new Error("No such checkout.session: cs_gone"), { code: "resource_missing" }),
    );

    await expect(
      createSaleUnlockCheckoutSession({ auth: authContext(), saleId: SALE_ID, consent }),
    ).resolves.toEqual({ url: "https://checkout.stripe.test/cs_new" });
    expect(rpcCalls("expire_sale_unlock_purchase")[0]![1]).toEqual({
      p_checkout_session_id: "cs_gone",
    });
    expect(mocks.sessionsCreate.mock.calls[0]![0].metadata.purchase_id).toBe(NEW_PURCHASE_ID);
  });

  it("une autre erreur de Stripe à la relecture de la session en attente n'expire rien", async () => {
    stubDatabase({
      reserve_sale_unlock_purchase: {
        data: [{ purchase_id: PURCHASE_ID, existing_session_id: "cs_pending" }],
        error: null,
      },
    });
    mocks.sessionsRetrieve.mockRejectedValue(new Error("stripe down"));

    await expect(
      createSaleUnlockCheckoutSession({ auth: authContext(), saleId: SALE_ID, consent }),
    ).rejects.toThrow("stripe down");
    expect(rpcCalls("expire_sale_unlock_purchase")).toHaveLength(0);
    expect(mocks.sessionsCreate).not.toHaveBeenCalled();
  });

  it("(j) remplace la session expirée : l'ancien achat passe à expired, un nouvel achat est réservé", async () => {
    let reservations = 0;
    stubDatabase({
      reserve_sale_unlock_purchase: () => {
        reservations += 1;
        return reservations === 1
          ? { data: [{ purchase_id: PURCHASE_ID, existing_session_id: "cs_old" }], error: null }
          : { data: [{ purchase_id: NEW_PURCHASE_ID, existing_session_id: null }], error: null };
      },
    });
    mocks.sessionsRetrieve.mockResolvedValue({ id: "cs_old", status: "expired", url: null });

    await expect(
      createSaleUnlockCheckoutSession({ auth: authContext(), saleId: SALE_ID, consent }),
    ).resolves.toEqual({ url: "https://checkout.stripe.test/cs_new" });
    expect(rpcCalls("expire_sale_unlock_purchase")[0]![1]).toEqual({
      p_checkout_session_id: "cs_old",
    });
    expect(mocks.sessionsCreate.mock.calls[0]![0].metadata.purchase_id).toBe(NEW_PURCHASE_ID);
    expect(rpcCalls("attach_sale_unlock_checkout")[0]![1]).toMatchObject({
      p_purchase_id: NEW_PURCHASE_ID,
    });
  });

  it("expire sa session quand la base ne la rattache pas (demande concurrente) et renvoie celle de l'achat", async () => {
    let reservations = 0;
    stubDatabase({
      attach_sale_unlock_checkout: { data: false, error: null },
      reserve_sale_unlock_purchase: () => {
        reservations += 1;
        return {
          data: [
            {
              purchase_id: PURCHASE_ID,
              existing_session_id: reservations === 1 ? null : "cs_other",
            },
          ],
          error: null,
        };
      },
    });
    mocks.sessionsRetrieve.mockResolvedValue({
      id: "cs_other",
      status: "open",
      url: "https://checkout.stripe.test/cs_other",
    });

    await expect(
      createSaleUnlockCheckoutSession({ auth: authContext(), saleId: SALE_ID, consent }),
    ).resolves.toEqual({ url: "https://checkout.stripe.test/cs_other" });
    expect(mocks.sessionsExpire).toHaveBeenCalledWith("cs_new");
  });

  it("expire la session si la preuve d'acceptation ne s'enregistre pas", async () => {
    mocks.recordSaleUnlockAcceptance.mockRejectedValue(new Error("insert failed"));

    await expect(
      createSaleUnlockCheckoutSession({ auth: authContext(), saleId: SALE_ID, consent }),
    ).rejects.toThrow("insert failed");
    expect(mocks.sessionsExpire).toHaveBeenCalledWith("cs_new");
    expect(rpcCalls("attach_sale_unlock_checkout")).toHaveLength(0);
  });
});

describe("POST /api/billing/sale-unlock-checkout", () => {
  it("rend l'URL de la session", async () => {
    const response = await post({ saleId: SALE_ID, consent });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "https://checkout.stripe.test/cs_new" });
    expect(mocks.enforceUser).toHaveBeenCalledWith(
      expect.objectContaining({ bucketKey: "billing.sale-unlock-checkout", limit: 10 }),
    );
  });

  it.each([
    ["absent", undefined],
    ["posé à false", "false"],
  ])("(g) garde fermée (interrupteur %s) : 503 et aucune écriture", async (_label, value) => {
    if (value === undefined) vi.stubEnv("STRIPE_SALE_UNLOCK_SALES_OPEN", "");
    else vi.stubEnv("STRIPE_SALE_UNLOCK_SALES_OPEN", value);

    const response = await post({ saleId: SALE_ID, consent });

    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/n’est pas ouvert/);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.pricesRetrieve).not.toHaveBeenCalled();
    expect(mocks.sessionsCreate).not.toHaveBeenCalled();
    expect(mocks.recordSaleUnlockAcceptance).not.toHaveBeenCalled();
  });

  it("(g) garde fermée sans Price configuré, même interrupteur ouvert", async () => {
    vi.stubEnv("STRIPE_SALE_UNLOCK_PRICE_ID", "");

    const response = await post({ saleId: SALE_ID, consent });

    expect(response.status).toBe(503);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.sessionsCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["sans la renonciation au droit de rétractation", { withdrawalWaiverAcknowledged: undefined }],
    ["renonciation refusée", { withdrawalWaiverAcknowledged: false }],
    ["exécution immédiate non demandée", { immediatePerformanceRequested: false }],
  ])("(h) refuse un consentement incomplet (%s)", async (_label, change) => {
    const response = await post({ saleId: SALE_ID, consent: { ...consent, ...change } });

    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.sessionsCreate).not.toHaveBeenCalled();
  });

  it.each(SALE_UNLOCK_PURCHASE_REFUSAL_CODES)(
    "(i) refus « %s » de la réservation : 409 avec ce code, sans session",
    async (code) => {
      stubDatabase({
        reserve_sale_unlock_purchase: {
          data: null,
          error: { code: "P0001", message: "refus", details: code },
        },
      });

      const response = await post({ saleId: SALE_ID, consent });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.code).toBe(code);
      expect(typeof body.error).toBe("string");
      expect(mocks.sessionsCreate).not.toHaveBeenCalled();
    },
  );

  it("répond already_unlocked quand la session en attente est déjà payée", async () => {
    stubDatabase({
      reserve_sale_unlock_purchase: {
        data: [{ purchase_id: PURCHASE_ID, existing_session_id: "cs_paid" }],
        error: null,
      },
    });
    mocks.sessionsRetrieve.mockResolvedValue({ id: "cs_paid", status: "complete", url: null });

    const response = await post({ saleId: SALE_ID, consent });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("already_unlocked");
  });
});

describe("webhook : achat payé", () => {
  it("accorde l'achat par la base, avec les identifiants Stripe, et envoie la confirmation", async () => {
    const result = await deliver("checkout.session.completed", paidSession());

    expect(result.handled).toBe(true);
    expect(rpcCalls("grant_purchased_sale_unlock")[0]![1]).toEqual({
      p_purchase_id: PURCHASE_ID,
      p_user_id: USER_ID,
      p_sale_id: SALE_ID,
      p_checkout_session_id: "cs_unit",
      p_payment_intent_id: "pi_unit",
      p_amount_cents: 1_900,
      p_currency: "eur",
      p_event_id: "evt_checkout.session.completed",
      p_paid_at: new Date(1_800_000_500 * 1000).toISOString(),
    });
    expect(mocks.sendCommercialConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ checkoutSessionId: "cs_unit", saleUnlockOutcome: "unlocked" }),
    );
    // Jamais la branche historique du paiement unique Analyse.
    expect(rpcCalls("grant_analysis_access_from_payment")).toHaveLength(0);
  });

  it("(a) le même événement livré deux fois n'appelle la base qu'une fois", async () => {
    let begun = 0;
    stubDatabase({
      begin_stripe_webhook_event: () => {
        begun += 1;
        return { data: begun === 1, error: null };
      },
    });

    await deliver("checkout.session.completed", paidSession(), { id: "evt_same" });
    const replay = await deliver("checkout.session.completed", paidSession(), { id: "evt_same" });

    expect(replay.duplicate).toBe(true);
    expect(rpcCalls("grant_purchased_sale_unlock")).toHaveLength(1);
  });

  it("(b) deux événements pour la même session portent la même clé d'achat à la base, sans second envoi ni erreur", async () => {
    // Ce test ne prouve que la part du TypeScript : les deux événements appellent la base avec le même
    // achat, la même session et le même PaymentIntent, et la réponse « déjà accordé » d'un rejeu
    // n'entraîne ni erreur ni confirmation pour une autre acceptation. Qu'il n'y ait qu'UN déblocage est
    // garanti par `grant_purchased_sale_unlock` : assertions pgTAP « the same session replayed gives the
    // same answer » et « replays left one paid purchase and one bought unlock » de
    // supabase/tests/852_sale_unlock_purchases.sql. Le second envoi est écarté par la confirmation
    // elle-même (une acceptation déjà « sent » n'est pas renvoyée : commercial-acceptance.test.ts).
    stubDatabase({
      grant_purchased_sale_unlock: { data: [{ granted: true, outcome: "unlocked" }], error: null },
    });

    const first = await deliver("checkout.session.completed", paidSession(), {
      id: "evt_completed",
    });
    const second = await deliver("checkout.session.async_payment_succeeded", paidSession(), {
      id: "evt_async",
    });

    expect(first.handled).toBe(true);
    expect(second.handled).toBe(true);
    const calls = rpcCalls("grant_purchased_sale_unlock").map(([, args]) => args);
    expect(calls).toHaveLength(2);
    const key = {
      p_purchase_id: PURCHASE_ID,
      p_checkout_session_id: "cs_unit",
      p_payment_intent_id: "pi_unit",
    };
    expect(calls[0]).toMatchObject(key);
    expect(calls[1]).toMatchObject(key);
    const confirmations = mocks.sendCommercialConfirmation.mock.calls.map(([args]) => args);
    expect(new Set(confirmations.map((args) => args.acceptanceId)).size).toBe(1);
    expect(new Set(confirmations.map((args) => args.checkoutSessionId))).toEqual(
      new Set(["cs_unit"]),
    );
    expect(completionStatus()).toMatchObject({ p_processing_status: "processed" });
  });

  it.each([
    ["paiement non encaissé", { payment_status: "unpaid" }],
    ["montant différent de 1 900", { amount_total: 1_800 }],
    ["montant de l'abonnement", { amount_total: 5_900 }],
    ["autre devise", { currency: "usd" }],
    ["session d'abonnement", { mode: "subscription" }],
  ] as Array<[string, Partial<Stripe.Checkout.Session>]>)(
    "(d) n'accorde rien : %s",
    async (_label, overrides) => {
      const result = await deliver("checkout.session.completed", paidSession(overrides));

      expect(result.handled).toBe(false);
      expect(rpcCalls("grant_purchased_sale_unlock")).toHaveLength(0);
      expect(rpcCalls("grant_analysis_access_from_payment")).toHaveLength(0);
      expect(mocks.sendCommercialConfirmation).not.toHaveBeenCalled();
    },
  );

  it("(d) n'accorde rien pour un événement réel reçu avec une clé de test (livemode divergent)", async () => {
    await expect(
      deliver("checkout.session.completed", paidSession(), { livemode: true }),
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("(f) vente plus débloquable au paiement : la confirmation explique le crédit", async () => {
    stubDatabase({
      grant_purchased_sale_unlock: { data: [{ granted: true, outcome: "credit" }], error: null },
    });

    await deliver("checkout.session.completed", paidSession());

    expect(mocks.sendCommercialConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ saleUnlockOutcome: "credit" }),
    );
  });

  it("répond 5xx (rejeu par Stripe) quand la base échoue", async () => {
    stubDatabase({
      grant_purchased_sale_unlock: { data: null, error: { code: "57014", message: "timeout" } },
    });

    await expect(deliver("checkout.session.completed", paidSession())).rejects.toThrow("timeout");
    expect(completionStatus()).toMatchObject({ p_processing_status: "failed" });
    expect(mocks.sendCommercialConfirmation).not.toHaveBeenCalled();
  });

  it("ne rejoue pas un refus définitif de la base (achat qui ne correspond pas) : événement ignoré", async () => {
    stubDatabase({
      grant_purchased_sale_unlock: {
        data: null,
        error: { code: "23514", message: "mismatch", details: "sale_unlock_purchase_mismatch" },
      },
    });

    const result = await deliver("checkout.session.completed", paidSession());

    expect(result.handled).toBe(false);
    expect(completionStatus()).toMatchObject({ p_processing_status: "ignored" });
  });

  it("checkout.session.expired : l'achat en attente passe à expired, aucune réservation d'abonnement libérée", async () => {
    const result = await deliver("checkout.session.expired", paidSession({ status: "expired" }));

    expect(result.handled).toBe(true);
    expect(rpcCalls("expire_sale_unlock_purchase")[0]![1]).toEqual({
      p_checkout_session_id: "cs_unit",
    });
    expect(rpcCalls("release_analyse_checkout")).toHaveLength(0);
  });
});

describe("(e) remboursements et litiges : achat à l'unité et abonnement ne se touchent pas", () => {
  const unitPaymentIntent = { metadata: { purpose: "sale_unlock", user_id: USER_ID } };
  const subscriptionPaymentIntent = { metadata: {} };

  function charge(overrides: Record<string, unknown> = {}) {
    return {
      id: "ch_1",
      amount: 1_900,
      amount_refunded: 1_900,
      payment_intent: "pi_1",
      customer: "cus_existing",
      metadata: {},
      ...overrides,
    };
  }

  function expectSubscriptionUntouched() {
    expect(rpcCalls("record_stripe_payment_state")).toHaveLength(0);
    expect(rpcCalls("apply_stripe_subscription_state")).toHaveLength(0);
    expect(mocks.from).not.toHaveBeenCalledWith("user_subscriptions");
    expect(mocks.subscriptionsCancel).not.toHaveBeenCalled();
    expect(mocks.subscriptionsRetrieve).not.toHaveBeenCalled();
  }

  it("remboursement total d'un achat à l'unité : seul l'achat passe à refunded", async () => {
    mocks.paymentIntentsRetrieve.mockResolvedValue(unitPaymentIntent);

    const result = await deliver("charge.refunded", charge());

    expect(result.handled).toBe(true);
    expect(mocks.paymentIntentsRetrieve).toHaveBeenCalledWith("pi_1");
    expect(rpcCalls("record_sale_unlock_payment_state")[0]![1]).toEqual({
      p_payment_intent_id: "pi_1",
      p_state: "refunded",
      p_event_id: "evt_charge.refunded",
      p_event_created: 1_800_000_500,
    });
    expectSubscriptionUntouched();
  });

  it("lit l'objet du paiement sur le PaymentIntent déjà développé, sans relecture", async () => {
    await deliver(
      "charge.refunded",
      charge({ payment_intent: { id: "pi_1", ...unitPaymentIntent } }),
    );

    expect(mocks.paymentIntentsRetrieve).not.toHaveBeenCalled();
    expect(rpcCalls("record_sale_unlock_payment_state")).toHaveLength(1);
    expectSubscriptionUntouched();
  });

  it("un remboursement partiel d'un achat à l'unité ne change rien", async () => {
    mocks.paymentIntentsRetrieve.mockResolvedValue(unitPaymentIntent);

    const result = await deliver("charge.refunded", charge({ amount_refunded: 900 }));

    expect(result.handled).toBe(false);
    expect(rpcCalls("record_sale_unlock_payment_state")).toHaveLength(0);
    expectSubscriptionUntouched();
  });

  it.each([
    ["charge.dispute.created", "needs_response", "disputed"],
    ["charge.dispute.closed", "lost", "dispute_lost"],
    ["charge.dispute.closed", "won", "paid"],
    ["charge.dispute.closed", "warning_closed", "paid"],
  ])("litige %s (%s) d'un achat à l'unité : l'achat passe à %s", async (type, status, state) => {
    mocks.paymentIntentsRetrieve.mockResolvedValue(unitPaymentIntent);

    const result = await deliver(type, { id: "dp_1", status, charge: charge() });

    expect(result.handled).toBe(true);
    expect(rpcCalls("record_sale_unlock_payment_state")[0]![1]).toMatchObject({
      p_payment_intent_id: "pi_1",
      p_state: state,
    });
    expectSubscriptionUntouched();
  });

  it("une erreur de Stripe à la lecture de l'objet du paiement fait rejouer, sans toucher l'abonnement", async () => {
    mocks.paymentIntentsRetrieve.mockRejectedValue(new Error("stripe down"));

    await expect(deliver("charge.refunded", charge())).rejects.toThrow("stripe down");
    expect(rpcCalls("record_sale_unlock_payment_state")).toHaveLength(0);
    expectSubscriptionUntouched();
  });

  it("remboursement total d'un paiement d'abonnement : l'abonnement est traité, jamais un achat à l'unité", async () => {
    mocks.paymentIntentsRetrieve.mockResolvedValue(subscriptionPaymentIntent);
    mocks.from.mockImplementation((table: string) =>
      tableAnswer({
        data:
          table === "stripe_webhook_events"
            ? { processing_status: "processed" }
            : table === "user_subscriptions"
              ? { user_id: USER_ID, stripe_subscription_id: "sub_1" }
              : null,
        error: null,
      }),
    );

    const result = await deliver(
      "charge.refunded",
      charge({ amount: 5_900, amount_refunded: 5_900, metadata: { user_id: USER_ID } }),
    );

    expect(result.handled).toBe(true);
    expect(rpcCalls("record_stripe_payment_state")[0]![1]).toMatchObject({
      p_state: "refunded",
      p_user_id: USER_ID,
    });
    expect(mocks.subscriptionsCancel).toHaveBeenCalledWith("sub_1");
    expect(rpcCalls("record_sale_unlock_payment_state")).toHaveLength(0);
  });

  it("litige d'un paiement d'abonnement : jamais un achat à l'unité", async () => {
    mocks.paymentIntentsRetrieve.mockResolvedValue(subscriptionPaymentIntent);
    mocks.from.mockImplementation((table: string) =>
      tableAnswer({
        data:
          table === "stripe_webhook_events"
            ? { processing_status: "processed" }
            : table === "user_subscriptions"
              ? { current_period_end: null, stripe_subscription_id: "sub_1" }
              : [],
        error: null,
      }),
    );

    await deliver("charge.dispute.created", {
      id: "dp_1",
      status: "needs_response",
      charge: charge({ metadata: { user_id: USER_ID } }),
    });

    expect(rpcCalls("record_stripe_payment_state")[0]![1]).toMatchObject({ p_state: "disputed" });
    expect(rpcCalls("record_sale_unlock_payment_state")).toHaveLength(0);
  });
});
