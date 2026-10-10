import {
  DEFAULT_MARKET_CEILING_SCENARIO,
  DEFAULTS,
  estimateWorksBudget,
  WORKS_SCENARIOS,
  type MarketCeilingResult,
  type MarketCeilingScenarioKey,
  type WorksScenarioKey,
} from "@/lib/profitability";
import { saleCostContext } from "@/lib/sale-cost-context";
import { formatPrice, formatPricePerM2 } from "@/lib/format";
import type { AuctionSale } from "@/lib/types";
import type { ReportSimulation } from "@/lib/report-simulation";
import {
  parseBidDraft,
  type BidAssistantState as AssistantState,
} from "@/lib/bid-simulation-history";

export type ScenarioResult = {
  key: MarketCeilingScenarioKey | "custom";
  label: string;
  description: string;
  result: MarketCeilingResult;
};

export function loadState(key: string): AssistantState | null {
  if (typeof window === "undefined") return null;
  try {
    return parseBidDraft(window.localStorage.getItem(key));
  } catch {
    return null;
  }
}

export function fmt(value: number): string {
  return formatPrice(Math.round(value || 0));
}

export function ppm2(value: number | null | undefined): string {
  return formatPricePerM2(value);
}

export function signedMoney(value: number): string {
  const rounded = Math.round(value || 0);
  if (rounded === 0) return "0 €";
  return `${rounded > 0 ? "+" : "-"}${fmt(Math.abs(rounded))}`;
}

function isWorksScenarioKey(value: unknown): value is WorksScenarioKey {
  return WORKS_SCENARIOS.some((scenario) => scenario.key === value);
}

function normalizeMarketScenario(value: unknown): MarketCeilingScenarioKey | "custom" {
  if (value === "custom") return "custom";
  return value === "offensif" ? "offensif" : DEFAULT_MARKET_CEILING_SCENARIO;
}

/** Hypothèses de frais et d'occupation communes à tous les calculs du simulateur. */
export function costInputsFromState(state: AssistantState, sale: AuctionSale) {
  return {
    fpt: state.fpt,
    lawyerFees: state.lawyerFees ?? DEFAULTS.lawyerFees,
    registrationRate: state.registrationRatePct != null ? state.registrationRatePct / 100 : null,
    taxRegime: state.taxRegime ?? ("registration" as const),
    occupancyDiscountPct: state.occupancyDiscountPct ?? DEFAULTS.occupancyDiscountPct,
    carryMonths: state.carryMonths ?? DEFAULTS.occupancyCarryMonths,
    monthlyCarryCharges: state.monthlyCarryCharges ?? 0,
    ...saleCostContext(sale),
  };
}

export function createAssistantState(
  startingPrice: number,
  surface: number | null,
  stored: Partial<AssistantState> | null = null,
): AssistantState {
  // Aucun travaux par défaut : l'utilisateur choisit un scénario s'il en prévoit.
  const fallback: AssistantState = {
    price: startingPrice,
    works: 0,
    worksScenario: null,
    fpt: DEFAULTS.fpt,
    lawyerFees: DEFAULTS.lawyerFees,
    occupancyDiscountPct: DEFAULTS.occupancyDiscountPct,
    carryMonths: DEFAULTS.occupancyCarryMonths,
    monthlyCarryCharges: 0,
    taxRegime: "registration",
    scenario: DEFAULT_MARKET_CEILING_SCENARIO,
    customSafetyDiscountPct: 8,
    manualMarketPricePerM2: 0,
    marketEdited: false,
  };

  if (!stored) return fallback;

  // Les anciens réglages ne connaissaient pas les scénarios : leur montant
  // travaux reste une hypothèse manuelle afin de ne pas écraser une saisie.
  if (!Object.prototype.hasOwnProperty.call(stored, "worksScenario")) {
    return {
      ...fallback,
      ...stored,
      scenario: normalizeMarketScenario(stored.scenario),
      works: Math.max(0, stored.works || 0),
      worksScenario: null,
    };
  }

  const worksScenario = isWorksScenarioKey(stored.worksScenario) ? stored.worksScenario : null;
  return {
    ...fallback,
    ...stored,
    scenario: normalizeMarketScenario(stored.scenario),
    worksScenario,
    works: worksScenario
      ? estimateWorksBudget(surface, worksScenario)
      : Math.max(0, stored.works || 0),
  };
}

export type BidSimulationSnapshot = {
  saleId: string;
  ownerId: string;
  result: MarketCeilingResult;
  works: number;
  worksKnown?: boolean;
  reportInput?: ReportSimulation;
};
