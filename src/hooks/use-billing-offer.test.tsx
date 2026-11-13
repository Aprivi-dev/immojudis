// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAnalysisCheckoutOpen } from "./use-analysis-checkout-open";
import { isAnalysisOfferOpen, useBillingOffer } from "./use-billing-offer";

const mocks = vi.hoisted(() => ({
  fetchBillingOffer: vi.fn(),
  legalReady: true,
  auth: { user: { id: "user-1" } as { id: string } | null, loading: false },
}));

vi.mock("@/lib/client-billing", () => ({ fetchBillingOffer: mocks.fetchBillingOffer }));
vi.mock("@/lib/legal-documents", () => ({
  legalPublisherConfigurationStatus: () => ({ ready: mocks.legalReady, missing: [] }),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));

const offer = (configured: boolean) => ({ configured, trialDays: 7, label: "Analyse" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.legalReady = true;
  mocks.auth = { user: { id: "user-1" }, loading: false };
});

describe("offre Analyse", () => {
  it("même règle pour la page et pour l'ouverture du paiement", async () => {
    mocks.fetchBillingOffer.mockResolvedValue(offer(true));
    const { result } = renderHook(() => ({
      page: useBillingOffer(),
      checkout: useAnalysisCheckoutOpen(),
    }));

    expect(result.current.checkout).toBeNull();
    await waitFor(() => expect(result.current.checkout).toBe(true));
    expect(result.current.page.offer).toMatchObject({ status: "ready", open: true });
  });

  it("attend la session avant de lire l'offre", () => {
    mocks.auth = { user: null, loading: true };
    const { result } = renderHook(() => useAnalysisCheckoutOpen());
    expect(result.current).toBeNull();
    expect(mocks.fetchBillingOffer).not.toHaveBeenCalled();
  });

  it("reste fermée sans identité légale publiée", async () => {
    mocks.legalReady = false;
    mocks.fetchBillingOffer.mockResolvedValue(offer(true));
    const { result } = renderHook(() => useBillingOffer());
    await waitFor(() =>
      expect(result.current.offer).toMatchObject({
        status: "ready",
        configured: true,
        open: false,
      }),
    );
  });

  it("garde l'échec à part pour la page, fermé pour l'ouverture du paiement", async () => {
    mocks.fetchBillingOffer.mockRejectedValue(new Error("réseau"));
    const { result } = renderHook(() => ({
      page: useBillingOffer(),
      checkout: useAnalysisCheckoutOpen(),
    }));

    await waitFor(() => expect(result.current.page.offer.status).toBe("error"));
    expect(result.current.checkout).toBe(false);

    mocks.fetchBillingOffer.mockResolvedValue(offer(true));
    act(() => result.current.page.reload());
    await waitFor(() =>
      expect(result.current.page.offer).toMatchObject({ status: "ready", open: true }),
    );
  });

  it("au geste, compte une offre illisible comme fermée", async () => {
    mocks.fetchBillingOffer.mockRejectedValueOnce(new Error("hors ligne"));
    await expect(isAnalysisOfferOpen()).resolves.toBe(false);

    mocks.fetchBillingOffer.mockResolvedValueOnce(offer(true));
    await expect(isAnalysisOfferOpen()).resolves.toBe(true);
  });
});
