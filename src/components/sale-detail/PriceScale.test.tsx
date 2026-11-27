// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AuctionScenariosResponse } from "@/lib/auction-scenarios";
import { PriceScale } from "@/components/sale-detail/PriceScale";
import { usualAuctionRange } from "@/components/sale-detail/use-usual-auction-range";

function response(overrides: Partial<AuctionScenariosResponse> = {}): AuctionScenariosResponse {
  return {
    courtName: "tribunal judiciaire de Bordeaux",
    startingPrice: 100_000,
    propertyType: "house",
    scenarios: {
      status: "ok",
      band: 4,
      courtSample: 42,
      nationalSample: 900,
      basis: "court",
      reliability: "good",
      priceScope: "court",
      scenarios: [],
      ratioQuartiles: { q25: 1.2, q50: 1.6, q75: 2.1 },
    },
    unavailable: null,
    dataAsOf: null,
    history: { licitor: null, dvf: null },
    ...overrides,
  };
}

afterEach(cleanup);

describe("usualAuctionRange", () => {
  it("applies the quartiles of the comparable sales to the starting price", () => {
    expect(usualAuctionRange(response())).toEqual({
      low: 120_000,
      high: 210_000,
      median: 160_000,
      scope: "court",
      courtName: "tribunal judiciaire de Bordeaux",
    });
  });

  it("gives no range without figures", () => {
    const base = response();
    expect(usualAuctionRange(undefined)).toBeNull();
    expect(usualAuctionRange(response({ startingPrice: null }))).toBeNull();
    expect(
      usualAuctionRange(response({ scenarios: { ...base.scenarios!, status: "insufficient" } })),
    ).toBeNull();
    expect(
      usualAuctionRange(
        response({
          scenarios: { ...base.scenarios!, ratioQuartiles: { q25: null, q50: 1.6, q75: 2.1 } },
        }),
      ),
    ).toBeNull();
  });
});

describe("PriceScale", () => {
  it("places the usual auction prices on the same axis and says what they are", () => {
    render(
      <PriceScale
        startingPrice={100_000}
        startLabel="Mise à prix"
        ceiling={150_000}
        value={260_000}
        range={null}
        usual={usualAuctionRange(response())}
      />,
    );

    expect(screen.getByTestId("price-scale-usual")).toBeTruthy();
    const note = screen.getByTestId("price-scale-usual-note").textContent ?? "";
    expect(note).toContain("du tribunal judiciaire de Bordeaux");
    expect(note).toMatch(/120\s000\s€/);
    expect(note).toMatch(/210\s000\s€/);
    expect(note).toContain("une vente comparable sur deux");
    expect(note).toContain("une sur quatre au-dessus, une sur quatre en dessous");
    expect(note).toContain("ce n’est pas une prévision.");
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain(
      "prix habituellement atteints",
    );
  });

  it("stays as before without figures of the court", () => {
    render(
      <PriceScale
        startingPrice={100_000}
        startLabel="Mise à prix"
        ceiling={150_000}
        value={null}
        range={null}
      />,
    );

    expect(screen.queryByTestId("price-scale-usual")).toBeNull();
    expect(screen.queryByTestId("price-scale-usual-note")).toBeNull();
  });
});
