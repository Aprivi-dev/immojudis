import { z } from "zod";
import { computeMarketCeiling } from "./profitability";
import { saleCostContext } from "./sale-cost-context";
import { getMarketValuationSurfaces } from "./surface";
import { listingValuationConflict } from "./listing-evidence";
import type { AuctionSale } from "./types";
import type { MarketEstimate } from "./market.functions";

const amount = z.number().finite().min(0).max(1_000_000_000);
const positiveAmount = amount.gt(0);
export const REPORT_RENTAL_EXPENSE_FIELD_LABELS = {
  annualNonRecoverableCharges: "charges non récupérables",
  annualPropertyTax: "taxe foncière",
  annualLandlordInsurance: "assurance propriétaire",
} as const;
export const REPORT_RENTAL_EXPENSE_FIELDS = Object.keys(
  REPORT_RENTAL_EXPENSE_FIELD_LABELS,
) as Array<keyof typeof REPORT_RENTAL_EXPENSE_FIELD_LABELS>;
const reportRentalExpenseFieldSchema = z.enum([
  "annualNonRecoverableCharges",
  "annualPropertyTax",
  "annualLandlordInsurance",
]);

export const reportRentalScenarioSchema = z.object({
  acquisitionCost: positiveAmount,
  monthlyRent: positiveAmount,
  vacancyRatePct: z.number().finite().min(0).max(100),
  annualNonRecoverableCharges: amount,
  annualPropertyTax: amount,
  annualLandlordInsurance: amount,
  monthlyDebtService: amount.nullable(),
  /** Expense fields that were blank in the form and therefore calculated as 0. */
  missingExpenseFields: z.array(reportRentalExpenseFieldSchema).max(3).default([]),
});
export type ReportRentalScenario = z.infer<typeof reportRentalScenarioSchema>;

export type ReportRentalScenarioResult = {
  annualPotentialRent: number;
  annualEffectiveRent: number;
  annualOperatingIncome: number;
  grossYieldPct: number;
  netOperatingYieldPct: number;
  monthlyCashFlow: number | null;
};

export type ReportRentalScenarioSnapshot = {
  inputs: ReportRentalScenario;
  result: ReportRentalScenarioResult;
};

export type ReportRentalScenarioDraft = {
  monthlyRent?: string | null;
  vacancyRatePct?: string | null;
  annualNonRecoverableCharges?: string | null;
  annualPropertyTax?: string | null;
  annualLandlordInsurance?: string | null;
};

