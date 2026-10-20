import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isOccupiedOccupancyStatus,
  isPublicMarketGapBand,
  MARKET_GAP_BAND_CAUTION,
  MARKET_GAP_BAND_LABELS,
  MARKET_GAP_BAND_MAX_INTERVAL_WIDTH_PCT,
  MARKET_GAP_BAND_MAX_RADIUS_OTHER_M,
  MARKET_GAP_BAND_MAX_RADIUS_URBAN_APARTMENT_M,
  MARKET_GAP_BAND_MIN_COMPARABLES,
  MARKET_GAP_BAND_MIN_COMPARABLES_JACKKNIFE,
  MARKET_GAP_BAND_MIN_EFFECTIVE_SAMPLE,
  MARKET_GAP_BAND_STARTING_PRICE_NOTE,
  marketGapBand,
  marketGapBandMaxRadiusM,
} from "./market-gap-band";
import { MARKET_GAP_MAX_DISCOUNT_PCT, MARKET_GAP_MIN_DISCOUNT_PCT } from "./market-gap";
import { normalizeOccupationStatus } from "./tribunal-listing-statistics";
import { evaluateValuationPromotionGate } from "./valuation-admin";

// La règle des trois bandes et ses garde-fous sont dans la première migration ; la porte de qualité,
// les raisons d'insuffisance et le bien occupé sont dans la seconde, qui remplace la fonction de lecture.
const MIGRATION = "supabase/migrations/20261028200000_public_market_gap_band.sql";
const sql = readFileSync(MIGRATION, "utf8");
const code = sql.replace(/^\s*--.*$/gm, "");
const HARDENED_MIGRATION = "supabase/migrations/20261029120000_public_market_gap_band_hardened.sql";
const hardenedCode = readFileSync(HARDENED_MIGRATION, "utf8").replace(/^\s*--.*$/gm, "");

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
    expect(MARKET_GAP_BAND_STARTING_PRICE_NOTE).not.toMatch(/\d/);
  });

  it("describes a position against comparable sales, without « nettement », « proche » or « valeur de marché »", () => {
    expect(MARKET_GAP_BAND_LABELS.under).toBe(
      "Mise à prix inférieure à la fourchette des ventes comparables",
    );
    expect(MARKET_GAP_BAND_LABELS.near).toBe(
      "Mise à prix dans la fourchette des ventes comparables",
    );
    expect(MARKET_GAP_BAND_LABELS.above).toBe(
      "Mise à prix au-dessus de la fourchette des ventes comparables",
    );
    for (const label of Object.values(MARKET_GAP_BAND_LABELS)) {
      expect(label.toLowerCase()).not.toMatch(/nettement|proche|valeur de march/);
    }
  });

  it("says why an occupied property is not compared, and why an estimate is not reliable", () => {
    expect(MARKET_GAP_BAND_LABELS.occupied).toBe(
      "Bien occupé : la comparaison avec les ventes de biens libres n'est pas pertinente",
    );
    expect(MARKET_GAP_BAND_LABELS.insufficient_surface).toContain("Surface du bien inconnue");
    expect(MARKET_GAP_BAND_LABELS.insufficient_type).toContain("Type de bien non pris en charge");
    expect(MARKET_GAP_BAND_LABELS.insufficient).toContain("ventes comparables fiables");
    expect(new Set(Object.values(MARKET_GAP_BAND_LABELS)).size).toBe(7);
  });

  it("states that the starting price is deliberately low at auctions", () => {
    expect(MARKET_GAP_BAND_STARTING_PRICE_NOTE).toBe(
      "Aux enchères, la mise à prix est volontairement basse : le prix final est souvent bien supérieur.",
    );
  });

  it("states that it is indicative and replaces neither a visit nor a professional", () => {
    expect(MARKET_GAP_BAND_CAUTION).toContain("indicatif");
    expect(MARKET_GAP_BAND_CAUTION).toContain(
      "Ne remplace ni une visite ni l’avis d’un professionnel",
    );
    expect(MARKET_GAP_BAND_CAUTION).toContain("prix de départ");
  });

  it("explains what the DVF is", () => {
    expect(MARKET_GAP_BAND_CAUTION).toContain(
      "DVF (base des ventes immobilières déclarées aux notaires)",
    );
  });

  it("recognises exactly the words the database may answer", () => {
    for (const band of [
      "under",
      "near",
      "above",
      "occupied",
      "insufficient_surface",
      "insufficient_type",
      "insufficient",
    ]) {
      expect(isPublicMarketGapBand(band)).toBe(true);
    }
    for (const value of [null, undefined, "", "UNDER", "cheap", 12, [], { band: "near" }]) {
      expect(isPublicMarketGapBand(value)).toBe(false);
    }
  });
});

