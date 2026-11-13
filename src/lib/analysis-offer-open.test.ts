import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ legalReady: true }));

vi.mock("@/lib/legal-documents", () => ({
  legalPublisherConfigurationStatus: () => ({ ready: mocks.legalReady, missing: [] }),
}));

import { analysisOfferOpen } from "./analysis-offer-open";

beforeEach(() => {
  mocks.legalReady = true;
});

describe("analysisOfferOpen", () => {
  it("is open when the offer is configured", () => {
    expect(analysisOfferOpen({ configured: true })).toBe(true);
  });

  it("is closed when the offer is not configured", () => {
    expect(analysisOfferOpen({ configured: false })).toBe(false);
  });

  it("is closed while the legal identity is incomplete", () => {
    mocks.legalReady = false;
    expect(analysisOfferOpen({ configured: true })).toBe(false);
  });
});
