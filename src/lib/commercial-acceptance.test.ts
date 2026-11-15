import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserById: vi.fn(),
  from: vi.fn(),
  upsert: vi.fn(),
  sendResendEmail: vi.fn(),
  resolveConfig: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, auth: { admin: { getUserById: mocks.getUserById } } },
}));
vi.mock("@/lib/email-alerts", () => ({
  resolveTransactionalEmailConfig: mocks.resolveConfig,
  sendResendEmail: mocks.sendResendEmail,
}));

import { LEGAL_DOCUMENTS } from "@/lib/legal-documents";
import {
  recordSaleUnlockAcceptance,
  saleUnlockConsentSchema,
  sendCommercialConfirmation,
} from "@/lib/commercial-acceptance";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";

const ACCEPTANCE_ID = "22222222-2222-4222-8222-222222222222";
const OLD_TERMS_SHA = "a".repeat(64);
const OLD_PRIVACY_SHA = "b".repeat(64);

function table(result: { data: unknown; error?: unknown }) {
  const builder = {
    select: vi.fn((_columns?: string) => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => ({ data: result.data, error: result.error ?? null })),
  };
  return builder;
}

describe("sendCommercialConfirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserById.mockResolvedValue({
      data: { user: { email: "client@example.test" } },
      error: null,
    });
    mocks.resolveConfig.mockReturnValue({
      configured: true,
      missing: [],
      apiKey: "re_test",
      from: "Immojudis <contact@example.test>",
      appUrl: "https://immojudis.example",
    });
    mocks.sendResendEmail.mockResolvedValue({ id: "email_1" });
    mocks.upsert.mockResolvedValue({ error: null });
  });

  function wire(acceptance: Record<string, unknown>) {
    mocks.from.mockImplementation((name: string) => {
      if (name === "commercial_confirmation_deliveries") {
        return { ...table({ data: null }), upsert: mocks.upsert };
      }
      if (name === "commercial_acceptances") return table({ data: acceptance });
      return table({ data: null });
    });
  }

  it("cite la version et l'empreinte enregistrées avec l'acceptation, pas la version courante", async () => {
    // Acceptation signée sous la version « .1 », relancée alors que la version en vigueur est « .2 ».
    expect(LEGAL_DOCUMENTS.terms.version).not.toBe("2026-10-13.1");
    wire({
      offer_code: "analyse_30_days",
      amount_cents: 1900,
      currency: "eur",
      evidence: {},
      terms_version: "2026-10-13.1",
      terms_sha256: OLD_TERMS_SHA,
      privacy_version: "2026-10-13.1",
      privacy_sha256: OLD_PRIVACY_SHA,
    });

    const outcome = await sendCommercialConfirmation({
      acceptanceId: ACCEPTANCE_ID,
      checkoutSessionId: "cs_test_1",
      userId: "11111111-1111-4111-8111-111111111111",
      paidAt: "2026-10-13T10:00:00.000Z",
    });

    expect(outcome).toBe("sent");
    const { text, html } = mocks.sendResendEmail.mock.calls[0]![0].message;
    expect(text).toContain("Conditions acceptées : version 2026-10-13.1");
    expect(text).toContain("Politique de confidentialité : version 2026-10-13.1");
    expect(text).toContain(`Empreinte SHA-256 des conditions acceptées : ${OLD_TERMS_SHA}`);
    expect(text).not.toContain(LEGAL_DOCUMENTS.terms.version);
    expect(text).not.toContain(LEGAL_DOCUMENTS.terms.sha256);
    expect(html).toContain("Conditions version 2026-10-13.1");
    expect(html).toContain(OLD_TERMS_SHA);
    expect(html).not.toContain(LEGAL_DOCUMENTS.terms.sha256);
  });

  it("lit ces quatre colonnes de commercial_acceptances", async () => {
    const acceptances = table({
      data: {
        offer_code: "analyse_30_days",
        evidence: {},
        terms_version: LEGAL_DOCUMENTS.terms.version,
        terms_sha256: LEGAL_DOCUMENTS.terms.sha256,
        privacy_version: LEGAL_DOCUMENTS.privacy.version,
        privacy_sha256: LEGAL_DOCUMENTS.privacy.sha256,
      },
    });
    mocks.from.mockImplementation((name: string) =>
      name === "commercial_confirmation_deliveries"
        ? { ...table({ data: null }), upsert: mocks.upsert }
        : name === "commercial_acceptances"
          ? acceptances
          : table({ data: null }),
    );
    await sendCommercialConfirmation({
      acceptanceId: ACCEPTANCE_ID,
      checkoutSessionId: "cs_test_2",
      userId: "11111111-1111-4111-8111-111111111111",
      paidAt: "2026-10-13T10:00:00.000Z",
    });
    const columns = String(acceptances.select.mock.calls[0]![0]);
    for (const column of ["terms_version", "terms_sha256", "privacy_version", "privacy_sha256"]) {
      expect(columns).toContain(column);
    }
  });
});

