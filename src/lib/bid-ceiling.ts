import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { featureAccess, featureIncluded, type FeatureAccess, type PlanCode } from "@/lib/plans";
import {
  computeAcquisitionCosts,
  computeMarketCeiling,
  computeRentabilityScore,
  DEFAULTS,
  MARKET_CEILING_SCENARIOS,
  marketCeilingVerdict,
  type MarketCeilingResult,
  type MarketCeilingScenarioKey,
  type RentabilityScoreResult,
} from "@/lib/profitability";
import { resolvePlanEntitlements } from "@/lib/property-reports";
import { DETAIL_VIEW, SALE_LIST_COLUMNS } from "@/lib/queries";
import { getMarketEstimate, type MarketEstimate } from "@/lib/market.functions";
import { getSaleSurface } from "@/lib/surface";
import { recordFeatureUsageEvent } from "@/lib/usage";
import type { AuctionSale } from "@/lib/types";

const scenarioSchema = z.enum(["prudent", "equilibre", "offensif", "custom"]);

export const bidCeilingRequestSchema = z.object({
  saleId: z.string().uuid(),
  simulatedBidEur: z.number().finite().min(0).nullable().optional(),
  userBudgetEur: z.number().finite().min(0).nullable().optional(),
  worksEur: z.number().finite().min(0).nullable().optional(),
  fptEur: z.number().finite().min(0).nullable().optional(),
  scenario: scenarioSchema.default("equilibre"),
  customSafetyDiscountPct: z.number().finite().min(0).max(40).nullable().optional(),
  manualMarketPricePerM2: z.number().finite().min(0).nullable().optional(),
  monthlyRentEur: z.number().finite().min(0).nullable().optional(),
  targetGrossYieldPct: z.number().finite().min(0).max(30).nullable().optional(),
  targetNetYieldPct: z.number().finite().min(0).max(25).nullable().optional(),
  downPaymentPct: z.number().finite().min(0).max(100).nullable().optional(),
  annualInterestRatePct: z.number().finite().min(0).max(20).nullable().optional(),
  loanDurationYears: z.number().finite().min(1).max(35).nullable().optional(),
  loanInsuranceRatePct: z.number().finite().min(0).max(5).nullable().optional(),
});

export type BidCeilingRequestInput = z.input<typeof bidCeilingRequestSchema>;
export type BidCeilingRequestPayload = z.output<typeof bidCeilingRequestSchema>;

export type BidCeilingPlanAccess = {
  code: PlanCode;
  label: string;
  feature: FeatureAccess;
  advancedScenarios: FeatureAccess;
};

export type BidCeilingSaleSnapshot = {
  id: string;
  title: string | null;
  city: string | null;
  department: string | null;
  startingPriceEur: number | null;
  surfaceM2: number | null;
  surfaceKind: string | null;
};

export type BidCeilingMarketReference = {
  source: "dvf" | "manual" | "missing";
  medianPricePerM2: number | null;
  p25PricePerM2: number | null;
  p75PricePerM2: number | null;
  manualMarketPricePerM2: number | null;
  sampleSize: number | null;
  radiusM: number | null;
  qualityLabel: string | null;
};

export type BidCeilingScenarioAnalysis = {
  key: MarketCeilingScenarioKey | "custom";
  label: string;
  description: string;
  selected: boolean;
  result: MarketCeilingResult;
  verdict: ReturnType<typeof marketCeilingVerdict>;
};

export type BidCeilingBudgetAnalysis = {
  userBudgetEur: number | null;
  simulatedBidEur: number;
  allInCostAtBudget: number | null;
  allInCostAtSimulatedBid: number;
  selectedMaxBidEur: number | null;
  budgetDeltaToSelectedMaxBidEur: number | null;
  withinSelectedCeiling: boolean | null;
};

export type BidCeilingAssumptions = {
  simulatedBidEur: number;
  worksEur: number;
  fptEur: number;
  scenario: BidCeilingRequestPayload["scenario"];
  customSafetyDiscountPct: number | null;
  manualMarketPricePerM2: number | null;
  monthlyRentEur: number | null;
  targetGrossYieldPct: number | null;
  targetNetYieldPct: number | null;
};

export type BidCeilingAnalysisResponse = {
  ok: true;
  sale: BidCeilingSaleSnapshot;
  assumptions: BidCeilingAssumptions;
  marketReference: BidCeilingMarketReference;
  scenarios: BidCeilingScenarioAnalysis[];
  selected: BidCeilingScenarioAnalysis;
  budget: BidCeilingBudgetAnalysis;
  rentabilityAtSelectedMaxBid: RentabilityScoreResult;
  plan: BidCeilingPlanAccess;
  compliance: {
    limitations: string[];
  };
};

