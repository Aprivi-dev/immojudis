import { describe, expect, it } from "vitest";
import {
  buildCashPlan,
  ceilingConfidence,
  ceilingsByWorks,
  computeCeilingPlan,
  evaluateBid,
  yieldNoun,
  type CeilingHypotheses,
} from "@/lib/bid-ceiling-engine";

function hypotheses(overrides: Partial<CeilingHypotheses> = {}): CeilingHypotheses {
  return {
    project: "habiter",
    profile: "equilibre",
    customMarginPct: null,
    surface: 80,
    startingPrice: 100_000,
    value: {
      amount: 200_000,
      source: "estimation",
      upperAmount: 230_000,
      reliability: "forte",
      sampleSize: 30,
      surfaceEstimated: false,
    },
    works: { key: "aucun", amount: 0, contingencyPct: 10, months: 0 },
    occupation: { case: "libre", releaseMonths: 12, releaseCost: 3_000, rentedDiscountPct: 10 },
    carrying: {
      monthlyCharges: 200,
      annualPropertyTax: 1_200,
      monthlyInsurance: 15,
      financingRatePct: 4,
      resaleMonths: 4,
    },
    fees: { fpt: 5_000, lawyerFees: 1_500, department: "33", registrationRate: 0.0632 },
    feesSource: { fpt: "defaut", consignation: "regle" },
    rent: { monthly: 900, source: "estime", vacancyPct: 5, nonRecoverablePct: 7 },
    resale: { sellingCostsPct: 5 },
    consignation: null,
    ...overrides,
  };
}