describe("achat d'une vente à l'unité : acceptation et confirmation", () => {
  const SALE_ID = "33333333-3333-4333-8333-333333333333";
  const saleConsent = {
    termsAccepted: true,
    termsVersion: LEGAL_DOCUMENTS.terms.version,
    privacyVersion: LEGAL_DOCUMENTS.privacy.version,
    paymentObligationAcknowledged: true,
    immediatePerformanceRequested: true,
    withdrawalInformationAcknowledged: true,
    withdrawalWaiverAcknowledged: true,
  } as const;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserById.mockResolvedValue({
      data: { user: { email: "client@example.test" } },
      error: null,
    });
    mocks.resolveConfig.mockReturnValue({
      configured: true,
      missing: [],
      apiKey: "re_test",
      from: "Immojudis <contact@example.test>",
      appUrl: "https://immojudis.example",
    });
    mocks.sendResendEmail.mockResolvedValue({ id: "email_1" });
    mocks.upsert.mockResolvedValue({ error: null });
    mocks.from.mockImplementation((name: string) => {
      if (name === "commercial_confirmation_deliveries") {
        return { ...table({ data: null }), upsert: mocks.upsert };
      }
      if (name === "commercial_acceptances") {
        return table({
          data: {
            offer_code: "sale_unlock_unit",
            amount_cents: 1900,
            currency: "eur",
            evidence: { sale_id: SALE_ID, withdrawal_waiver_acknowledged: true },
            terms_version: LEGAL_DOCUMENTS.terms.version,
            terms_sha256: LEGAL_DOCUMENTS.terms.sha256,
            privacy_version: LEGAL_DOCUMENTS.privacy.version,
            privacy_sha256: LEGAL_DOCUMENTS.privacy.sha256,
          },
        });
      }
      return table({ data: null });
    });
  });

  it("refuse un consentement sans la renonciation au droit de rétractation", () => {
    expect(saleUnlockConsentSchema.safeParse(saleConsent).success).toBe(true);
    const { withdrawalWaiverAcknowledged: _omitted, ...withoutWaiver } = saleConsent;
    expect(saleUnlockConsentSchema.safeParse(withoutWaiver).success).toBe(false);
    expect(
      saleUnlockConsentSchema.safeParse({ ...saleConsent, withdrawalWaiverAcknowledged: false })
        .success,
    ).toBe(false);
  });

  it("enregistre l'objet, le code d'offre, le montant et la renonciation", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    mocks.from.mockReturnValue({ insert });

    await recordSaleUnlockAcceptance({
      acceptanceId: ACCEPTANCE_ID,
      auth: {
        userId: "11111111-1111-4111-8111-111111111111",
        claims: { email: "Client@Example.test" },
      } as unknown as SupabaseAuthContext,
      consent: saleConsent,
      checkoutSessionId: "cs_unit",
      checkoutCreatedAt: "2026-11-15T10:00:00.000Z",
      requestId: "req_1",
      userAgent: "Vitest",
      priceId: "price_unit",
      amountCents: 1900,
      saleId: SALE_ID,
      purchaseId: "44444444-4444-4444-8444-444444444444",
    });

    expect(mocks.from).toHaveBeenCalledWith("commercial_acceptances");
    expect(insert.mock.calls[0]![0]).toMatchObject({
      id: ACCEPTANCE_ID,
      purpose: "sale_unlock_purchase",
      offer_code: "sale_unlock_unit",
      amount_cents: 1900,
      currency: "eur",
      immediate_performance_requested: true,
      checkout_session_id: "cs_unit",
      evidence: {
        sale_id: SALE_ID,
        purchase_id: "44444444-4444-4444-8444-444444444444",
        price_id: "price_unit",
        withdrawal_waiver_acknowledged: true,
      },
    });
  });

  it("confirmation d'un crédit : montant, mention de TVA, renonciation et explication du crédit", async () => {
    const outcome = await sendCommercialConfirmation({
      acceptanceId: ACCEPTANCE_ID,
      checkoutSessionId: "cs_unit",
      userId: "11111111-1111-4111-8111-111111111111",
      paidAt: "2026-11-15T10:00:00.000Z",
      saleUnlockOutcome: "credit",
    });

    expect(outcome).toBe("sent");
    const { subject, text, html } = mocks.sendResendEmail.mock.calls[0]![0].message;
    expect(subject).toMatch(/achat/i);
    expect(text).toContain(`https://immojudis.example/sales/${SALE_ID}`);
    expect(text).toMatch(/19,00\s€/);
    expect(text).toContain("TVA non applicable, art. 293 B du CGI");
    expect(text).toMatch(/renoncé expressément à votre droit de rétractation/);
    expect(text).toMatch(/un crédit a été ajouté à votre compte/);
    expect(text).not.toMatch(/la vente est débloquée sur votre compte\./);
    // Pas de formulaire de rétractation pour un contenu fourni immédiatement avec renonciation.
    expect(text).not.toContain("Modèle de formulaire de rétractation");
    expect(text).not.toContain("abonnement");
    expect(html).toContain("TVA non applicable, art. 293 B du CGI");
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ acceptance_id: ACCEPTANCE_ID, status: "sent" }),
      { onConflict: "acceptance_id" },
    );
  });

  it("confirmation d'un déblocage : la vente est débloquée, sans parler de crédit", async () => {
    await sendCommercialConfirmation({
      acceptanceId: ACCEPTANCE_ID,
      checkoutSessionId: "cs_unit",
      userId: "11111111-1111-4111-8111-111111111111",
      paidAt: "2026-11-15T10:00:00.000Z",
      saleUnlockOutcome: "unlocked",
    });

    const { text } = mocks.sendResendEmail.mock.calls[0]![0].message;
    expect(text).toContain("Résultat : la vente est débloquée sur votre compte.");
    expect(text).not.toMatch(/crédit/);
  });

  it("n'envoie pas une seconde fois une confirmation déjà envoyée (webhook rejoué)", async () => {
    mocks.from.mockImplementation((name: string) =>
      name === "commercial_confirmation_deliveries"
        ? { ...table({ data: { status: "sent", attempt_count: 1 } }), upsert: mocks.upsert }
        : table({ data: null }),
    );

    const outcome = await sendCommercialConfirmation({
      acceptanceId: ACCEPTANCE_ID,
      checkoutSessionId: "cs_unit",
      userId: "11111111-1111-4111-8111-111111111111",
      paidAt: "2026-11-15T10:00:00.000Z",
      saleUnlockOutcome: "unlocked",
    });

    expect(outcome).toBe("sent");
    expect(mocks.sendResendEmail).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("relance sans l'issue connue : la confirmation explique les deux issues", async () => {
    await sendCommercialConfirmation({
      acceptanceId: ACCEPTANCE_ID,
      checkoutSessionId: "cs_unit",
      userId: "11111111-1111-4111-8111-111111111111",
      paidAt: "2026-11-15T10:00:00.000Z",
    });

    const { text } = mocks.sendResendEmail.mock.calls[0]![0].message;
    expect(text).toMatch(/débloquée/);
    expect(text).toMatch(/crédit/);
  });
});