export async function calculateBidCeiling({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: BidCeilingRequestPayload;
}): Promise<BidCeilingAnalysisResponse> {
  const plan = await assertBidCeilingAvailable(auth);
  assertBidCeilingInputAllowed(plan, input);
  const sale = await loadSaleForBidCeiling(auth, input.saleId);
  const marketEstimate = await resolveMarketEstimate(sale, input);
  const response = buildBidCeilingAnalysis({
    sale,
    input,
    marketEstimate,
    plan: bidCeilingPlanAccess(plan),
  });

  await recordFeatureUsageEvent({
    auth,
    eventKey: "bid_ceiling.calculated",
    subjectType: "sale",
    subjectId: sale.id,
    metadata: {
      scenario: response.assumptions.scenario,
      selected_max_bid_eur: response.budget.selectedMaxBidEur,
      market_source: response.marketReference.source,
      available: response.selected.result.available,
    },
  });

  return response;
}

export function buildBidCeilingAnalysis({
  sale,
  input,
  marketEstimate,
  plan,
}: {
  sale: AuctionSale;
  input: BidCeilingRequestPayload;
  marketEstimate: MarketEstimate | null;
  plan: BidCeilingPlanAccess;
}): BidCeilingAnalysisResponse {
  const surface = getSaleSurface(sale);
  const simulatedBidEur = Math.max(0, input.simulatedBidEur ?? sale.starting_price_eur ?? 0);
  const worksEur = Math.max(0, input.worksEur ?? DEFAULTS.works);
  const fptEur = Math.max(0, input.fptEur ?? DEFAULTS.fpt);
  const scenarioKeys = scenarioKeysForPlan(plan, input.scenario);
  const marketReference = buildMarketReference(input, marketEstimate);

  const scenarios = scenarioKeys.map((scenario) => {
    const config = MARKET_CEILING_SCENARIOS.find((item) => item.key === scenario);
    const result = computeMarketCeiling({
      surface: surface.value,
      price: simulatedBidEur,
      works: worksEur,
      fpt: fptEur,
      scenario,
      customSafetyDiscountPct: input.customSafetyDiscountPct ?? undefined,
      manualMarketPricePerM2: input.manualMarketPricePerM2,
      medianPricePerM2: marketEstimate?.medianPricePerM2,
      p25PricePerM2: marketEstimate?.p25PricePerM2,
      p75PricePerM2: marketEstimate?.p75PricePerM2,
    });
    return {
      key: scenario,
      label: config?.label ?? "Personnalisé",
      description: config?.description ?? "Marge de sécurité définie par l'utilisateur.",
      selected: scenario === input.scenario,
      result,
      verdict: marketCeilingVerdict(result),
    };
  });
  const selected = scenarios.find((scenario) => scenario.selected) ?? scenarios[0];
  const budget = buildBudgetAnalysis({
    selectedResult: selected.result,
    simulatedBidEur,
    userBudgetEur: input.userBudgetEur ?? null,
    worksEur,
    fptEur,
  });
  const rentabilityAtSelectedMaxBid = computeRentabilityScore({
    surface: surface.value,
    price: selected.result.available ? selected.result.maxBid : simulatedBidEur,
    works: worksEur,
    fpt: fptEur,
    department: sale.department,
    monthlyRent: input.monthlyRentEur,
    targetGrossYieldPct: input.targetGrossYieldPct ?? undefined,
    targetNetYieldPct: input.targetNetYieldPct ?? undefined,
    downPaymentPct: input.downPaymentPct ?? undefined,
    annualInterestRatePct: input.annualInterestRatePct ?? undefined,
    loanDurationYears: input.loanDurationYears ?? undefined,
    loanInsuranceRatePct: input.loanInsuranceRatePct ?? undefined,
    marketMarginPerM2: selected.result.available ? selected.result.marginPerM2 : null,
  });

  return {
    ok: true,
    sale: {
      id: sale.id,
      title: sale.title,
      city: sale.city,
      department: sale.department,
      startingPriceEur: sale.starting_price_eur,
      surfaceM2: surface.value,
      surfaceKind: surface.kind,
    },
    assumptions: {
      simulatedBidEur,
      worksEur,
      fptEur,
      scenario: input.scenario,
      customSafetyDiscountPct: input.customSafetyDiscountPct ?? null,
      manualMarketPricePerM2: input.manualMarketPricePerM2 ?? null,
      monthlyRentEur: input.monthlyRentEur ?? null,
      targetGrossYieldPct: input.targetGrossYieldPct ?? null,
      targetNetYieldPct: input.targetNetYieldPct ?? null,
    },
    marketReference,
    scenarios,
    selected,
    budget,
    rentabilityAtSelectedMaxBid,
    plan,
    compliance: {
      limitations: [
        "Le plafond d'enchère est une aide à la décision et ne constitue pas une recommandation d'achat.",
        "Les frais, travaux, conditions d'occupation et pièces officielles doivent être confirmés avant l'audience.",
        "Aucun rendement, gain ou prix d'adjudication n'est garanti.",
      ],
    },
  };
}

async function assertBidCeilingAvailable(auth: SupabaseAuthContext) {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "property.bidCeiling")) {
    throw new Error("Calcul de mise maximale réservé au plan Analyse.");
  }
  return plan;
}

