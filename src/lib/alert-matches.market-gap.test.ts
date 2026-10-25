import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuctionSale, UserAlert } from "@/lib/types";

const mocks = vi.hoisted(() => ({ estimate: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/system-auth", () => ({ systemAuthForUser: vi.fn() }));
vi.mock("@/lib/property-reports", () => ({ resolvePlanEntitlements: vi.fn() }));
vi.mock("@/lib/queries", () => ({
  getSalesForAlertEvaluation: vi.fn(),
  getSaleAlertDetails: vi.fn(),
}));
vi.mock("@/lib/alert-notifications", () => ({ createAlertNotificationsForMatches: vi.fn() }));
vi.mock("@/lib/sale-market-estimates", () => ({ getPrecomputedMarketEstimate: mocks.estimate }));

import { alertMatchesSale } from "@/lib/alerts";
import { MARKET_GAP_MAX_DISCOUNT_PCT, MARKET_GAP_MIN_DISCOUNT_PCT } from "@/lib/market-gap";
import { buildAlertMatchSummary, estimateMarketDiscountPct } from "./alert-matches";

const sale = {
  id: "sale-1",
  city: "Bordeaux",
  department: "33",
  postal_code: "33000",
  address: "1 rue Sainte-Catherine",
  property_type: "apartment",
  app_surface_m2: 60,
  app_surface_kind: "habitable",
  starting_price_eur: 60_000,
  occupancy_status: "vacant",
} as unknown as AuctionSale;

function withEstimate(estimatedValueEur: number | null, extra: Record<string, unknown> = {}) {
  mocks.estimate.mockResolvedValue({ actionable: true, estimatedValueEur, ...extra });
}

const withStartingPrice = (price: number) =>
  ({ ...sale, starting_price_eur: price }) as unknown as AuctionSale;

beforeEach(() => mocks.estimate.mockReset());

describe("estimateMarketDiscountPct : garde-fou « écart non significatif »", () => {
  it("rend l'écart entier d'une décote plausible, comme la fiche", async () => {
    withEstimate(100_000); // 60 000 € pour 100 000 € de valeur : 40 %
    expect(await estimateMarketDiscountPct(sale)).toBe(40);
  });

  it("garde les écarts aux bornes de la plage", async () => {
    withEstimate(100_000);
    const atMax = 100_000 * (1 - MARKET_GAP_MAX_DISCOUNT_PCT / 100);
    const atMin = 100_000 * (1 - MARKET_GAP_MIN_DISCOUNT_PCT / 100);
    expect(await estimateMarketDiscountPct(withStartingPrice(atMax))).toBe(
      MARKET_GAP_MAX_DISCOUNT_PCT,
    );
    expect(await estimateMarketDiscountPct(withStartingPrice(atMin))).toBe(
      MARKET_GAP_MIN_DISCOUNT_PCT,
    );
  });

  it("rend null pour un écart de 85 % : pas de pourcentage à comparer ni à afficher", async () => {
    withEstimate(400_000); // 60 000 € pour 400 000 € : 85 %
    expect(await estimateMarketDiscountPct(sale)).toBeNull();
  });

  it("rend null pour une mise à prix très au-dessus de la valeur", async () => {
    withEstimate(30_000); // 60 000 € pour 30 000 € : -100 %
    expect(await estimateMarketDiscountPct(sale)).toBeNull();
  });

  it("applique le garde-fou aussi à la valeur reconstruite depuis le prix au m²", async () => {
    withEstimate(null, { medianPricePerM2: 6_667 }); // 60 m² : ~400 000 €
    expect(await estimateMarketDiscountPct(sale)).toBeNull();
    withEstimate(null, { medianPricePerM2: 1_667 }); // ~100 000 € : 40 %
    expect(await estimateMarketDiscountPct(sale)).toBe(40);
  });

  it("rend null sans estimation exploitable ou sans mise à prix", async () => {
    mocks.estimate.mockResolvedValue({ actionable: false, estimatedValueEur: 100_000 });
    expect(await estimateMarketDiscountPct(sale)).toBeNull();
    withEstimate(100_000);
    expect(await estimateMarketDiscountPct(withStartingPrice(0))).toBeNull();
  });
});

describe("alerte « décote minimale » sur un écart aberrant", () => {
  const alert = { min_market_discount_pct: 20 } as unknown as UserAlert;

  it("ne correspond pas, alors que la décote brute de 85 % dépasserait le seuil", async () => {
    withEstimate(400_000);
    const marketDiscountPct = await estimateMarketDiscountPct(sale);
    expect(alertMatchesSale(alert, sale, { marketDiscountPct }).matches).toBe(false);
  });

  it("correspond pour une décote plausible au-dessus du seuil", async () => {
    withEstimate(100_000);
    const marketDiscountPct = await estimateMarketDiscountPct(sale);
    expect(alertMatchesSale(alert, sale, { marketDiscountPct }).matches).toBe(true);
  });

  it("ne met aucun pourcentage dans le résumé", async () => {
    withEstimate(400_000);
    const summary = buildAlertMatchSummary({
      alert: {
        id: "alert-1",
        name: "Décote",
        min_market_discount_pct: 20,
      } as unknown as UserAlert,
      sale,
      reasons: [],
      marketDiscountPct: await estimateMarketDiscountPct(sale),
      matchedAt: "2026-10-15T08:00:00.000Z",
    });
    expect(summary.marketDiscountPct).toBeNull();
  });
});

describe("décote minimale : même règle d'occupation que la bande publique", () => {
  const alert = { min_market_discount_pct: 20 } as unknown as UserAlert;
  const withOccupancy = (occupancy: string | null) =>
    ({ ...sale, occupancy_status: occupancy }) as unknown as AuctionSale;

  it.each(["occupied", "rented", "owner_occupied", "unknown", "", null])(
    "ne donne aucun écart pour une occupation %s, même avec 40 % de décote brute",
    async (occupancy) => {
      withEstimate(100_000); // 60 000 € pour 100 000 € : 40 % pour un bien libre
      const marketDiscountPct = await estimateMarketDiscountPct(withOccupancy(occupancy));
      expect(marketDiscountPct).toBeNull();
      expect(alertMatchesSale(alert, sale, { marketDiscountPct }).matches).toBe(false);
    },
  );

  it.each(["vacant", "libre", "Inoccupé"])("donne l'écart d'un bien %s", async (occupancy) => {
    withEstimate(100_000);
    expect(await estimateMarketDiscountPct(withOccupancy(occupancy))).toBe(40);
  });

  it("ne lit même pas l'estimation d'un bien dont l'écart est retenu", async () => {
    withEstimate(100_000);
    await estimateMarketDiscountPct(withOccupancy("occupied"));
    expect(mocks.estimate).not.toHaveBeenCalled();
  });
});
