import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchBillingOffer: vi.fn(), legalReady: true }));

vi.mock("@/lib/client-billing", () => ({ fetchBillingOffer: mocks.fetchBillingOffer }));
vi.mock("@/lib/legal-documents", () => ({
  legalPublisherConfigurationStatus: () => ({ ready: mocks.legalReady, missing: [] }),
}));

import { isAnalysisOfferOpen } from "./analysis-offer-open";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.legalReady = true;
});

describe("isAnalysisOfferOpen", () => {
  it("is open when the offer is configured", async () => {
    mocks.fetchBillingOffer.mockResolvedValue({ configured: true });
    await expect(isAnalysisOfferOpen()).resolves.toBe(true);
  });

  it("is closed when the offer is not configured", async () => {
    mocks.fetchBillingOffer.mockResolvedValue({ configured: false });
    await expect(isAnalysisOfferOpen()).resolves.toBe(false);
  });

  it("is closed, without asking the server, while the legal identity is incomplete", async () => {
    mocks.legalReady = false;
    await expect(isAnalysisOfferOpen()).resolves.toBe(false);
    expect(mocks.fetchBillingOffer).not.toHaveBeenCalled();
  });

  it("is closed when the offer cannot be read", async () => {
    mocks.fetchBillingOffer.mockRejectedValue(new Error("offline"));
    await expect(isAnalysisOfferOpen()).resolves.toBe(false);
  });
});
