import { describe, expect, it } from "vitest";
import type { MarketEstimate } from "@/lib/market.server";
import { buildValuePreview } from "./value-preview";

const estimate = (fields: Partial<MarketEstimate>) => fields as MarketEstimate;

describe("buildValuePreview", () => {
  it("gives a rounded range and the gap with the starting price", () => {
    expect(
      buildValuePreview(
        estimate({
          actionable: true,
          estimatedValueEur: 201_400,
          estimatedValueLowEur: 178_650,
          estimatedValueHighEur: 224_300,
          qualityLabel: "correcte",
        }),
        140_000,
      ),
    ).toEqual({
      available: true,
      lowEur: 179_000,
      highEur: 224_000,
      discountPct: 30,
      reliability: "correcte",
    });
  });

  it("falls back to ±15 % without bounds and reports a starting price above the value", () => {
    const preview = buildValuePreview(
      estimate({ actionable: true, estimatedValueEur: 100_000 }),
      110_000,
    );
    expect(preview).toMatchObject({ lowEur: 85_000, highEur: 115_000, discountPct: -10 });
  });

  it("shows nothing for an estimate that is not actionable", () => {
    expect(
      buildValuePreview(estimate({ actionable: false, estimatedValueEur: 100_000 }), 50_000)
        .available,
    ).toBe(false);
    expect(buildValuePreview(null, 50_000).available).toBe(false);
  });
});