describe("occupancy", () => {
  it("agrees with normalizeOccupationStatus on every value", () => {
    const values = [
      "occupied",
      "rented",
      "owner_occupied",
      "tenant_occupied",
      "squatted",
      "vacant",
      "unknown",
      "Libre",
      "Inoccupé",
      "Loué",
      "Occupé par le propriétaire",
      "  OCCUPIED ",
      "",
      "n'importe quoi",
      null,
      undefined,
    ];
    for (const value of values) {
      const normalized = normalizeOccupationStatus(value);
      expect(isOccupiedOccupancyStatus(value), String(value)).toBe(
        normalized === "occupied" || normalized === "rented",
      );
    }
  });
});

describe("maximum search radius", () => {
  it("is 1 000 m for an urban apartment and 2 000 m for a house", () => {
    expect(MARKET_GAP_BAND_MAX_RADIUS_URBAN_APARTMENT_M).toBe(1_000);
    expect(MARKET_GAP_BAND_MAX_RADIUS_OTHER_M).toBe(2_000);
    expect(marketGapBandMaxRadiusM("apartment", "urban")).toBe(1_000);
    expect(marketGapBandMaxRadiusM("house", "urban")).toBe(2_000);
    expect(marketGapBandMaxRadiusM("house", "rural")).toBe(2_000);
    expect(marketGapBandMaxRadiusM("apartment", "rural")).toBe(2_000);
    expect(marketGapBandMaxRadiusM("building", "urban")).toBe(2_000);
  });

  it("takes the strictest bound when the type or the area is unknown", () => {
    expect(marketGapBandMaxRadiusM(null, null)).toBe(1_000);
    expect(marketGapBandMaxRadiusM("apartment", null)).toBe(1_000);
    expect(marketGapBandMaxRadiusM(undefined, "rural")).toBe(1_000);
  });
});

describe("migration 20261028200000 (public band)", () => {
  it("carries the guard rails of the TypeScript code", () => {
    expect(code).toContain(`> ${MARKET_GAP_MAX_DISCOUNT_PCT} then null`);
    expect(code).toContain(`< ${MARKET_GAP_MIN_DISCOUNT_PCT} then null`);
  });

  it("opens the public wrapper to visitors without opening the estimates", () => {
    expect(code).toMatch(
      /function public\.get_public_sale_market_gap_band\(p_sale_id uuid\)\s+returns text\s+language sql\s+stable\s+set search_path = ''/,
    );
    expect(code).not.toMatch(
      /function public\.get_public_sale_market_gap_band[\s\S]*?security definer/,
    );
    expect(code).toMatch(
      /grant execute on function public\.get_public_sale_market_gap_band\(uuid\)\s+to anon, authenticated, service_role;/,
    );
    expect(code).toMatch(
      /revoke all on function app_private\.public_market_gap_band\(numeric, numeric, numeric, numeric\)\s+from public, anon, authenticated;/,
    );
    expect(code).not.toMatch(/grant [^;]*auction_sale_market_estimates/);
  });

  it("decides on the public catalogue visibility and on sales with a starting price", () => {
    expect(code).toContain("app_private.auction_sale_is_publicly_visible(s.id)");
    expect(code).toContain("s.sale_venue_type in ('tribunal', 'notary')");
    expect(code).toContain("status = 'active'");
  });
});

