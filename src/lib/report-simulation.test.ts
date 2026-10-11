import { describe, expect, it } from "vitest";
import { EXAMPLE_SALE, EXAMPLE_SALE_RECORDS } from "@/lib/example-sale";
import { buildCeilingSnapshot } from "@/lib/property-report/ceiling-snapshot";
import {
  buildReportRentalScenario,
  computeReportSimulation,
  reportSimulationSchema,
  type ReportRentalScenario,
} from "./report-simulation";

describe("report simulation", () => {
  const sale = {
    ...EXAMPLE_SALE,
    property_type: "apartment" as const,
    app_surface_m2: 50,
    app_surface_kind: "habitable" as const,
  };
  const input = {
    version: 2 as const,
    choices: {
      works: { key: "devis" as const, amount: 20000 },
      fpt: 5000,
      customMarginPct: 20,
      manualPricePerM2: 4000,
    },
    expectedMaxBid: 0,
  };

  it("rejects an obsolete or forged ceiling instead of exporting a different result", () => {
    expect(() => computeReportSimulation(sale, null, input)).toThrow(/ont changé/);
  });

  it("validates finite nonnegative financial inputs", () => {
    expect(
      reportSimulationSchema.safeParse({ ...input, choices: { ...input.choices, fpt: -1 } })
        .success,
    ).toBe(false);
    expect(reportSimulationSchema.safeParse({ ...input, expectedMaxBid: Infinity }).success).toBe(
      false,
    );
  });

  it("rejects a contradictory property classification on the server", () => {
    expect(() =>
      computeReportSimulation(
        { ...sale, property_type: "land", source_blocks: { titre_detail: "Appartement T5" } },
        null,
        input,
      ),
    ).toThrow(/contradictoire/);
  });
});

const { sale, marketEstimate } = EXAMPLE_SALE_RECORDS.bordeaux;

describe("report rental scenario payload", () => {
  it("normalizes the visible draft without inventing non-zero expenses", () => {
    expect(
      buildReportRentalScenario({
        draft: {
          monthlyRent: " 700,50 ",
          vacancyRatePct: "5",
          annualNonRecoverableCharges: "",
          annualPropertyTax: " 1 200 ",
          annualLandlordInsurance: "240",
        },
        acquisitionCost: 77_720,
        monthlyDebtService: 430,
      }),
    ).toEqual({
      acquisitionCost: 77_720,
      monthlyRent: 700.5,
      vacancyRatePct: 5,
      annualNonRecoverableCharges: 0,
      annualPropertyTax: 1200,
      annualLandlordInsurance: 240,
      monthlyDebtService: 430,
      missingExpenseFields: ["annualNonRecoverableCharges"],
    });
  });

  it("keeps the exact personal rental result on the simulation sent to the report saver", () => {
    const rentalScenario: ReportRentalScenario = {
      acquisitionCost: 77_720,
      monthlyRent: 700,
      vacancyRatePct: 5,
      annualNonRecoverableCharges: 1200,
      annualPropertyTax: 1800,
      annualLandlordInsurance: 240,
      monthlyDebtService: 430,
      missingExpenseFields: [],
    };
    const choices = { works: { key: "devis" as const, amount: 20_000 }, fpt: 5_000 };
    const expectedCeiling = buildCeilingSnapshot(sale, marketEstimate, choices);
    expect(expectedCeiling.available).toBe(true);

    const computed = computeReportSimulation(sale, marketEstimate, {
      version: 2,
      choices,
      expectedMaxBid: expectedCeiling.maxBid!,
      rentalScenario,
    });

    expect(computed.personalRentalScenario?.inputs).toEqual(rentalScenario);
    expect(computed.personalRentalScenario?.result).toMatchObject({
      annualOperatingIncome: 4_740,
      grossYieldPct: expect.closeTo(10.808, 3),
      netOperatingYieldPct: expect.closeTo(6.0988, 3),
      monthlyCashFlow: -35,
    });
  });

  it("does not turn an incomplete visible draft into a report scenario", () => {
    expect(
      buildReportRentalScenario({
        draft: { monthlyRent: "700", vacancyRatePct: "" },
        acquisitionCost: 77_720,
        monthlyDebtService: 430,
      }),
    ).toBeNull();
  });
});
