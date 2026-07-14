import { describe, expect, it } from "vitest";
import type { Database } from "@/integrations/supabase/types";
import {
  buildDvfMarketStatisticsFallback,
  selectStatisticScope,
} from "@/lib/dvf-market-statistics";

type StatisticRow = Database["public"]["Tables"]["dvf_market_statistics"]["Row"];

function row(overrides: Partial<StatisticRow> = {}): StatisticRow {
  return {
    geography_level: "commune",
    geography_code: "65099",
    geography_label: "Bordères-Louron",
    parent_code: "246500482",
    segment: "house",
    sales_count: 18,
    mean_price_per_m2: 2_350,
    median_price_per_m2: 2_250,
    source_url: "https://www.data.gouv.fr/datasets/statistiques-dvf",
    source_updated_at: "2026-04-27",
    imported_at: "2026-07-13T16:00:00Z",
    ...overrides,
  };
}

describe("DVF market statistics fallback", () => {
  it("prefers a commune sample with at least five sales", () => {
    const selected = selectStatisticScope({
      commune: row({ sales_count: 6 }),
      epci: row({ geography_level: "epci", geography_code: "epci", sales_count: 200 }),
      department: row({ geography_level: "department", geography_code: "65", sales_count: 500 }),
    });

    expect(selected?.geography_level).toBe("commune");
  });

  it("falls back to EPCI when the commune sample is too small", () => {
    const selected = selectStatisticScope({
      commune: row({ sales_count: 3 }),
      epci: row({ geography_level: "epci", geography_code: "epci", sales_count: 80 }),
      department: row({ geography_level: "department", geography_code: "65", sales_count: 500 }),
    });

    expect(selected?.geography_level).toBe("epci");
  });

  it("builds an explicitly indicative and widened building estimate", () => {
    const fallback = buildDvfMarketStatisticsFallback({
      row: row({ segment: "residential", median_price_per_m2: 2_000 }),
      sourceSegment: "building",
      surfaceEstimated: false,
      surfaceUncertaintyPct: null,
    });

    expect(fallback).toMatchObject({
      medianPricePerM2: 2_000,
      salesCount: 18,
    });
    expect(fallback!.p10PricePerM2).toBeLessThan(1_300);
    expect(fallback!.p90PricePerM2).toBeGreaterThan(2_700);
    expect(fallback!.qualityScore).toBeLessThanOrEqual(54);
    expect(fallback!.qualityWarnings.join(" ")).toContain("immeuble");
  });
});