function assertBidCeilingInputAllowed(
  plan: Awaited<ReturnType<typeof resolvePlanEntitlements>>,
  input: BidCeilingRequestPayload,
) {
  if (featureIncluded(plan.plan, "property.advancedBidScenarios")) return;
  const usesAdvancedScenario =
    input.scenario !== "equilibre" || input.customSafetyDiscountPct != null;
  const usesAdvancedAssumptions =
    input.worksEur != null ||
    input.fptEur != null ||
    input.manualMarketPricePerM2 != null ||
    input.monthlyRentEur != null ||
    input.targetGrossYieldPct != null ||
    input.targetNetYieldPct != null ||
    input.downPaymentPct != null ||
    input.annualInterestRatePct != null ||
    input.loanDurationYears != null ||
    input.loanInsuranceRatePct != null;

  if (usesAdvancedScenario || usesAdvancedAssumptions) {
    throw new Error("Scénarios de frais, travaux et marge cible réservés au plan Analyse.");
  }
}

async function loadSaleForBidCeiling(
  auth: SupabaseAuthContext,
  saleId: string,
): Promise<AuctionSale> {
  const { data, error } = await auth.supabase
    .from(DETAIL_VIEW)
    .select(SALE_LIST_COLUMNS)
    .eq("id", saleId)
    .single();

  if (error) throw error;
  return data as unknown as AuctionSale;
}

async function resolveMarketEstimate(
  sale: AuctionSale,
  input: BidCeilingRequestPayload,
): Promise<MarketEstimate | null> {
  if (input.manualMarketPricePerM2) return null;
  const surface = getSaleSurface(sale).value;
  if (sale.latitude == null || sale.longitude == null || surface == null || surface <= 0) {
    return null;
  }

  const response = await getMarketEstimate({
    lat: sale.latitude,
    lng: sale.longitude,
    propertyType: sale.property_type,
    surfaceM2: surface,
  });
  return response.estimate;
}

function bidCeilingPlanAccess(plan: { plan: PlanCode; label: string }): BidCeilingPlanAccess {
  return {
    code: plan.plan,
    label: plan.label,
    feature: featureAccess(plan.plan, "property.bidCeiling"),
    advancedScenarios: featureAccess(plan.plan, "property.advancedBidScenarios"),
  };
}

function scenarioKeysForPlan(
  plan: BidCeilingPlanAccess,
  requestedScenario: BidCeilingRequestPayload["scenario"],
): Array<MarketCeilingScenarioKey | "custom"> {
  if (plan.advancedScenarios === "locked") return [requestedScenario];
  const keys = MARKET_CEILING_SCENARIOS.map(
    (scenario) => scenario.key,
  ) as MarketCeilingScenarioKey[];
  return requestedScenario === "custom" ? [...keys, "custom"] : keys;
}

function buildMarketReference(
  input: BidCeilingRequestPayload,
  marketEstimate: MarketEstimate | null,
): BidCeilingMarketReference {
  return {
    source: input.manualMarketPricePerM2 ? "manual" : marketEstimate ? "dvf" : "missing",
    medianPricePerM2: marketEstimate?.medianPricePerM2 ?? null,
    p25PricePerM2: marketEstimate?.p25PricePerM2 ?? null,
    p75PricePerM2: marketEstimate?.p75PricePerM2 ?? null,
    manualMarketPricePerM2: input.manualMarketPricePerM2 ?? null,
    sampleSize: marketEstimate?.sampleSize ?? null,
    radiusM: marketEstimate?.radiusM ?? null,
    qualityLabel: marketEstimate?.qualityLabel ?? null,
  };
}

function buildBudgetAnalysis({
  selectedResult,
  simulatedBidEur,
  userBudgetEur,
  worksEur,
  fptEur,
}: {
  selectedResult: MarketCeilingResult;
  simulatedBidEur: number;
  userBudgetEur: number | null;
  worksEur: number;
  fptEur: number;
}): BidCeilingBudgetAnalysis {
  const allInCostAtBudget =
    userBudgetEur == null
      ? null
      : Math.round(
          computeAcquisitionCosts({ price: userBudgetEur, works: worksEur, fpt: fptEur }).totalCost,
        );
  const selectedMaxBidEur = selectedResult.available ? selectedResult.maxBid : null;

  return {
    userBudgetEur,
    simulatedBidEur,
    allInCostAtBudget,
    allInCostAtSimulatedBid: Math.round(
      computeAcquisitionCosts({ price: simulatedBidEur, works: worksEur, fpt: fptEur }).totalCost,
    ),
    selectedMaxBidEur,
    budgetDeltaToSelectedMaxBidEur:
      userBudgetEur == null || selectedMaxBidEur == null ? null : userBudgetEur - selectedMaxBidEur,
    withinSelectedCeiling:
      userBudgetEur == null || selectedMaxBidEur == null
        ? null
        : userBudgetEur <= selectedMaxBidEur,
  };
}
