import { describe, expect, it } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { DEFAULT_OPEN_FEE_REGIMES } from "@/lib/fee-regime-open";
import { estimateWorksBudget } from "@/lib/profitability";
import { buildCeilingSnapshot, NO_CEILING_REGIME_REASON } from "./ceiling-snapshot";

const sale = {
  ...EXAMPLE_SALE,
  property_type: "apartment" as const,
  app_surface_m2: 50,
  app_surface_kind: "habitable" as const,
};

describe("buildCeilingSnapshot", () => {
  it("reports the refresh works budget, not the works amount retained by the user", () => {
    const snapshot = buildCeilingSnapshot(
      sale,
      null,
      { works: { key: "devis", amount: 77_000 } },
      DEFAULT_OPEN_FEE_REGIMES,
    );

    expect(snapshot.works.amount).toBe(77_000);
    expect(snapshot.refreshWorksBudget).toBe(estimateWorksBudget(50, "rafraichissement"));
    expect(snapshot.refreshWorksBudget).not.toBe(77_000);
  });

  it("derives no amount from the plan of a sale without a fee regime, whatever the choices", () => {
    const stateSale = {
      ...sale,
      sale_venue_type: "state",
      sale_procedure: null,
      source_blocks: null,
      sale_legal_framework: "unknown",
    } as unknown as typeof sale;
    const snapshot = buildCeilingSnapshot(
      stateSale,
      null,
      { manualPricePerM2: 3_000 },
      DEFAULT_OPEN_FEE_REGIMES,
    );

    expect(snapshot.regime).toBeNull();
    expect(snapshot.available).toBe(false);
    expect(snapshot.reason).toBe(NO_CEILING_REGIME_REASON);
    expect(snapshot).toMatchObject({
      maxBid: null,
      maxBidWithoutWorks: null,
      maxBidWithRefreshWorks: null,
      targetTotalCost: null,
      marketReferencePricePerM2: null,
      safetyDiscountPct: null,
      marginTotal: null,
      marginPerM2: null,
      steps: [],
      estimatedFees: [],
    });
  });
});
