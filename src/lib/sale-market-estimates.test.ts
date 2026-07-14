import { describe, expect, it } from "vitest";
import type { MarketEstimate } from "@/lib/market.functions";
import {
  marketContextFromStoredRow,
  saleValuationFingerprint,
  type SaleValuationInput,
} from "@/lib/sale-market-estimates";

const input: SaleValuationInput = {
  saleId: "00000000-0000-4000-8000-000000000001",
  lat: 48.8566,
  lng: 2.3522,
  address: "1 rue de Rivoli",
  city: "Paris",
  postalCode: "75001",
  propertyType: "apartment",
  surfaceKind: "habitable",
  surfaceScope: "lot",
  surfaceM2: 50,
  landSurfaceM2: null,
  roomsCount: 2,
  surfaceEstimated: false,
  surfaceAssumption: null,
  surfaceUncertaintyPct: null,
};

describe("sale market estimates", () => {
  it("produces a stable fingerprint and invalidates it when valuation input changes", () => {
    const first = saleValuationFingerprint(input, "2026-07-13T10:00:00.000Z");
    const same = saleValuationFingerprint({ ...input }, "2026-07-13T10:00:00.000Z");
    const changed = saleValuationFingerprint(
      { ...input, surfaceM2: 65 },
      "2026-07-13T10:00:00.000Z",
    );

    expect(same).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("keeps serving the previous estimate while a refresh is processing", () => {
    const estimate = {
      source: "DVF normalisé",
      radiusM: 300,
      yearsBack: 6,
      areaKind: "urban",
      commune: "Paris",
      sampleSize: 12,
      parcelSampleSize: 12,
      totalNearbySampleSize: 50,
      outliersRemoved: 2,
      qualityScore: 82,
      qualityLabel: "forte",
      qualityWarnings: [],
      comparableMode: "surface_matched",
      surfaceMinM2: 40,
      surfaceMaxM2: 60,
      medianPricePerM2: 10_000,
      p25PricePerM2: 9_000,
      p75PricePerM2: 11_000,
      minPricePerM2: 8_000,
      maxPricePerM2: 12_000,
      deviationPct: null,
      addressHistory: [],
      recentTransactions: [],
    } satisfies MarketEstimate;
    const context = marketContextFromStoredRow(storedRow({ status: "processing", estimate }));

    expect(context).toEqual({ ok: true, error: null, estimate });
  });

  it("reports a pending precompute without calculating on demand", () => {
    const context = marketContextFromStoredRow(storedRow({ status: "pending", estimate: null }));

    expect(context.ok).toBe(false);
    expect(context.estimate).toBeNull();
    expect(context.error).toContain("préparation");
  });
});

function storedRow(overrides: Record<string, unknown>) {
  return {
    actionable: false,
    attempt_count: 0,
    auction_sale_id: input.saleId,
    comparable_count: 0,
    computed_at: null,
    confidence_score: null,
    created_at: "2026-07-13T10:00:00.000Z",
    engine_kind: null,
    engine_version: null,
    error_message: null,
    estimate: null,
    input_fingerprint: "pending",
    last_started_at: null,
    model_version: null,
    model_version_id: null,
    next_refresh_at: "2026-07-13T10:00:00.000Z",
    segment: null,
    source_updated_at: "2026-07-13T10:00:00.000Z",
    status: "pending",
    updated_at: "2026-07-13T10:00:00.000Z",
    value_p10_eur: null,
    value_p50_eur: null,
    value_p90_eur: null,
    ...overrides,
  } as Parameters<typeof marketContextFromStoredRow>[0];
}
