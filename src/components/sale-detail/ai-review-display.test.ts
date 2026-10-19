import { describe, expect, it } from "vitest";
import type { AiReviewProjectionReadModel } from "@/lib/ai-review-guard";
import type { AuctionSale } from "@/lib/types";
import { saleForAiReviewDisplay } from "./ai-review-display";

const sale = {
  id: "sale-1",
  title: "Appartement à Lyon",
  property_type: "apartment",
  city: "Lyon",
  postal_code: "69003",
  address: "12 rue de la République",
  tribunal_city: "Lyon",
  sale_date: "2026-12-10T14:00:00Z",
  starting_price_eur: 80000,
  parking_count: 1,
} as unknown as AuctionSale;

function projection(
  field_key: string,
  blocking: boolean,
  extra: Partial<AiReviewProjectionReadModel> = {},
): AiReviewProjectionReadModel {
  return {
    auction_sale_id: "sale-1",
    field_key,
    review_state: blocking ? "unverified" : "resolved",
    citation_status: blocking ? "unverified" : "verified",
    is_publishable: !blocking,
    source_name: null,
    source_url: null,
    ...extra,
  };
}

describe("saleForAiReviewDisplay", () => {
  it("returns the sale untouched when the review is disabled", () => {
    expect(saleForAiReviewDisplay(sale, null, "disabled")).toBe(sale);
  });

  it("masks the city and the address of an unlocked sale whose city row is blocking", () => {
    // What /api/sales/ai-review returns for an unlocked sale: the blocking row of a field outside
    // the bid ceiling is kept (the unlocked view exposes the address), publishable rows are dropped.
    const guarded = saleForAiReviewDisplay(
      sale,
      [projection("property.city", true), projection("property.parking_count", false)],
      "ready",
    );

    expect(guarded.city).toBeNull();
    expect(guarded.postal_code).toBeNull();
    expect(guarded.address).toBeNull();
    expect(guarded.tribunal_city).toBeNull();
    expect(guarded.title).toContain("Localisation à confirmer");
    expect(guarded.parking_count).toBe(1);
    expect(guarded.starting_price_eur).toBe(80000);
  });

  it("masks the sale date when its row is blocking", () => {
    const guarded = saleForAiReviewDisplay(sale, [projection("sale.sale_date", true)], "ready");
    expect(guarded.sale_date).toBeNull();
    expect(guarded.city).toBe("Lyon");
  });

  it("keeps the address when the city row is publishable", () => {
    const guarded = saleForAiReviewDisplay(sale, [projection("property.city", false)], "ready");
    expect(guarded.address).toBe("12 rue de la République");
    expect(guarded.city).toBe("Lyon");
  });
});