describe("computeCeilingPlan", () => {
  it("counts down from the value to the ceiling (worked example)", () => {
    // 200 000 € − 10 % = 180 000 € de coût total. Frais à l'enchère P :
    // émoluments TTC + droits 6,32 % et CSI sur P (les frais préalables sont hors base) + 5 000 € + 5 000 € + 1 500 €.
    const h = hypotheses();
    const plan = computeCeilingPlan(h);

    expect(plan.budget).toBe(180_000);
    expect(plan.maxBid).toBe(159_500);
    expect(evaluateBid(h, plan, plan.maxBid).totalCost).toBeLessThanOrEqual(180_000);
    expect(evaluateBid(h, plan, plan.maxBid + 500).totalCost).toBeGreaterThan(180_000);
    expect(plan.steps.at(0)).toMatchObject({ key: "value", amount: 200_000 });
    expect(plan.steps.at(-1)).toMatchObject({ key: "ceiling", amount: 159_500 });
    expect(plan.startingPriceGap).toBe(59_500);
  });

  it("charges the release of an occupied property and the months it takes", () => {
    const free = computeCeilingPlan(hypotheses());
    const occupied = computeCeilingPlan(
      hypotheses({
        occupation: {
          case: "occupe",
          releaseMonths: 12,
          releaseCost: 3_000,
          rentedDiscountPct: 10,
        },
      }),
    );

    expect(occupied.releaseCost).toBe(3_000);
    expect(occupied.carryMonths).toBe(12);
    expect(occupied.carryingFixed).toBe(12 * (200 + 100 + 15));
    expect(occupied.maxBid).toBeLessThan(free.maxBid - 9_000);
    expect(occupied.steps.map((step) => step.key)).toEqual(
      expect.arrayContaining(["release", "carrying"]),
    );
  });

  it("treats an unconfirmed occupation as a release, by prudence", () => {
    const plan = computeCeilingPlan(
      hypotheses({
        occupation: {
          case: "inconnu",
          releaseMonths: 12,
          releaseCost: 3_000,
          rentedDiscountPct: 10,
        },
      }),
    );

    expect(plan.releaseCost).toBe(3_000);
    expect(plan.steps.find((step) => step.key === "release")?.detail).toMatch(/non confirmée/);
  });

  it("adds a contingency to scenario works but not to a user quote", () => {
    const scenario = computeCeilingPlan(
      hypotheses({
        works: { key: "rafraichissement", amount: 40_000, contingencyPct: 10, months: 2 },
      }),
    );
    const quote = computeCeilingPlan(
      hypotheses({ works: { key: "devis", amount: 40_000, contingencyPct: 10, months: 3 } }),
    );

    expect(scenario.worksTotal).toBe(44_000);
    expect(scenario.worksContingency).toBe(4_000);
    expect(quote.worksTotal).toBe(40_000);
  });

  it("caps the after-works value at the upper quartile of local sales", () => {
    const plan = computeCeilingPlan(
      hypotheses({
        works: { key: "premium", amount: 148_000, contingencyPct: 10, months: 6 },
        value: { ...hypotheses().value, upperAmount: 210_000 },
      }),
    );

    expect(plan.valueAfterWorks).toBe(210_000);
  });

  it("lets the rent limit the ceiling of a rental project", () => {
    const plan = computeCeilingPlan(hypotheses({ project: "louer" }));

    expect(plan.binding).toBe("rendement");
    expect(plan.yieldBudget).toBeLessThan(plan.valueBudget);
    expect(plan.steps.some((step) => step.key === "yield")).toBe(true);
  });

  it("words the yield step as gross, charges included, for an ANIL rent without recoverable charges", () => {
    const detail = (rent: Partial<CeilingHypotheses["rent"]>) =>
      computeCeilingPlan(
        hypotheses({
          project: "louer",
          rent: { monthly: 900, source: "estime", vacancyPct: 5, nonRecoverablePct: 7, ...rent },
        }),
      ).steps.find((step) => step.key === "yield")?.detail;

    expect(detail({ chargesIncluded: true })).toContain("rendement brut, charges comprises de");
    expect(detail({ chargesIncluded: true })).not.toMatch(/rendement net/);
    expect(detail({})).toContain("rendement net de");
    expect(yieldNoun({ rent: { chargesIncluded: true } as CeilingHypotheses["rent"] })).toBe(
      "rendement brut, charges comprises",
    );
  });

  it.each([null, 0])("flags a rental project whose rent is %s", (monthly) => {
    const plan = computeCeilingPlan(
      hypotheses({
        project: "louer",
        rent: { monthly, source: "absent", vacancyPct: 5, nonRecoverablePct: 7 },
      }),
    );

    expect(plan.rentMissing).toBe(true);
    expect(plan.yieldBudget).toBeNull();
    expect(plan.binding).toBe("valeur");
    // Sans loyer, le plafond ne repose que sur la valeur : même montant que pour « Habiter ».
    expect(plan.maxBid).toBeGreaterThan(0);
  });

  it("does not flag a missing rent outside a rental project, nor a known rent", () => {
    const noRent = {
      monthly: null,
      source: "absent" as const,
      vacancyPct: 5,
      nonRecoverablePct: 7,
    };

    expect(computeCeilingPlan(hypotheses({ project: "habiter", rent: noRent })).rentMissing).toBe(
      false,
    );
    expect(computeCeilingPlan(hypotheses({ project: "revendre", rent: noRent })).rentMissing).toBe(
      false,
    );
    expect(computeCeilingPlan(hypotheses({ project: "louer" })).rentMissing).toBe(false);
  });

  it("flags a missing rent even when the plan is unavailable for another reason", () => {
    const plan = computeCeilingPlan(
      hypotheses({
        project: "louer",
        value: { ...hypotheses().value, amount: null },
        rent: { monthly: null, source: "absent", vacancyPct: 5, nonRecoverablePct: 7 },
      }),
    );

    expect(plan.available).toBe(false);
    expect(plan.rentMissing).toBe(true);
  });

  it("keeps a resale margin and selling costs for a resale project", () => {
    const plan = computeCeilingPlan(hypotheses({ project: "revendre" }));

    expect(plan.marginPct).toBe(15);
    expect(plan.sellingCosts).toBe(10_000);
    expect(plan.carryMonths).toBe(4);
    const evaluation = evaluateBid(hypotheses({ project: "revendre" }), plan, plan.maxBid);
    expect(evaluation.resaleProfit).toBeGreaterThanOrEqual(plan.marginAmount);
  });

  it("adds prudence when the value rests on few sales or an estimated surface", () => {
    const plan = computeCeilingPlan(
      hypotheses({
        value: {
          ...hypotheses().value,
          reliability: "fragile",
          sampleSize: 5,
          surfaceEstimated: true,
        },
      }),
    );

    expect(plan.dataMarginPct).toBe(5);
    expect(plan.marginAmount).toBe(30_000);
  });

  it("is unavailable without a market value", () => {
    const plan = computeCeilingPlan(
      hypotheses({ value: { ...hypotheses().value, amount: null, source: "absente" } }),
    );

    expect(plan.available).toBe(false);
    expect(plan.reason).toMatch(/Valeur de marché/);
  });

  it("returns no ceiling when costs already exceed the budget", () => {
    const plan = computeCeilingPlan(
      hypotheses({ works: { key: "devis", amount: 190_000, contingencyPct: 10, months: 3 } }),
    );

    expect(plan.maxBid).toBe(0);
    expect(plan.reachable).toBe(false);
  });
});

