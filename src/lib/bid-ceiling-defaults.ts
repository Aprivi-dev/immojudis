// Hypothèses de départ du plafond, tirées de la vente elle-même : surface,
// occupation, état, montants lus dans l'annonce, loyer et charges du secteur.
import { findConsignation } from "@/lib/auction-cost-analysis";
import {
  WORKS_CONTINGENCY_PCT,
  WORKS_MONTHS,
  type CeilingHypotheses,
  type CeilingProfile,
  type CeilingProject,
  type CeilingWorksKey,
  type OccupationCase,
  type ValueReliability,
} from "@/lib/bid-ceiling-engine";
import type { FeeRegime } from "@/lib/fee-regime-definitions";
import type { CeilingMarketEstimate } from "@/lib/market-estimate-ceiling";
import type { WorksBreakdownItem } from "@/lib/works-breakdown";
import {
  DEFAULT_PRELIMINARY_FEES,
  DEFAULTS,
  registrationRateForDepartment,
} from "@/lib/profitability";
import { defaultRentPerM2 } from "@/lib/rent-reference";
import { getMarketValuationSurfaces } from "@/lib/surface";
import type { AuctionSale } from "@/lib/types";

// Frais préalables retenus quand l'annonce ne les donne pas : valeur unique de `profitability.ts`.
export { DEFAULT_PRELIMINARY_FEES };
/** Commissaire de justice, serrurier, garde-meubles : ordre de grandeur d'une libération. */
export const DEFAULT_RELEASE_COST = 3_000;
export const DEFAULT_RELEASE_MONTHS = 12;
export const DEFAULT_RENTED_DISCOUNT_PCT = 10;
/** Charges de copropriété moyennes, en € par m² et par mois. */
export const DEFAULT_CONDO_CHARGES_PER_M2 = 2.5;
export const DEFAULT_MONTHLY_INSURANCE = 15;
export const DEFAULT_FINANCING_RATE_PCT = 4;
export const DEFAULT_RESALE_MONTHS = 4;
export const DEFAULT_SELLING_COSTS_PCT = 5;
export const DEFAULT_VACANCY_PCT = 5;
export const DEFAULT_NON_RECOVERABLE_PCT = 7;

export type CeilingUserChoices = {
  project?: CeilingProject;
  profile?: CeilingProfile;
  customMarginPct?: number | null;
  manualPricePerM2?: number | null;
  works?: { key: CeilingWorksKey; amount: number; months?: number | null } | null;
  /**
   * Postes saisis dans « Détail de vos travaux » (point 74). Gardés dans le navigateur avec les autres
   * choix, jamais envoyés au serveur ; seul leur total alimente `works.amount`.
   */
  worksBreakdown?: WorksBreakdownItem[];
  occupation?: OccupationCase | null;
  releaseMonths?: number | null;
  releaseCost?: number | null;
  rentedDiscountPct?: number | null;
  fpt?: number | null;
  lawyerFees?: number | null;
  registrationRatePct?: number | null;
  taxRegime?: "registration" | "vat";
  monthlyCharges?: number | null;
  annualPropertyTax?: number | null;
  financingRatePct?: number | null;
  monthlyRent?: number | null;
  targetNetYieldPct?: number | null;
  sellingCostsPct?: number | null;
};

export function occupationCaseForStatus(status: string | null | undefined): OccupationCase {
  const value = (status ?? "").trim().toLowerCase();
  if (!value || value === "unknown" || value === "inconnu") return "inconnu";
  if (value === "vacant" || value === "free" || value.includes("libre")) return "libre";
  if (value === "rented" || value === "tenant_occupied" || value.includes("lou")) return "loue";
  if (value === "squatted" || value.includes("squat")) return "squat";
  return "occupe";
}

/**
 * Hypothèses de départ du plafond d'une vente. `regime` : le régime de frais de la vente ; absent,
 * le calcul est celui du tribunal (barème, frais par défaut et consignation d'origine), sans que
 * l'hypothèse porte de régime.
 */
