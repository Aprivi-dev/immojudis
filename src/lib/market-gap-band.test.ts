import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isPublicMarketGapBand,
  MARKET_GAP_BAND_CAUTION,
  MARKET_GAP_BAND_LABELS,
  MARKET_GAP_BAND_MAX_INTERVAL_WIDTH_PCT,
  MARKET_GAP_BAND_MIN_COMPARABLES,
  MARKET_GAP_BAND_MIN_EFFECTIVE_SAMPLE,
  marketGapBand,
} from "./market-gap-band";
import { MARKET_GAP_MAX_DISCOUNT_PCT, MARKET_GAP_MIN_DISCOUNT_PCT } from "./market-gap";
import { evaluateValuationPromotionGate } from "./valuation-admin";

const MIGRATION = "supabase/migrations/20261028200000_public_market_gap_band.sql";
const sql = readFileSync(MIGRATION, "utf8");
const code = sql.replace(/^\s*--.*$/gm, "");

const range = { valueLowEur: 100_000, valueEur: 120_000, valueHighEur: 140_000 };

describe("marketGapBand", () => {
  it("places the starting price against the whole range of the estimated value", () => {
    expect(marketGapBand({ startingPriceEur: 60_000, ...range })).toBe("under");
    expect(marketGapBand({ startingPriceEur: 115_000, ...range })).toBe("near");
    expect(marketGapBand({ startingPriceEur: 150_000, ...range })).toBe("above");
  });

  it("keeps the edges of the range in the « near » band", () => {
    expect(marketGapBand({ startingPriceEur: 100_000, ...range })).toBe("near");
    expect(marketGapBand({ startingPriceEur: 140_000, ...range })).toBe("near");
    expect(marketGapBand({ startingPriceEur: 99_999, ...range })).toBe("under");
    expect(marketGapBand({ startingPriceEur: 140_001, ...range })).toBe("above");
  });

  it("gives no band for an implausible gap, rounded to the unit like the rest of the code", () => {
    // Les mêmes cas que le test pgTAP 520 (valeur 120 000).
    expect(marketGapBand({ startingPriceEur: 20_000, ...range })).toBeNull();
    expect(marketGapBand({ startingPriceEur: 300_000, ...range })).toBeNull();
    expect(marketGapBand({ startingPriceEur: 180_480, ...range })).toBe("above"); // -50,4 -> -50
    expect(marketGapBand({ startingPriceEur: 180_720, ...range })).toBeNull(); // -50,6 -> -51
    expect(marketGapBand({ startingPriceEur: 35_520, ...range })).toBe("under"); // 70,4 -> 70
    expect(marketGapBand({ startingPriceEur: 35_280, ...range })).toBeNull(); // 70,6 -> 71
  });

  it("gives no band without a coherent range or a usable starting price", () => {
    expect(marketGapBand({ startingPriceEur: null, ...range })).toBeNull();
    expect(marketGapBand({ startingPriceEur: 0, ...range })).toBeNull();
    expect(marketGapBand({ startingPriceEur: 60_000, ...range, valueLowEur: null })).toBeNull();
    expect(marketGapBand({ startingPriceEur: 60_000, ...range, valueEur: 0 })).toBeNull();
    expect(marketGapBand({ startingPriceEur: 60_000, ...range, valueLowEur: 130_000 })).toBeNull();
    expect(marketGapBand({ startingPriceEur: 60_000, ...range, valueHighEur: 110_000 })).toBeNull();
    expect(marketGapBand({ startingPriceEur: Number.NaN, ...range })).toBeNull();
  });
});

