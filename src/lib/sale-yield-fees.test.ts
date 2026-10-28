import { describe, expect, it, vi } from "vitest";
import { buildCeilingHypotheses } from "@/lib/bid-ceiling-defaults";
import { feeRegimeForSale } from "@/lib/fee-regime";
import { estimateSaleGrossYieldPct } from "@/lib/geo";
import { computeAcquisitionCosts } from "@/lib/profitability";
import { defaultRentPerM2 } from "@/lib/rent-reference";
import { saleYieldFeeOptions } from "@/lib/sale-yield-fees";
import type { AuctionSale } from "@/lib/types";

vi.mock("@/lib/mapbox", () => ({ getMapboxAccessToken: () => "public-test-token" }));

function sale(overrides: Record<string, unknown> = {}): AuctionSale {
  return {
    id: "sale-yield",
    department: "33",
    property_type: "apartment",
    app_surface_m2: 50,
    starting_price_eur: 60_000,
    occupancy_status: "vacant",
    ...overrides,
  } as unknown as AuctionSale;
}

const TRIBUNAL = sale({ sale_venue_type: "tribunal" });
const CANDLE = sale({
  sale_venue_type: "notary",
  sale_conditions: { procedure: "notarial_auction", price_nature: "mise_a_prix" },
});
const ONLINE = sale({
  sale_venue_type: "notary",
  sale_conditions: {
    procedure: "online_tender",
    price_nature: "first_offer_possible",
    negotiation_fee_payer: "ACQUEREUR",
    negotiation_fee_rate: 0.05,
    advertising_fees_eur: 900,
  },
});

/** Le rendement brut recalculé à la main avec des frais donnés. */
function yieldWith(target: AuctionSale, fees: object): number {
  const total = computeAcquisitionCosts({ price: 60_000, department: "33", ...fees }).totalCost;
  return ((50 * (defaultRentPerM2("33") as number) * 12) / total) * 100;
}

describe("frais du rendement brut selon le régime de la vente", () => {
  it("tribunal : frais du tribunal par défaut (comportement inchangé)", () => {
    expect(saleYieldFeeOptions(TRIBUNAL)).toEqual({});
    expect(estimateSaleGrossYieldPct(TRIBUNAL, 50)).toBeCloseTo(yieldWith(TRIBUNAL, {}), 8);
  });

  it("régime inconnu ou vente domaniale : frais du tribunal, comme le plafond sans régime", () => {
    expect(saleYieldFeeOptions(sale({ sale_venue_type: "domaine" }))).toEqual({});
    expect(saleYieldFeeOptions(sale())).toEqual({});
  });

  it("vente à la bougie : barème du notaire, frais d'organisation, ni frais préalables ni avocat", () => {
    const options = saleYieldFeeOptions(CANDLE);
    expect(options).toMatchObject({ fpt: 0, lawyerFees: 0, organizationFeeRate: 0.02 });
    expect(estimateSaleGrossYieldPct(CANDLE, 50)).toBeCloseTo(yieldWith(CANDLE, options), 8);
    // Sans les 5 000 € de frais préalables du tribunal, le rendement est plus élevé.
    expect(estimateSaleGrossYieldPct(CANDLE, 50)!).toBeGreaterThan(
      estimateSaleGrossYieldPct(TRIBUNAL, 50)!,
    );
  });

  it("vente interactive : gré à gré, honoraires de négociation et publicité de l'annonce", () => {
    const options = saleYieldFeeOptions(ONLINE);
    expect(options).toMatchObject({
      fpt: 0,
      lawyerFees: 0,
      negotiationFeeRate: 0.05,
      advertisingFees: 900,
    });
    expect(estimateSaleGrossYieldPct(ONLINE, 50)).toBeCloseTo(yieldWith(ONLINE, options), 8);
  });

  it("vente interactive dont le vendeur paie les honoraires : aucun honoraire de négociation", () => {
    const sellerPays = sale({
      ...ONLINE,
      sale_conditions: { ...(ONLINE.sale_conditions as object), negotiation_fee_payer: "VENDEUR" },
    });
    expect(saleYieldFeeOptions(sellerPays).negotiationFeeRate).toBe(0);
  });

  it.each([
    ["tribunal", TRIBUNAL],
    ["bougie", CANDLE],
    ["vente interactive", ONLINE],
  ])("%s : mêmes frais que le rapport (hypothèses du plafond)", (_name, target) => {
    const regime = feeRegimeForSale(target);
    const fees = buildCeilingHypotheses(target, null, {}, regime ?? undefined).fees;
    const report = computeAcquisitionCosts({ price: 60_000, ...fees, works: 0 });
    const yieldSide = computeAcquisitionCosts({
      price: 60_000,
      department: "33",
      ...saleYieldFeeOptions(target),
    });
    expect(yieldSide.totalCost).toBeCloseTo(report.totalCost, 6);
  });
});
