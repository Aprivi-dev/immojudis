import { describe, expect, it } from "vitest";
import {
  buildValuationBacktest,
  buildValuationBacktestForSale,
  type DvfBacktestTransaction,
} from "@/lib/valuation-backtest";

function tx(overrides: Partial<DvfBacktestTransaction> = {}): DvfBacktestTransaction {
  return {
    id: overrides.id ?? `row-${overrides.source_mutation_id ?? "1"}`,
    source_mutation_id: overrides.source_mutation_id ?? "mutation-1",
    sale_date: overrides.sale_date ?? "2026-01-15",
    total_price_eur: overrides.total_price_eur ?? 200_000,
    built_surface_m2: overrides.built_surface_m2 ?? 80,
    land_surface_m2: overrides.land_surface_m2 ?? null,
    price_per_m2: overrides.price_per_m2 ?? 2_500,
    property_type: overrides.property_type ?? "apartment",
    dvf_property_type_code: overrides.dvf_property_type_code ?? null,
    address: overrides.address ?? "10 rue Exemple",
    city: overrides.city ?? "Bordeaux",
    postal_code: overrides.postal_code ?? "33000",
    parcel_id: overrides.parcel_id ?? null,
    department: overrides.department ?? "33",
    latitude: overrides.latitude ?? 44.8378,
    longitude: overrides.longitude ?? -0.5792,
    source: overrides.source ?? "DVF",
    source_url: overrides.source_url ?? null,
  };
}

describe("valuation backtest", () => {
  it("measures observed valuation error from prior DVF transactions", () => {
    const transactions: DvfBacktestTransaction[] = [
      tx({ source_mutation_id: "t-new-1", sale_date: "2026-01-15", total_price_eur: 205_000 }),
      tx({ source_mutation_id: "t-new-2", sale_date: "2025-12-15", total_price_eur: 198_000 }),
      tx({ source_mutation_id: "t-new-3", sale_date: "2025-11-15", total_price_eur: 210_000 }),
      tx({ source_mutation_id: "t-old-1", sale_date: "2025-08-10", total_price_eur: 200_000 }),
      tx({ source_mutation_id: "t-old-2", sale_date: "2025-07-10", total_price_eur: 196_000 }),
      tx({ source_mutation_id: "t-old-3", sale_date: "2025-06-10", total_price_eur: 204_000 }),
      tx({ source_mutation_id: "t-old-4", sale_date: "2025-05-10", total_price_eur: 208_000 }),
      tx({ source_mutation_id: "t-old-5", sale_date: "2025-04-10", total_price_eur: 192_000 }),
      tx({ source_mutation_id: "t-old-6", sale_date: "2025-03-10", total_price_eur: 206_000 }),
    ];

    const backtest = buildValuationBacktest({
      transactions,
      reference: { latitude: 44.8378, longitude: -0.5792 },
      subject: { propertyType: "apartment", surfaceM2: 80 },
      options: {
        radiusM: 1_000,
        months: 36,
        maxTests: 7,
        now: new Date("2026-07-06T00:00:00.000Z"),
      },
    });

    expect(backtest.available).toBe(true);
    expect(backtest.summary).toMatchObject({
      status: "usable",
      candidateTransactions: 9,
      testedTransactions: 7,
      usableTests: 6,
    });
    expect(backtest.summary.medianAbsoluteErrorPct).toBeLessThanOrEqual(8);
    expect(backtest.points[0]).toMatchObject({
      transactionId: "t-new-1",
      comparableMode: "surface_matched",
    });
    expect(backtest.points[0]?.comparableSampleSize).toBeGreaterThanOrEqual(6);
  });

  it("returns an unavailable report-safe backtest when the sale is not geocoded", async () => {
    const backtest = await buildValuationBacktestForSale({
      sale: {
        department: "33",
        propertyType: "apartment",
        surfaceM2: 80,
        latitude: null,
        longitude: null,
      },
    });

    expect(backtest).toMatchObject({
      available: false,
      summary: {
        status: "missing",
        usableTests: 0,
      },
    });
  });
});
