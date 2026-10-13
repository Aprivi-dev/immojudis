import { describe, expect, it } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { estimateWorksBudget } from "@/lib/profitability";
import { buildCeilingSnapshot } from "./ceiling-snapshot";

const sale = {
  ...EXAMPLE_SALE,
  property_type: "apartment" as const,
  app_surface_m2: 50,
  app_surface_kind: "habitable" as const,
};

describe("buildCeilingSnapshot", () => {
  it("reports the refresh works budget, not the works amount retained by the user", () => {
    const snapshot = buildCeilingSnapshot(sale, null, {
      works: { key: "devis", amount: 77_000 },
    });

    expect(snapshot.works.amount).toBe(77_000);
    expect(snapshot.refreshWorksBudget).toBe(estimateWorksBudget(50, "rafraichissement"));
    expect(snapshot.refreshWorksBudget).not.toBe(77_000);
  });
});
