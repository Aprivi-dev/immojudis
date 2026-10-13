import { describe, expect, it } from "vitest";
import {
  buildCeilingHypotheses,
  DEFAULT_PRELIMINARY_FEES,
  occupationCaseForStatus,
  preliminaryFeesFromSale,
} from "@/lib/bid-ceiling-defaults";
import { computeCeilingPlan } from "@/lib/bid-ceiling-engine";
import type { MarketEstimate } from "@/lib/market.server";
import type { AuctionSale } from "@/lib/types";

const sale = {
  id: "sale-1",
  department: "34",
  property_type: "apartment",
  occupancy_status: "occupied",
  starting_price_eur: 30_000,
  app_surface_m2: 84,
  app_surface_kind: "habitable",
  description: "Appartement de 84 m². Les frais préalables s’élèvent à 4 250,50 € TTC.",
} as unknown as AuctionSale;

const estimate = {
  actionable: true,
  estimatedValueEur: 182_037,
  medianPricePerM2: 2_167,
  p75PricePerM2: 2_447,
  qualityLabel: "forte",
  sampleSize: 7,
} as unknown as MarketEstimate;

describe("occupationCaseForStatus", () => {
  it.each([
    ["vacant", "libre"],
    ["rented", "loue"],
    ["tenant_occupied", "loue"],
    ["owner_occupied", "occupe"],
    ["occupied", "occupe"],
    ["squatted", "squat"],
    [null, "inconnu"],
    ["unknown", "inconnu"],
  ])("maps %s to %s", (status, expected) => {
    expect(occupationCaseForStatus(status)).toBe(expected);
  });
});

describe("preliminaryFeesFromSale", () => {
  it("reads the preliminary costs written in the listing", () => {
    expect(preliminaryFeesFromSale(sale)).toBe(4_251);
  });

  it("ignores a listing without them", () => {
    expect(preliminaryFeesFromSale({ ...sale, description: "Mise à prix : 30 000 €" })).toBeNull();
  });
});

describe("buildCeilingHypotheses", () => {
  it("starts from the sale facts and the market estimate", () => {
    const h = buildCeilingHypotheses(sale, estimate);

    expect(h.project).toBe("habiter");
    expect(h.profile).toBe("equilibre");
    expect(h.surface).toBe(84);
    expect(h.value).toMatchObject({ amount: 182_037, source: "estimation", upperAmount: 205_548 });
    expect(h.occupation.case).toBe("occupe");
    expect(h.fees.fpt).toBe(4_251);
    expect(h.feesSource.fpt).toBe("document");
    expect(h.carrying.monthlyCharges).toBe(210);
  });

  it("lets the user's choices win and falls back to prudent preliminary costs", () => {
    const h = buildCeilingHypotheses({ ...sale, description: null }, estimate, {
      project: "louer",
      manualPricePerM2: 2_500,
      occupation: "libre",
    });

    expect(h.value).toMatchObject({ amount: 210_000, source: "saisie" });
    expect(h.occupation.case).toBe("libre");
    expect(h.fees.fpt).toBe(DEFAULT_PRELIMINARY_FEES);
    expect(h.feesSource.fpt).toBe("defaut");
  });

  it("falls back to the department reference rent, and treats a rent of 0 as not entered", () => {
    expect(buildCeilingHypotheses(sale, estimate).rent).toMatchObject({
      monthly: 84 * 13,
      source: "estime",
    });
    expect(buildCeilingHypotheses(sale, estimate, { monthlyRent: 900 }).rent).toMatchObject({
      monthly: 900,
      source: "saisi",
    });
    expect(buildCeilingHypotheses(sale, estimate, { monthlyRent: 0 }).rent).toMatchObject({
      monthly: 84 * 13,
      source: "estime",
    });
  });

  it("has no reference rent outside the covered departments", () => {
    const uncovered = { ...sale, department: "23" } as unknown as AuctionSale;

    expect(buildCeilingHypotheses(uncovered, estimate).rent).toMatchObject({
      monthly: null,
      source: "absent",
    });
    expect(buildCeilingHypotheses(uncovered, estimate, { monthlyRent: 0 }).rent).toMatchObject({
      monthly: null,
      source: "absent",
    });
  });

  it("keeps the built surface of a house sold with a terrain, so the ceiling is computed", () => {
    const house = {
      ...sale,
      title: "Maison avec terrain de 500 m²",
      property_type: "house",
      app_surface_m2: 90,
      land_surface_m2: 500,
    } as unknown as AuctionSale;
    const h = buildCeilingHypotheses(house, estimate);

    expect(h.surface).toBe(90);
    expect(computeCeilingPlan(h)).toMatchObject({ available: true, reachable: true });
  });

  it("has no value without an actionable estimate", () => {
    const h = buildCeilingHypotheses(sale, { ...estimate, actionable: false } as MarketEstimate);

    expect(h.value.source).toBe("absente");
  });
});
