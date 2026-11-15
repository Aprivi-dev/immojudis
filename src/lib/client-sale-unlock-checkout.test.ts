import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: mocks.getSession } },
}));

// Ces tests portent sur les appels authentifiés : on simule une session stockée, sinon
// `authHeaders` répond « Connexion requise. » sans même lire la session.
vi.mock("@/integrations/supabase/lazy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/integrations/supabase/lazy")>()),
  hasSupabaseAuthHint: () => true,
}));

import { startSaleUnlockCheckout } from "./client-sale-unlock-checkout";
import { saleUnlockCheckoutRefusalCode } from "./sale-unlock-checkout-contract";

describe("achat d'une vente à l'unité", () => {
  const consent = {
    termsAccepted: true,
    termsVersion: "v",
    privacyVersion: "v",
    paymentObligationAcknowledged: true,
    immediatePerformanceRequested: true,
    withdrawalInformationAcknowledged: true,
    withdrawalWaiverAcknowledged: true,
  } as const;
  const saleId = "33333333-3333-4333-8333-333333333333";

  beforeEach(() => {
    mocks.getSession.mockReset();
    mocks.fetch.mockReset();
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: "test-access-token" } },
      error: null,
    });
    vi.stubGlobal("fetch", mocks.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("envoie la vente et le consentement, et rend l'URL de Stripe Checkout", async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ url: "https://checkout.stripe.test/cs" }));

    await expect(startSaleUnlockCheckout({ saleId, consent })).resolves.toEqual({
      url: "https://checkout.stripe.test/cs",
    });
    expect(mocks.fetch).toHaveBeenCalledWith("/api/billing/sale-unlock-checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-access-token",
      },
      body: JSON.stringify({ saleId, consent }),
    });
  });

  it("rend le code du refus d'un 409, et rien pour une autre erreur", async () => {
    mocks.fetch.mockResolvedValueOnce(
      jsonResponse({ error: "Vous avez un crédit.", code: "credit_available" }, 409),
    );
    const refused = await startSaleUnlockCheckout({ saleId, consent }).catch((error) => error);
    expect(saleUnlockCheckoutRefusalCode(refused)).toBe("credit_available");

    mocks.fetch.mockResolvedValueOnce(jsonResponse({ ok: false, error: "Fermé." }, 503));
    const closed = await startSaleUnlockCheckout({ saleId, consent }).catch((error) => error);
    expect(closed).toMatchObject({ status: 503 });
    expect(saleUnlockCheckoutRefusalCode(closed)).toBeNull();
    expect(saleUnlockCheckoutRefusalCode({ status: 409, code: "CONFLICT" })).toBeNull();
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
