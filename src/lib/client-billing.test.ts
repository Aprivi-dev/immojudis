import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: mocks.getSession } },
}));

import {
  fetchAccessPlan,
  fetchBillingOffer,
  openBillingPortal,
  startAnalyseCheckout,
} from "./client-billing";

describe("client billing API", () => {
  beforeEach(() => {
    mocks.getSession.mockReset();
    mocks.fetch.mockReset();
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
    vi.stubGlobal("fetch", mocks.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuse les appels de facturation sans session", async () => {
    await expect(fetchAccessPlan()).rejects.toThrow("Connexion requise.");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("lit l'offre publique même sans session (le visiteur voit si la souscription est ouverte)", async () => {
    mocks.fetch.mockResolvedValueOnce(
      jsonResponse({ configured: true, trialAvailable: true, label: "29 € TTC / mois" }),
    );
    await expect(fetchBillingOffer()).resolves.toMatchObject({ configured: true });
    expect(mocks.fetch).toHaveBeenCalledWith("/api/billing/offer", {
      headers: {},
      cache: "no-store",
    });
  });

  it("transmet le token au endpoint du plan", async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: "test-access-token" } },
      error: null,
    });
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ plan: { plan: "analyse" } }));

    await expect(fetchAccessPlan()).resolves.toEqual({ plan: { plan: "analyse" } });
    expect(mocks.fetch).toHaveBeenCalledWith("/api/feature-entitlements?scope=plan", {
      headers: { Authorization: "Bearer test-access-token" },
      cache: "no-store",
    });
  });

  it("conserve le contrat de checkout et du portail", async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: "test-access-token" } },
      error: null,
    });
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse({ url: "https://checkout.example.test" }))
      .mockResolvedValueOnce(jsonResponse({ url: "https://portal.example.test" }));

    const consent = {
      termsAccepted: true as const,
      termsVersion: "terms-v1",
      privacyVersion: "privacy-v1",
      paymentObligationAcknowledged: true as const,
      immediatePerformanceRequested: true as const,
      withdrawalInformationAcknowledged: true as const,
    };

    await expect(startAnalyseCheckout({ consent })).resolves.toEqual({
      url: "https://checkout.example.test",
    });
    await expect(openBillingPortal()).resolves.toEqual({
      url: "https://portal.example.test",
    });

    expect(mocks.fetch).toHaveBeenNthCalledWith(1, "/api/billing/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-access-token",
      },
      body: JSON.stringify({ plan: "analyse", consent }),
    });
    expect(mocks.fetch).toHaveBeenNthCalledWith(2, "/api/billing/portal", {
      method: "POST",
      headers: { Authorization: "Bearer test-access-token" },
    });
  });

  it("reprend le message d’erreur de l’API ou le statut HTTP", async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: "test-access-token" } },
      error: null,
    });
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse({ error: "Paiement indisponible" }, 503))
      .mockResolvedValueOnce(new Response("pas du json", { status: 502 }));

    await expect(fetchAccessPlan()).rejects.toThrow("Paiement indisponible");
    await expect(openBillingPortal()).rejects.toThrow("Erreur HTTP 502");
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
