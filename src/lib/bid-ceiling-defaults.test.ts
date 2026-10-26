import { describe, expect, it } from "vitest";
import {
  buildCeilingHypotheses,
  DEFAULT_PRELIMINARY_FEES,
  occupationCaseForStatus,
  preliminaryFeesFromSale,
} from "@/lib/bid-ceiling-defaults";
import { computeCeilingPlan } from "@/lib/bid-ceiling-engine";
import type { MarketEstimate } from "@/lib/market.server";
import type { RentReference } from "@/lib/rent-reference";
import { DEFAULTS } from "@/lib/profitability";
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

const anilReference = (rentPerM2: number, source = "anil_commune" as const) => ({
  rentPerM2,
  source,
  reliability: "reliable" as const,
  segment: "apt_all" as const,
  communeCode: "34172",
  lowPerM2: null,
  highPerM2: null,
  observations: 500,
  vintage: 2025,
  sourceUpdatedOn: "2025-12-11",
});

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

describe("DEFAULT_PRELIMINARY_FEES", () => {
  it("is the one default of the fee simulator and the ceiling: 5 000 €", () => {
    expect(DEFAULT_PRELIMINARY_FEES).toBe(5_000);
    expect(DEFAULTS.fpt).toBe(DEFAULT_PRELIMINARY_FEES);
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

  it("marks the preliminary fees the user entered as entered, whatever the listing says", () => {
    const entered = buildCeilingHypotheses(sale, estimate, { fpt: 6_000 });
    expect(entered.fees.fpt).toBe(6_000);
    expect(entered.feesSource.fpt).toBe("saisie");

    const read = buildCeilingHypotheses(sale, estimate);
    expect(read.feesSource.fpt).toBe("document");
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

  it("prefers the ANIL rent of the commune, and keeps its source for the screen", () => {
    const reference = anilReference(15);
    const hypotheses = buildCeilingHypotheses(sale, estimate, {}, null, reference);

    expect(hypotheses.rent).toMatchObject({
      monthly: 84 * 15,
      source: "estime",
      reference: { source: "anil_commune", vintage: 2025, sourceUpdatedOn: "2025-12-11" },
    });
    // A typed rent keeps priority and drops the reference.
    const typed = buildCeilingHypotheses(sale, estimate, { monthlyRent: 900 }, null, reference);
    expect(typed.rent).toMatchObject({ monthly: 900, source: "saisi" });
    expect(typed.rent.reference).toBeUndefined();
  });

  it("keeps the default property tax on the historical department base, whatever ANIL rent is shown", () => {
    const historical = Math.round(Math.round(84 * 13) * 12 * 0.08); // department 34: 13 EUR/m2
    for (const reference of [null, anilReference(15), anilReference(40), anilReference(4)]) {
      const hypotheses = buildCeilingHypotheses(sale, estimate, {}, null, reference);
      expect(hypotheses.carrying.annualPropertyTax).toBe(historical);
    }
    // Without any department rent, the base is the surface, as before.
    const uncovered = { ...sale, department: "23" } as unknown as AuctionSale;
    expect(
      buildCeilingHypotheses(uncovered, estimate, {}, null, anilReference(30)).carrying
        .annualPropertyTax,
    ).toBe(84 * 12);
    // What the user types still wins.
    expect(
      buildCeilingHypotheses(sale, estimate, { annualPropertyTax: 700 }, null, anilReference(15))
        .carrying.annualPropertyTax,
    ).toBe(700);
  });

  it("gives the « habiter » ceiling with or without an ANIL rent, and the « louer » one only the rent", () => {
    const maxBid = (project: "habiter" | "revendre" | "louer", reference: RentReference | null) =>
      computeCeilingPlan(buildCeilingHypotheses(sale, estimate, { project }, null, reference))
        .maxBid;

    for (const reference of [anilReference(5), anilReference(15), anilReference(40)]) {
      expect(maxBid("habiter", reference)).toBe(maxBid("habiter", null));
      expect(maxBid("revendre", reference)).toBe(maxBid("revendre", null));
    }
    // A low ANIL rent makes the yield bind in the « louer » project: that project does follow the rent.
    expect(maxBid("louer", anilReference(2))).toBeLessThan(maxBid("louer", null));
  });

  it("subtracts the recoverable charges the user types from the estimated rent, never an invented amount", () => {
    const reference = anilReference(15);
    const empty = buildCeilingHypotheses(sale, estimate, {}, null, reference);
    expect(empty.rent.recoverableCharges).toBeNull();
    expect(empty.rent.monthly).toBe(84 * 15);

    const withCharges = buildCeilingHypotheses(
      sale,
      estimate,
      { recoverableCharges: 120 },
      null,
      reference,
    );
    expect(withCharges.rent).toMatchObject({ monthly: 84 * 15 - 120, recoverableCharges: 120 });
    // 0 is not an amount; a typed rent is already « hors charges »: the charges leave it alone.
    expect(
      buildCeilingHypotheses(sale, estimate, { recoverableCharges: 0 }, null, reference).rent
        .monthly,
    ).toBe(84 * 15);
    expect(
      buildCeilingHypotheses(
        sale,
        estimate,
        { monthlyRent: 900, recoverableCharges: 120 },
        null,
        reference,
      ).rent.monthly,
    ).toBe(900);
    // Charges larger than the rent leave no rent, not a negative one.
    expect(
      buildCeilingHypotheses(sale, estimate, { recoverableCharges: 5_000 }, null, reference).rent,
    ).toMatchObject({ monthly: null, source: "absent" });
  });

  it("flags a gross yield, charges included, only for an ANIL rent without recoverable charges", () => {
    const anil = anilReference(15);
    const flag = (
      choices: Parameters<typeof buildCeilingHypotheses>[2],
      ref: RentReference | null,
    ) => buildCeilingHypotheses(sale, estimate, choices, null, ref).rent.chargesIncluded;

    expect(flag({}, anil)).toBe(true);
    expect(flag({ recoverableCharges: 100 }, anil)).toBeUndefined();
    expect(flag({ monthlyRent: 900 }, anil)).toBeUndefined();
    expect(flag({}, null)).toBeUndefined(); // department rent: not charges included
    expect(flag({}, { ...anil, source: "anil_maille" })).toBe(true);
  });

  it("gives no rent to a property that is not a dwelling, ANIL reference or not", () => {
    for (const type of [
      "land",
      "parking",
      "garage",
      "local commercial",
      "bureau",
      "building",
      "immeuble",
    ]) {
      const item = { ...sale, property_type: type } as unknown as AuctionSale;
      for (const reference of [null, anilReference(15)]) {
        expect(buildCeilingHypotheses(item, estimate, {}, null, reference).rent).toMatchObject({
          monthly: null,
          source: "absent",
        });
      }
    }
    // A farm, a château, a mas, a property, a bastide are houses.
    for (const type of ["ferme", "château", "mas", "propriété", "bastide", "longère", "pavillon"]) {
      const item = { ...sale, property_type: type } as unknown as AuctionSale;
      expect(buildCeilingHypotheses(item, estimate, {}, null, null).rent.source).toBe("estime");
    }
  });

  it("serves an ANIL rent to a department the old table did not cover", () => {
    const uncovered = { ...sale, department: "23" } as unknown as AuctionSale;

    expect(
      buildCeilingHypotheses(uncovered, estimate, {}, null, anilReference(8)).rent,
    ).toMatchObject({ monthly: 84 * 8, source: "estime" });
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