export function buildCeilingHypotheses(
  sale: AuctionSale,
  estimate: CeilingMarketEstimate | null,
  choices: CeilingUserChoices = {},
  regime: FeeRegime | null = null,
): CeilingHypotheses {
  const surfaces = getMarketValuationSurfaces(sale);
  const surface = surfaces.builtSurfaceM2;
  const apartment = /appart|apartment|studio|duplex|loft/i.test(sale.property_type ?? "");
  const rentPerM2 = defaultRentPerM2(sale.department);
  const estimatedRent = surface && rentPerM2 ? Math.round(surface * rentPerM2) : null;
  const preliminary = preliminaryFeesFromSale(sale);
  const consignation = findConsignation(sale)?.amountEur ?? null;
  const works = choices.works ?? { key: "aucun" as const, amount: 0 };
  // 0 n'est pas un loyer : un champ vidé ou à 0 revient au loyer de référence, ou à « absent ».
  const manualRent = positive(choices.monthlyRent);

  return {
    ...(regime ? { regime } : {}),
    project: choices.project ?? "habiter",
    profile: choices.profile ?? "equilibre",
    customMarginPct: choices.customMarginPct ?? null,
    surface,
    startingPrice: sale.starting_price_eur ?? null,
    value: valueHypothesis(estimate, surface, surfaces.builtSurfaceEstimated, choices),
    works: {
      key: works.key,
      amount: Math.max(0, Math.round(works.amount || 0)),
      contingencyPct: WORKS_CONTINGENCY_PCT,
      months: works.months ?? WORKS_MONTHS[works.key],
    },
    occupation: {
      case: choices.occupation ?? occupationCaseForStatus(sale.occupancy_status),
      releaseMonths: choices.releaseMonths ?? DEFAULT_RELEASE_MONTHS,
      releaseCost: choices.releaseCost ?? DEFAULT_RELEASE_COST,
      rentedDiscountPct: choices.rentedDiscountPct ?? DEFAULT_RENTED_DISCOUNT_PCT,
    },
    carrying: {
      monthlyCharges:
        choices.monthlyCharges ??
        (apartment && surface ? Math.round(surface * DEFAULT_CONDO_CHARGES_PER_M2) : 0),
      annualPropertyTax:
        choices.annualPropertyTax ??
        (estimatedRent
          ? Math.round(estimatedRent * 12 * 0.08)
          : surface
            ? Math.round(surface * 12)
            : 0),
      monthlyInsurance: DEFAULT_MONTHLY_INSURANCE,
      financingRatePct: choices.financingRatePct ?? DEFAULT_FINANCING_RATE_PCT,
      resaleMonths: DEFAULT_RESALE_MONTHS,
    },
    fees: {
      fpt: choices.fpt ?? preliminary ?? regime?.defaultPreliminaryFees ?? DEFAULT_PRELIMINARY_FEES,
      lawyerFees: choices.lawyerFees ?? regime?.defaultLawyerFees ?? DEFAULTS.lawyerFees,
      department: sale.department ?? null,
      registrationRate:
        choices.registrationRatePct != null
          ? choices.registrationRatePct / 100
          : registrationRateForDepartment(sale.department),
      taxRegime: choices.taxRegime ?? "registration",
      ...(regime ? { emolumentBrackets: regime.emolumentScale.brackets } : {}),
    },
    feesSource: {
      fpt: choices.fpt != null ? "saisie" : preliminary != null ? "document" : "defaut",
      consignation: consignation != null ? "document" : "regle",
    },
    rent: {
      monthly: manualRent ?? estimatedRent,
      source: manualRent != null ? "saisi" : estimatedRent ? "estime" : "absent",
      vacancyPct: DEFAULT_VACANCY_PCT,
      nonRecoverablePct: DEFAULT_NON_RECOVERABLE_PCT,
      targetNetYieldPct: choices.targetNetYieldPct ?? null,
    },
    resale: { sellingCostsPct: choices.sellingCostsPct ?? DEFAULT_SELLING_COSTS_PCT },
    consignation,
  };
}

function valueHypothesis(
  estimate: CeilingMarketEstimate | null,
  surface: number | null,
  surfaceEstimated: boolean,
  choices: CeilingUserChoices,
): CeilingHypotheses["value"] {
  const manual = positive(choices.manualPricePerM2);
  if (manual && surface) {
    return {
      amount: Math.round(manual * surface),
      source: "saisie",
      upperAmount: null,
      reliability: "saisie",
      sampleSize: null,
      surfaceEstimated,
    };
  }
  const usable = estimate?.actionable === true ? estimate : null;
  const median = positive(usable?.medianPricePerM2);
  const estimated = positive(usable?.estimatedValueEur);
  const amount = estimated ?? (median && surface ? Math.round(median * surface) : null);
  const p75 = positive(usable?.p75PricePerM2);
  return {
    amount,
    source: estimated ? "estimation" : amount ? "mediane" : "absente",
    upperAmount: p75 && surface ? Math.round(p75 * surface) : null,
    reliability: (usable?.qualityLabel as ValueReliability | undefined) ?? "fragile",
    sampleSize: usable?.effectiveSampleSize ?? usable?.sampleSize ?? null,
    surfaceEstimated: surfaceEstimated || usable?.subjectSurfaceEstimated === true,
  };
}

const PRELIMINARY_FEES_PATTERN =
  /frais\s+pr[ée]alables(?:\s+(?:taxés|tax[ée]s|de\s+(?:la\s+)?(?:vente|poursuite)|s['’]?[ée]l[èe]vent|estim[ée]s|d['’]un\s+montant|[àa]|de|au\s+titre|:|environ)){0,6}\s*:?\s*([0-9][0-9\s.,]*)\s*(?:€|euros?|EUR)/i;

/** Frais préalables lus dans l'annonce, quand elle les chiffre. */
export function preliminaryFeesFromSale(sale: AuctionSale): number | null {
  const texts = [
    sale.source_description,
    sale.description,
    JSON.stringify(sale.source_blocks ?? {}),
  ];
  for (const text of texts) {
    const match = typeof text === "string" ? PRELIMINARY_FEES_PATTERN.exec(text) : null;
    const amount = match ? moneyValue(match[1]) : null;
    if (amount != null && amount >= 300 && amount <= 60_000) return amount;
  }
  return null;
}

function moneyValue(raw: string): number | null {
  const compact = raw.replace(/\s/g, "");
  const normalized = /,\d{1,2}$/.test(compact)
    ? compact.replace(/\./g, "").replace(",", ".")
    : compact.replace(/[.,]/g, "");
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function positive(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}