describe("ceilingsByWorks", () => {
  it("lowers the ceiling as the works grow", () => {
    const rows = ceilingsByWorks(hypotheses());

    expect(rows.map((row) => row.key)).toEqual(["aucun", "rafraichissement", "confort", "premium"]);
    const bids = rows.map((row) => row.plan.maxBid);
    expect(bids[0]).toBeGreaterThan(bids[1]);
    expect(bids[1]).toBeGreaterThan(bids[2]);
  });
});

describe("buildCashPlan", () => {
  it("asks for 10 % of the starting price, 3 000 € minimum, before the hearing", () => {
    const h = hypotheses({ startingPrice: 20_000 });
    const plan = computeCeilingPlan(h);
    const cash = buildCashPlan(h, plan, 50_000);

    expect(cash[0]).toMatchObject({ label: "Consignation", amount: 3_000 });
    expect(cash.find((step) => step.label === "Frais préalables")?.amount).toBe(5_000);
    expect(cash.find((step) => step.label === "Solde du prix et droits")?.amount).toBeGreaterThan(
      47_000,
    );
  });
});

describe("ceilingConfidence", () => {
  it("lists what remains to confirm", () => {
    const confidence = ceilingConfidence(
      hypotheses({
        occupation: {
          case: "inconnu",
          releaseMonths: 12,
          releaseCost: 3_000,
          rentedDiscountPct: 10,
        },
      }),
    );

    expect(confidence.label).toBe("À consolider");
    expect(confidence.gaps).toEqual(
      expect.arrayContaining([
        "occupation non confirmée",
        "frais préalables à lire dans le cahier des conditions de vente",
      ]),
    );
  });
});

describe("ceilingConfidence and preliminary fees", () => {
  it("is never « Solide » while the preliminary fees are a default value", () => {
    const confidence = ceilingConfidence(hypotheses());

    expect(confidence.score).toBe(88);
    expect(confidence.label).toBe("À consolider");
    expect(confidence.gaps).toEqual([
      "frais préalables à lire dans le cahier des conditions de vente",
    ]);
  });

  it("is « Solide » when the user entered the preliminary fees, with no gap", () => {
    const confidence = ceilingConfidence(
      hypotheses({ feesSource: { fpt: "saisie", consignation: "regle" } }),
    );

    expect(confidence.score).toBe(100);
    expect(confidence.label).toBe("Solide");
    expect(confidence.gaps).toEqual([]);
  });

  it("is « Solide » once the preliminary fees are read in the listing", () => {
    const confidence = ceilingConfidence(
      hypotheses({ feesSource: { fpt: "document", consignation: "regle" } }),
    );

    expect(confidence.score).toBe(100);
    expect(confidence.label).toBe("Solide");
    expect(confidence.gaps).toEqual([]);
  });
});

describe("maxWorksAtBid", () => {
  it("leaves a works budget that exactly fits under the total cost limit", async () => {
    const { maxWorksAtBid } = await import("@/lib/bid-ceiling-engine");
    const h = hypotheses();
    const works = maxWorksAtBid(h, 100_000);
    const withWorks = {
      ...h,
      works: { key: "devis" as const, amount: works, contingencyPct: 10, months: 3 },
    };
    const plan = computeCeilingPlan(withWorks);

    expect(works).toBeGreaterThan(50_000);
    expect(evaluateBid(withWorks, plan, 100_000).headroom).toBeGreaterThanOrEqual(0);
    expect(evaluateBid(withWorks, plan, 100_000).headroom).toBeLessThan(500);
  });
});
