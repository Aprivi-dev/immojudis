// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import type { CeilingHypotheses } from "@/lib/bid-ceiling-engine";

const mocks = vi.hoisted(() => ({ maxWorksAtBid: vi.fn(() => 42_000) }));

vi.mock("@/lib/bid-ceiling-engine", () => ({ maxWorksAtBid: mocks.maxWorksAtBid }));
vi.mock("@/components/sale-detail/ListingWorks", () => ({
  ListingWorks: ({ maxWorks }: { maxWorks: number | null }) => (
    <p data-testid="max-works">{String(maxWorks)}</p>
  ),
}));
vi.mock("@/components/sale-detail/FinancingSimulator", () => ({ FinancingSimulator: () => null }));
vi.mock("@/components/sale-detail/ListingRental", () => ({ ListingRental: () => null }));
vi.mock("@/components/PremiumFeaturePreview", () => ({ PremiumFeaturePreview: () => null }));

import { SaleDetailWorksFinancingSection } from "./SaleDetailWorksFinancingSection";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderSection(startingPrice: number | null) {
  const props: ComponentProps<typeof SaleDetailWorksFinancingSection> = {
    saleId: EXAMPLE_SALE.id,
    displaySale: { ...EXAMPLE_SALE, starting_price_eur: startingPrice },
    access: "analysis",
    force: true,
    inputsToConfirm: false,
    retainedWorks: 10_000,
    worksBreakdown: undefined,
    onWorksBreakdownChange: () => undefined,
    surface: 50,
    onScenarioSelect: () => undefined,
    heroCeiling: 150_000,
    ceilingHypotheses: {} as CeilingHypotheses,
    aiReviewProjections: null,
    aiReviewStatus: "ready",
    financingLoading: false,
    projectCost: null,
    financingDraft: null,
    onFinancingDraftChange: () => undefined,
    onFinancingResultChange: () => undefined,
    acquisitionCost: null,
    monthlyDebtService: null,
    rentalDraft: null,
    onRentalDraftChange: () => undefined,
  };
  return render(<SaleDetailWorksFinancingSection {...props} />);
}

describe("enveloppe travaux de la fiche", () => {
  it("se calcule à la mise à prix", async () => {
    renderSection(120_000);
    expect((await screen.findByTestId("max-works")).textContent).toBe("42000");
    expect(mocks.maxWorksAtBid).toHaveBeenCalledWith(expect.anything(), 120_000);
  });

  it("n'existe pas sans mise à prix (pas d'enveloppe pour une enchère à 0 €)", async () => {
    renderSection(null);
    expect((await screen.findByTestId("max-works")).textContent).toBe("null");
    expect(mocks.maxWorksAtBid).not.toHaveBeenCalled();
  });
});