describe("migration 20261029120000 (hardened public gate)", () => {
  it("carries the thresholds of the TypeScript code", () => {
    expect(hardenedCode).toContain(
      `when c.interval_method = 'local_jackknife' then ${MARKET_GAP_BAND_MIN_COMPARABLES_JACKKNIFE}`,
    );
    expect(hardenedCode).toMatch(new RegExp(`else ${MARKET_GAP_BAND_MIN_COMPARABLES}\\s+end`));
    expect(hardenedCode).toContain(`>= ${MARKET_GAP_BAND_MIN_EFFECTIVE_SAMPLE}`);
    expect(hardenedCode).toContain(`<= ${MARKET_GAP_BAND_MAX_INTERVAL_WIDTH_PCT / 100}0`);
    expect(hardenedCode).toContain(
      "c.radius_m <= app_private.public_market_gap_band_max_radius_m(c.segment, c.area_kind)",
    );
  });

  it("carries the radius table of the TypeScript code", () => {
    expect(hardenedCode).toContain(
      `when p_segment in ('house', 'building', 'commercial', 'land') then ${MARKET_GAP_BAND_MAX_RADIUS_OTHER_M}`,
    );
    expect(hardenedCode).toContain(
      `when p_segment = 'apartment' and p_area_kind = 'rural' then ${MARKET_GAP_BAND_MAX_RADIUS_OTHER_M}`,
    );
    expect(hardenedCode).toContain(`else ${MARKET_GAP_BAND_MAX_RADIUS_URBAN_APARTMENT_M}`);
  });

  it("is stricter than the interval bound of the model promotion gate (110 %)", () => {
    const atPublicBound = evaluateValuationPromotionGate({
      testMapePct: 10,
      testMedianApePct: 10,
      intervalCoveragePct: 80,
      intervalMeanWidthPct: 110,
      testRows: 100,
    });
    expect(atPublicBound.passes).toBe(true);
    expect(MARKET_GAP_BAND_MAX_INTERVAL_WIDTH_PCT).toBeLessThan(110);
    expect(MARKET_GAP_BAND_MIN_COMPARABLES_JACKKNIFE).toBeGreaterThan(4);
    expect(MARKET_GAP_BAND_MIN_EFFECTIVE_SAMPLE).toBeGreaterThan(3);
  });

  it("reads the jackknife method and the radius from the stored estimate", () => {
    expect(hardenedCode).toContain("e.estimate -> 'predictionInterval' ->> 'method'");
    expect(hardenedCode).toContain("(e.estimate ->> 'radiusM')::numeric");
    expect(hardenedCode).toContain("c.radius_m is not null");
  });

  it("tells the reasons apart with the error code of the estimate", () => {
    expect(hardenedCode).toContain("g.last_error_code = 'MISSING_SURFACE'");
    expect(hardenedCode).toContain("then 'insufficient_surface'");
    expect(hardenedCode).toContain("g.last_error_code = 'UNSUPPORTED_SEGMENT'");
    expect(hardenedCode).toContain("then 'insufficient_type'");
  });

  it("never lets « under » out for an occupied property", () => {
    expect(hardenedCode).toMatch(
      /b\.band = 'under' and app_private\.is_occupied_occupancy_status\(g\.occupancy_status\)\s+then 'occupied'/,
    );
  });

  it("mirrors the occupancy rule of normalizeOccupationStatus", () => {
    expect(hardenedCode).toContain("x.v ~ 'inoccup|libre'");
    expect(hardenedCode).toContain("x.v ~ 'lou[eé]'");
    expect(hardenedCode).toContain("x.v ~ 'occup|proprietaire|propriétaire|squat'");
  });

  it("keeps the model activation gate and the contract of the read", () => {
    expect(hardenedCode).toMatch(
      /function app_private\.get_public_sale_market_gap_band\(p_sale_id uuid\)[\s\S]*?security definer\s+set search_path = ''/,
    );
    expect(hardenedCode).toContain("m.status = 'active'");
    expect(hardenedCode).toContain("app_private.auction_sale_is_publicly_visible(s.id)");
    expect(hardenedCode).toMatch(
      /grant execute on function app_private\.get_public_sale_market_gap_band\(uuid\)\s+to anon, authenticated, service_role;/,
    );
    expect(hardenedCode).not.toMatch(
      /\b(s\.address|s\.latitude|s\.longitude|raw_payload|s\.description)\b/,
    );
    expect(hardenedCode).not.toMatch(/grant [^;]*auction_sale_market_estimates/);
  });

  it("answers with words only", () => {
    for (const word of [
      "'under'",
      "'occupied'",
      "'insufficient_surface'",
      "'insufficient_type'",
      "'insufficient'",
    ]) {
      expect(hardenedCode).toContain(word);
    }
  });
});