describe("band wording", () => {
  it("never shows a figure and never prescribes", () => {
    for (const label of Object.values(MARKET_GAP_BAND_LABELS)) {
      expect(label).not.toMatch(/\d|€|%/);
      expect(label.toLowerCase()).not.toMatch(/achetez|bonne affaire|à saisir|ne ratez|conseill/);
    }
    expect(MARKET_GAP_BAND_CAUTION).not.toMatch(/\d/);
  });

  it("states that it is indicative and replaces neither a visit nor a professional", () => {
    expect(MARKET_GAP_BAND_CAUTION).toContain("indicatif");
    expect(MARKET_GAP_BAND_CAUTION).toContain(
      "Ne remplace ni une visite ni l’avis d’un professionnel",
    );
    expect(MARKET_GAP_BAND_CAUTION).toContain("prix de départ");
  });

  it("recognises exactly the words the database may answer", () => {
    for (const band of ["under", "near", "above", "insufficient"]) {
      expect(isPublicMarketGapBand(band)).toBe(true);
    }
    for (const value of [null, undefined, "", "UNDER", "cheap", 12, [], { band: "near" }]) {
      expect(isPublicMarketGapBand(value)).toBe(false);
    }
  });
});

describe("migration 20261028200000 (public band)", () => {
  it("carries the thresholds of the TypeScript code", () => {
    expect(code).toContain(`> ${MARKET_GAP_MAX_DISCOUNT_PCT} then null`);
    expect(code).toContain(`< ${MARKET_GAP_MIN_DISCOUNT_PCT} then null`);
    expect(code).toContain(`c.comparable_count >= ${MARKET_GAP_BAND_MIN_COMPARABLES}`);
    expect(code).toContain(`>= ${MARKET_GAP_BAND_MIN_EFFECTIVE_SAMPLE}`);
    expect(code).toContain(`<= ${MARKET_GAP_BAND_MAX_INTERVAL_WIDTH_PCT / 100}0`);
  });

  it("uses the interval bound of the model promotion gate", () => {
    const tooWide = evaluateValuationPromotionGate({
      testMapePct: 10,
      testMedianApePct: 10,
      intervalCoveragePct: 80,
      intervalMeanWidthPct: MARKET_GAP_BAND_MAX_INTERVAL_WIDTH_PCT + 1,
      testRows: 100,
    });
    const atBound = evaluateValuationPromotionGate({
      testMapePct: 10,
      testMedianApePct: 10,
      intervalCoveragePct: 80,
      intervalMeanWidthPct: MARKET_GAP_BAND_MAX_INTERVAL_WIDTH_PCT,
      testRows: 100,
    });
    expect(tooWide.passes).toBe(false);
    expect(atBound.passes).toBe(true);
  });

  it("runs under a fixed search_path, with a security definer read and an invoker wrapper", () => {
    expect(code).toMatch(
      /function app_private\.get_public_sale_market_gap_band\(p_sale_id uuid\)[\s\S]*?security definer\s+set search_path = ''/,
    );
    expect(code).toMatch(
      /function public\.get_public_sale_market_gap_band\(p_sale_id uuid\)\s+returns text\s+language sql\s+stable\s+set search_path = ''/,
    );
    expect(code).not.toMatch(
      /function public\.get_public_sale_market_gap_band[\s\S]*?security definer/,
    );
  });

  it("opens the public wrapper to visitors without opening the estimates", () => {
    expect(code).toMatch(
      /grant execute on function public\.get_public_sale_market_gap_band\(uuid\)\s+to anon, authenticated, service_role;/,
    );
    expect(code).toMatch(
      /revoke all on function app_private\.public_market_gap_band\(numeric, numeric, numeric, numeric\)\s+from public, anon, authenticated;/,
    );
    expect(code).not.toMatch(/grant [^;]*auction_sale_market_estimates/);
  });

  it("returns a single word, never an amount or a percentage", () => {
    expect(code).toMatch(
      /function public\.get_public_sale_market_gap_band\(p_sale_id uuid\)\s+returns text/,
    );
    for (const word of ["'under'", "'near'", "'above'", "'insufficient'"]) {
      expect(code).toContain(word);
    }
    expect(code).not.toMatch(
      /\b(s\.address|s\.latitude|s\.longitude|raw_payload|s\.description)\b/,
    );
  });

  it("decides on the public catalogue visibility and on sales with a starting price", () => {
    expect(code).toContain("app_private.auction_sale_is_publicly_visible(s.id)");
    expect(code).toContain("s.sale_venue_type in ('tribunal', 'notary')");
    expect(code).toContain("status = 'active'");
  });
});