function positiveNumber(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegativeNumber(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Keep draft parsing identical for the listing UI and the persisted report payload. */
function parseDraftNumber(value: string | null | undefined): number | null {
  const normalized = (value ?? "")
    .trim()
    .replace(/[\s\u00a0\u202f]/g, "")
    .replace(",", ".");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function expenseFromDraft(value: string | null | undefined): number | null {
  if (!(value ?? "").trim()) return 0;
  const parsed = parseDraftNumber(value);
  return parsed != null && parsed >= 0 ? parsed : null;
}

/**
 * Convert the visible rental form into the exact, fully numeric payload sent
 * with a saved report. Empty expense fields deliberately become zero because
 * that is the UI's documented calculation rule; invalid values abort the
 * scenario instead of silently changing its meaning.
 */
export function buildReportRentalScenario({
  draft,
  acquisitionCost,
  monthlyDebtService,
}: {
  draft?: ReportRentalScenarioDraft | null;
  acquisitionCost?: number | null;
  monthlyDebtService?: number | null;
}): ReportRentalScenario | null {
  const monthlyRent = parseDraftNumber(draft?.monthlyRent);
  const vacancyRatePct = parseDraftNumber(draft?.vacancyRatePct);
  const annualNonRecoverableCharges = expenseFromDraft(draft?.annualNonRecoverableCharges);
  const annualPropertyTax = expenseFromDraft(draft?.annualPropertyTax);
  const annualLandlordInsurance = expenseFromDraft(draft?.annualLandlordInsurance);
  const missingExpenseFields = REPORT_RENTAL_EXPENSE_FIELDS.filter(
    (field) => !(draft?.[field] ?? "").trim(),
  );
  const normalizedDebtService =
    monthlyDebtService == null ? null : nonNegativeNumber(monthlyDebtService);
  const parsed = reportRentalScenarioSchema.safeParse({
    acquisitionCost,
    monthlyRent,
    vacancyRatePct,
    annualNonRecoverableCharges,
    annualPropertyTax,
    annualLandlordInsurance,
    monthlyDebtService: normalizedDebtService,
    missingExpenseFields,
  });

  return parsed.success ? parsed.data : null;
}

/** Calculate the same pre-tax rental metrics displayed by ListingRental. */
export function calculateReportRentalScenario(
  inputs: ReportRentalScenario,
): ReportRentalScenarioResult | null {
  const acquisitionCost = positiveNumber(inputs.acquisitionCost);
  const monthlyRent = positiveNumber(inputs.monthlyRent);
  const vacancyRatePct = nonNegativeNumber(inputs.vacancyRatePct);
  const annualNonRecoverableCharges = nonNegativeNumber(inputs.annualNonRecoverableCharges);
  const annualPropertyTax = nonNegativeNumber(inputs.annualPropertyTax);
  const annualLandlordInsurance = nonNegativeNumber(inputs.annualLandlordInsurance);
  const monthlyDebtService =
    inputs.monthlyDebtService == null ? null : nonNegativeNumber(inputs.monthlyDebtService);

  if (
    acquisitionCost == null ||
    monthlyRent == null ||
    vacancyRatePct == null ||
    vacancyRatePct > 100 ||
    annualNonRecoverableCharges == null ||
    annualPropertyTax == null ||
    annualLandlordInsurance == null ||
    (inputs.monthlyDebtService != null && monthlyDebtService == null)
  ) {
    return null;
  }

  const annualPotentialRent = monthlyRent * 12;
  const annualEffectiveRent = annualPotentialRent * (1 - vacancyRatePct / 100);
  const annualOperatingIncome =
    annualEffectiveRent - annualNonRecoverableCharges - annualPropertyTax - annualLandlordInsurance;

  return {
    annualPotentialRent,
    annualEffectiveRent,
    annualOperatingIncome,
    grossYieldPct: (annualPotentialRent / acquisitionCost) * 100,
    netOperatingYieldPct: (annualOperatingIncome / acquisitionCost) * 100,
    monthlyCashFlow:
      monthlyDebtService == null ? null : annualOperatingIncome / 12 - monthlyDebtService,
  };
}

export function computeReportRentalScenario(
  inputs: ReportRentalScenario,
): ReportRentalScenarioSnapshot {
  const result = calculateReportRentalScenario(inputs);
  if (!result) throw new Error("Les hypothèses locatives sont invalides.");
  return { inputs, result };
}

export const reportSimulationSchema = z.object({
  price: amount,
  works: amount,
  fpt: amount,
  lawyerFees: amount.optional(),
  registrationRate: z.number().finite().min(0).max(0.2).nullable().optional(),
  taxRegime: z.enum(["registration", "vat"]).optional(),
  occupancyDiscountPct: z.number().finite().min(0).max(60).optional(),
  carryMonths: z.number().finite().min(0).max(120).optional(),
  monthlyCarryCharges: amount.optional(),
  scenario: z.enum(["prudent", "offensif", "custom"]),
  customSafetyDiscountPct: z.number().finite().min(0).max(100).optional(),
  manualMarketPricePerM2: amount.nullable(),
  expectedMaxBid: amount,
  rentalScenario: reportRentalScenarioSchema.optional(),
});
export type ReportSimulation = z.infer<typeof reportSimulationSchema>;

/** Recompute user hypotheses against the server's current property and market data. */
export function computeReportSimulation(
  sale: AuctionSale,
  market: MarketEstimate | null,
  input: ReportSimulation,
) {
  const conflict = listingValuationConflict(sale);
  if (conflict) throw new Error(conflict);
  const result = computeMarketCeiling({
    ...input,
    surface: getMarketValuationSurfaces(sale).builtSurfaceM2,
    ...saleCostContext(sale),
    medianPricePerM2: market?.actionable ? market.medianPricePerM2 : null,
    p10PricePerM2: market?.actionable ? market.p10PricePerM2 : null,
    p25PricePerM2: market?.actionable ? market.p25PricePerM2 : null,
    p75PricePerM2: market?.actionable ? market.p75PricePerM2 : null,
  });
  if (!result.available || Math.abs(result.maxBid - input.expectedMaxBid) > 0.01) {
    throw new Error(
      "Les données du scénario ont changé. Actualisez la fiche avant de sauvegarder le rapport.",
    );
  }
  return {
    ...result,
    personalRentalScenario: input.rentalScenario
      ? computeReportRentalScenario(input.rentalScenario)
      : null,
  };
}
