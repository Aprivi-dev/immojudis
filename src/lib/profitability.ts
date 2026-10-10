// Calcul d'un seuil d'enchère basé sur le marché local DVF.
// Toutes les valeurs sont en euros sauf indication.
import { clamp } from "@/lib/guards";
import { departmentCode } from "@/lib/department-code";
import { defaultRentPerM2, RENT_REFERENCE_UNAVAILABLE } from "@/lib/rent-reference";

// ─── Barème des émoluments de l'avocat poursuivant ───────────────────────
// Article A444-191 du Code de commerce, qui renvoie au barème proportionnel
// dégressif de l'article A444-102 (tableau 5, modifié par l'arrêté du
// 28 février 2020). Taux HT appliqués tranche par tranche au prix
// d'adjudication. Valeurs recoupées sur plusieurs sources publiques le
// 09/10/2026 ; à confirmer sur Légifrance avant toute évolution :
// https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000041595310
export const EMOLUMENT_SCALE_REFERENCE = "art. A444-191 du Code de commerce";
export const EMOLUMENT_SCALE_DATE = "09/10/2026";
const EMOLUMENT_BRACKETS: Array<{ upTo: number; rate: number }> = [
  { upTo: 6_500, rate: 0.07256 },
  { upTo: 17_000, rate: 0.02993 },
  { upTo: 60_000, rate: 0.01995 },
  { upTo: Infinity, rate: 0.01497 },
];

const VAT = 0.2;

// ─── Droits de mutation à titre onéreux (DMTO) ───────────────────────────
// Taux global (part départementale + communale + frais d'assiette) pour une
// vente d'immeuble ancien. La loi de finances 2025 a permis aux départements de
// relever leur part à 5 % jusqu'au 31/03/2028 : environ 88 départements
// appliquent 6,32 % au 01/06/2026, une dizaine 5,81 % et l'Indre 5,09 %.
// Sans liste officielle exhaustive à portée, le taux plein (le plus prudent)
// sert de défaut ; l'utilisateur peut le corriger dans le simulateur.
export const DMTO_TABLE_DATE = "01/06/2026";
export const DMTO_DEFAULT_RATE = 0.0632;
export const DMTO_RATE_BY_DEPARTMENT: Readonly<Record<string, number>> = {
  "36": 0.0509,
};
/** Contribution de sécurité immobilière : 0,10 % de la base taxable. */
export const CSI_RATE = 0.001;

export function registrationRateForDepartment(department?: string | null): number {
  const code = departmentCode(department);
  return (code ? DMTO_RATE_BY_DEPARTMENT[code] : undefined) ?? DMTO_DEFAULT_RATE;
}

export function computeEmolumentsHT(price: number): number {
  let remaining = Math.max(0, price || 0);
  let prev = 0;
  let total = 0;
  for (const bracket of EMOLUMENT_BRACKETS) {
    if (remaining <= 0) break;
    const span = Math.min(remaining, bracket.upTo - prev);
    total += span * bracket.rate;
    remaining -= span;
    prev = bracket.upTo;
  }
  return total;
}

export const DEFAULTS = {
  fpt: 3_000,
  works: 0,
  safetyDiscountPct: 8,
  /** Honoraires de l'avocat enchérisseur, hors émoluments tarifés (TTC). */
  lawyerFees: 1_500,
  occupancyDiscountPct: 15,
  occupancyCarryMonths: 12,
};

export const DEFAULT_MARKET_CEILING_SCENARIO = "prudent" as const;

export const REFRESH_WORKS_PRICE_PER_M2 = 500;

export const WORKS_SCENARIOS = [
  {
    key: "rafraichissement",
    label: "Rafraîchissement locatif",
    pricePerM2: REFRESH_WORKS_PRICE_PER_M2,
    summary: "Remettre le bien au propre sans modifier sa structure.",
    scope: "Peinture complète, sol PVC et remise à niveau légère de la salle d'eau.",
  },
  {
    key: "confort",
    label: "Rénovation confort",
    pricePerM2: 1_440,
    summary: "Moderniser un logement ancien pour un usage confortable.",
    scope: "Électricité, isolation légère, cuisine, salle de bain, sols et peinture.",
  },
  {
    key: "premium",
    label: "Rénovation premium",
    pricePerM2: 1_850,
    summary: "Reprendre intégralement un bien ancien ou très dégradé.",
    scope: "Isolation, fenêtres, toiture, plomberie, électricité et pièces d'eau haut de gamme.",
  },
] as const;

export type WorksScenarioKey = (typeof WORKS_SCENARIOS)[number]["key"];

export function estimateWorksBudget(
  surface: number | null | undefined,
  scenarioKey: WorksScenarioKey,
): number {
  const cleanSurface = Math.max(0, surface || 0);
  const scenario = WORKS_SCENARIOS.find((item) => item.key === scenarioKey);
  return scenario ? Math.round(cleanSurface * scenario.pricePerM2) : 0;
}

export type TaxRegime = "registration" | "vat";

/** Hypothèses de frais communes à tous les calculs de coût d'acquisition. */
export type AcquisitionCostOptions = {
  works?: number;
  /** Frais préalables de la procédure, payés en plus du prix. */
  fpt?: number;
  /** Honoraires de l'avocat enchérisseur (TTC), hors émoluments tarifés. */
  lawyerFees?: number;
  /** Département du bien : détermine le taux de DMTO. */
  department?: string | null;
  /** Taux de DMTO saisi par l'utilisateur (fraction, ex. 0.0632). */
  registrationRate?: number | null;
  /** `vat` : bien soumis à TVA (terrain à bâtir, vendeur assujetti). */
  taxRegime?: TaxRegime;
};

export type AcquisitionCostResult = {
  price: number;
  emolumentsHT: number;
  emolumentsTTC: number;
  registrationDuties: number;
  registrationRate: number;
  /** TVA sur le prix, uniquement pour un bien soumis à TVA. */
  vatOnPrice: number;
  taxRegime: TaxRegime;
  /** Contribution de sécurité immobilière. */
  csi: number;
  lawyerFees: number;
  fpt: number;
  works: number;
  acquisitionFeesTotal: number;
  acquisitionFeesPct: number;
  totalCost: number;
};

export function computeAcquisitionCosts({
  price,
  works = DEFAULTS.works,
  fpt = DEFAULTS.fpt,
  lawyerFees = DEFAULTS.lawyerFees,
  department,
  registrationRate,
  taxRegime = "registration",
}: { price: number } & AcquisitionCostOptions): AcquisitionCostResult {
  const cleanPrice = Math.max(0, price || 0);
  const cleanWorks = Math.max(0, works || 0);
  const cleanFpt = Math.max(0, fpt || 0);
  const cleanLawyerFees = Math.max(0, lawyerFees || 0);
  const emolumentsHT = computeEmolumentsHT(cleanPrice);
  const emolumentsTTC = emolumentsHT * (1 + VAT);
  // Les droits se calculent sur le prix augmenté des frais préalables
  // (charges augmentatives), pas sur le seul prix.
  const taxableBase = cleanPrice + cleanFpt;
  const rate =
    registrationRate != null && Number.isFinite(registrationRate) && registrationRate >= 0
      ? registrationRate
      : registrationRateForDepartment(department);
  const subjectToVat = taxRegime === "vat";
  const registrationDuties = subjectToVat ? 0 : taxableBase * rate;
  const vatOnPrice = subjectToVat ? cleanPrice * VAT : 0;
  const csi = subjectToVat ? 0 : taxableBase * CSI_RATE;
  const acquisitionFeesTotal =
    emolumentsTTC + registrationDuties + vatOnPrice + csi + cleanLawyerFees + cleanFpt;
  const totalCost = cleanPrice + acquisitionFeesTotal + cleanWorks;

  return {
    price: cleanPrice,
    emolumentsHT,
    emolumentsTTC,
    registrationDuties,
    registrationRate: rate,
    vatOnPrice,
    taxRegime,
    csi,
    lawyerFees: cleanLawyerFees,
    fpt: cleanFpt,
    works: cleanWorks,
    acquisitionFeesTotal,
    acquisitionFeesPct: cleanPrice > 0 ? (acquisitionFeesTotal / cleanPrice) * 100 : 0,
    totalCost,
  };
}

export const MARKET_CEILING_SCENARIOS = [
  {
    key: "prudent",
    label: "Prudent",
    basis: "p10",
    basisLabel: "borne basse calibrée (P10)",
    safetyDiscountPct: 8,
    description:
      "Profil par défaut : référence = les 10 % des ventes comparables les moins chères, puis marge de sécurité de 8 %.",
  },
  {
    key: "offensif",
    label: "Offensif",
    basis: "median",
    basisLabel: "médiane locale",
    safetyDiscountPct: 4,
    description: "Marge de sécurité de 4 %, à réserver aux dossiers très lisibles.",
  },
] as const;

export type MarketCeilingScenarioKey = (typeof MARKET_CEILING_SCENARIOS)[number]["key"];
export type MarketCeilingBasis = (typeof MARKET_CEILING_SCENARIOS)[number]["basis"];

export type OccupancyKind = "free" | "occupied" | "unknown";

/** Range un statut d'occupation brut (`occupancy_status`) dans trois cas. */
export function classifyOccupancy(status: string | null | undefined): OccupancyKind {
  const value = (status ?? "").trim().toLowerCase();
  if (!value || value === "unknown" || value === "inconnu") return "unknown";
  if (value.includes("libre") || value === "vacant" || value === "free") return "free";
  return "occupied";
}

export type OccupancyInputs = {
  /** Un bien occupé ou d'occupation inconnue subit une décote et un portage. */
  occupancy?: OccupancyKind;
  occupancyDiscountPct?: number;
  carryMonths?: number;
  monthlyCarryCharges?: number;
};

export type MarketCeilingInputs = AcquisitionCostOptions &
  OccupancyInputs & {
    surface: number | null;
    price: number;
    scenario: MarketCeilingScenarioKey | "custom";
    customSafetyDiscountPct?: number;
    medianPricePerM2?: number | null;
    p10PricePerM2?: number | null;
    p25PricePerM2?: number | null;
    p75PricePerM2?: number | null;
    p90PricePerM2?: number | null;
    manualMarketPricePerM2?: number | null;
  };

export type OccupancyAdjustment = {
  applied: boolean;
  status: OccupancyKind;
  discountPct: number;
  discountAmount: number;
  carryMonths: number;
  carryingCost: number;
  /** Baisse de la mise plafond causée par l'occupation, en euros. */
  bidReduction: number;
};

export type MarketCeilingResult = {
  available: boolean;
  reason?: string;
  /** Avertissement affiché à côté du plafond (ex. scénario prudent sans borne basse). */
  warning?: string;
  occupancy?: OccupancyAdjustment;
  surface: number;
  scenario: MarketCeilingScenarioKey | "custom";
  basis: MarketCeilingBasis | "manual" | "p25";
  basisLabel: string;
  marketReferencePricePerM2: number;
  safetyDiscountPct: number;
  safetyDiscountPerM2: number;
  maxAllInPricePerM2: number;
  targetTotalCost: number;
  maxBid: number;
  maxBidPricePerM2: number;
  maxBidIsReachable: boolean;
  simulated: AcquisitionCostResult;
  simulatedBidPricePerM2: number;
  simulatedAllInPricePerM2: number;
  marginTotal: number;
  marginPerM2: number;
  maxWorksAtSimulatedPrice: number;
  p10PricePerM2: number | null;
  p25PricePerM2: number | null;
  medianPricePerM2: number | null;
  p75PricePerM2: number | null;
  p90PricePerM2: number | null;
};

export type RecommendedCeilings = {
  withoutWorks: MarketCeilingResult;
  withRefreshWorks: MarketCeilingResult;
  refreshWorksBudget: number;
};

export type RentabilityScoreFactor = {
  key: string;
  label: string;
  delta: number;
  detail: string;
  tone: "positive" | "neutral" | "negative";
};

export type RentabilityScoreInputs = AcquisitionCostOptions & {
  surface: number | null;
  price: number;
  monthlyRent?: number | null;
  vacancyPct?: number;
  annualNonRecoverableCharges?: number | null;
  annualPropertyTax?: number | null;
  annualInsurance?: number | null;
  downPaymentPct?: number;
  annualInterestRatePct?: number;
  loanDurationYears?: number;
  loanInsuranceRatePct?: number;
  targetGrossYieldPct?: number;
  targetNetYieldPct?: number;
  marketMarginPerM2?: number | null;
};

export type RentabilityScoreResult = {
  available: boolean;
  reason: string | null;
  score: number | null;
  label: string;
  confidencePct: number;
  rentSource: "manual" | "department_estimate";
  monthlyRent: number | null;
  annualGrossRent: number | null;
  annualNetOperatingIncome: number | null;
  grossYieldPct: number | null;
  netYieldPct: number | null;
  annualDebtService: number | null;
  cashflowMonthly: number | null;
  cashOnCashPct: number | null;
  breakEvenOccupancyPct: number | null;
  totalCost: number;
  assumptions: {
    vacancyPct: number;
    annualNonRecoverableCharges: number;
    annualPropertyTax: number;
    annualInsurance: number;
    downPaymentPct: number;
    annualInterestRatePct: number;
    loanDurationYears: number;
    loanInsuranceRatePct: number;
    targetGrossYieldPct: number;
    targetNetYieldPct: number;
  };
  factors: RentabilityScoreFactor[];
};

function costOptionsOf(inputs: AcquisitionCostOptions): AcquisitionCostOptions {
  return {
    works: inputs.works,
    fpt: inputs.fpt,
    lawyerFees: inputs.lawyerFees,
    department: inputs.department,
    registrationRate: inputs.registrationRate,
    taxRegime: inputs.taxRegime,
  };
}

function occupancyAdjustment(
  inputs: OccupancyInputs,
  marketReferenceTotal: number,
): Omit<OccupancyAdjustment, "bidReduction"> {
  const status = inputs.occupancy ?? "free";
  const applied = status !== "free";
  const discountPct = clamp(inputs.occupancyDiscountPct ?? DEFAULTS.occupancyDiscountPct, 0, 60);
  const carryMonths = Math.max(0, Math.round(inputs.carryMonths ?? DEFAULTS.occupancyCarryMonths));
  return {
    applied,
    status,
    discountPct,
    discountAmount: applied ? Math.round(marketReferenceTotal * (discountPct / 100)) : 0,
    carryMonths,
    carryingCost: applied
      ? Math.round(carryMonths * Math.max(0, inputs.monthlyCarryCharges ?? 0))
      : 0,
  };
}

export function computeMarketCeiling(inputs: MarketCeilingInputs): MarketCeilingResult {
  const surface = Math.max(0, inputs.surface || 0);
  const costOptions = costOptionsOf(inputs);
  const simulated = computeAcquisitionCosts({ price: inputs.price, ...costOptions });

  if (surface <= 0) {
    return unavailableResult("Surface manquante", surface, inputs, simulated);
  }

  const manualMarket = cleanPositive(inputs.manualMarketPricePerM2);
  const scenarioConfig =
    MARKET_CEILING_SCENARIOS.find((item) => item.key === inputs.scenario) ??
    MARKET_CEILING_SCENARIOS.find((item) => item.key === DEFAULT_MARKET_CEILING_SCENARIO)!;
  const references = {
    manual: manualMarket,
    median: cleanPositive(inputs.medianPricePerM2),
    p10: cleanPositive(inputs.p10PricePerM2),
    p25: cleanPositive(inputs.p25PricePerM2),
  };
  const basis = (["manual", scenarioConfig.basis, "median", "p10", "p25"] as const).find(
    (candidate) => references[candidate] != null,
  );
  const marketReference = basis ? references[basis] : null;

  if (!marketReference || !basis) {
    return unavailableResult("Prix de marché local insuffisant", surface, inputs, simulated);
  }

  const safetyDiscountPct =
    inputs.scenario === "custom"
      ? clamp(inputs.customSafetyDiscountPct ?? DEFAULTS.safetyDiscountPct, 0, 40)
      : scenarioConfig.safetyDiscountPct;
  const maxAllInPricePerM2 = marketReference * (1 - safetyDiscountPct / 100);
  const occupancy = occupancyAdjustment(inputs, marketReference * surface);
  const targetBeforeOccupancy = Math.max(0, maxAllInPricePerM2 * surface);
  const targetTotalCost = Math.max(
    0,
    targetBeforeOccupancy - occupancy.discountAmount - occupancy.carryingCost,
  );
  const maxBid = solveMaxBid(targetTotalCost, costOptions);
  const maxBidFree = occupancy.applied ? solveMaxBid(targetBeforeOccupancy, costOptions) : maxBid;
  const maxBidCosts = computeAcquisitionCosts({ price: maxBid, ...costOptions });
  const maxBidIsReachable = maxBid > 0 && maxBidCosts.totalCost <= targetTotalCost + 1;
  // Le scénario prudent suppose une borne basse ; sans elle il retombe sur la
  // médiane, ce qui n'a plus rien de prudent et doit se voir.
  const prudentWithoutLowBound =
    inputs.scenario === "prudent" && basis !== "p10" && basis !== "manual";

  return {
    available: true,
    warning: prudentWithoutLowBound
      ? "Données insuffisantes : ce scénario n’est pas prudent. Faute de borne basse, la référence est la médiane locale."
      : undefined,
    occupancy: { ...occupancy, bidReduction: Math.max(0, maxBidFree - maxBid) },
    surface,
    scenario: inputs.scenario,
    basis,
    basisLabel: {
      manual: "prix marché saisi",
      median:
        scenarioConfig.basis === "p10" ? "médiane locale (P10 indisponible)" : "médiane locale",
      p10: "borne basse (P10)",
      p25: "premier quartile (P25)",
    }[basis],
    marketReferencePricePerM2: Math.round(marketReference),
    safetyDiscountPct,
    safetyDiscountPerM2: Math.round(marketReference - maxAllInPricePerM2),
    maxAllInPricePerM2: Math.round(maxAllInPricePerM2),
    targetTotalCost: Math.round(targetTotalCost),
    maxBid,
    maxBidPricePerM2: maxBid > 0 ? maxBid / surface : 0,
    maxBidIsReachable,
    simulated,
    simulatedBidPricePerM2: simulated.price / surface,
    simulatedAllInPricePerM2: simulated.totalCost / surface,
    marginTotal: Math.round(targetTotalCost - simulated.totalCost),
    marginPerM2: Math.round(targetTotalCost / surface - simulated.totalCost / surface),
    maxWorksAtSimulatedPrice: Math.max(
      0,
      Math.round(
        targetTotalCost -
          computeAcquisitionCosts({ price: simulated.price, ...costOptions, works: 0 }).totalCost,
      ),
    ),
    p10PricePerM2: cleanPositive(inputs.p10PricePerM2),
    p25PricePerM2: cleanPositive(inputs.p25PricePerM2),
    medianPricePerM2: cleanPositive(inputs.medianPricePerM2),
    p75PricePerM2: cleanPositive(inputs.p75PricePerM2),
    p90PricePerM2: cleanPositive(inputs.p90PricePerM2),
  };
}

export function computeRecommendedCeilings(
  inputs: Omit<MarketCeilingInputs, "works">,
): RecommendedCeilings {
  const refreshWorksBudget = estimateWorksBudget(inputs.surface, "rafraichissement");
  return {
    withoutWorks: computeMarketCeiling({ ...inputs, works: 0 }),
    withRefreshWorks: computeMarketCeiling({ ...inputs, works: refreshWorksBudget }),
    refreshWorksBudget,
  };
}

export function computeRentabilityScore(inputs: RentabilityScoreInputs): RentabilityScoreResult {
  const surface = Math.max(0, inputs.surface || 0);
  const acquisition = computeAcquisitionCosts({ price: inputs.price, ...costOptionsOf(inputs) });
  const assumptions = rentabilityAssumptions(inputs);
  const manualRent = cleanPositive(inputs.monthlyRent);
  const referenceRentPerM2 = defaultRentPerM2(inputs.department);
  const estimatedRent =
    surface > 0 && referenceRentPerM2 != null ? surface * referenceRentPerM2 : null;
  const monthlyRent = manualRent ?? estimatedRent;
  const rentSource = manualRent ? "manual" : "department_estimate";

  if (surface <= 0) {
    return unavailableRentabilityResult("Surface manquante", acquisition.totalCost, assumptions);
  }
  if (acquisition.totalCost <= 0 || !monthlyRent) {
    return unavailableRentabilityResult(
      acquisition.totalCost > 0 ? RENT_REFERENCE_UNAVAILABLE : "Prix ou loyer manquant",
      acquisition.totalCost,
      assumptions,
    );
  }

  const annualGrossRent = monthlyRent * 12;
  const vacancyLoss = annualGrossRent * (assumptions.vacancyPct / 100);
  const annualNetOperatingIncome =
    annualGrossRent -
    vacancyLoss -
    assumptions.annualNonRecoverableCharges -
    assumptions.annualPropertyTax -
    assumptions.annualInsurance;
  const grossYieldPct = (annualGrossRent / acquisition.totalCost) * 100;
  const netYieldPct = (annualNetOperatingIncome / acquisition.totalCost) * 100;
  const debt = computeDebtService(acquisition.totalCost, assumptions);
  const cashflowAnnual = annualNetOperatingIncome - debt.annualDebtService;
  const cashflowMonthly = cashflowAnnual / 12;
  const cashOnCashPct = debt.downPayment > 0 ? (cashflowAnnual / debt.downPayment) * 100 : null;
  const breakEvenOccupancyPct =
    annualGrossRent > 0
      ? ((assumptions.annualNonRecoverableCharges +
          assumptions.annualPropertyTax +
          assumptions.annualInsurance +
          debt.annualDebtService) /
          annualGrossRent) *
        100
      : null;

  const factors: RentabilityScoreFactor[] = [];
  let score = 50;
  score += addYieldFactor({
    factors,
    key: "gross_yield",
    label: "Rendement brut",
    valuePct: grossYieldPct,
    targetPct: assumptions.targetGrossYieldPct,
  });
  score += addYieldFactor({
    factors,
    key: "net_yield",
    label: "Rendement net estimé",
    valuePct: netYieldPct,
    targetPct: assumptions.targetNetYieldPct,
  });
  score += addCashflowFactor(factors, cashflowMonthly);
  score += addBreakEvenFactor(factors, breakEvenOccupancyPct);
  score += addMarketMarginFactor(factors, inputs.marketMarginPerM2);

  if (rentSource === "department_estimate") {
    factors.push({
      key: "rent_source",
      label: "Loyer estimé",
      delta: -4,
      detail: "Loyer par défaut issu du département : à remplacer par un loyer de marché vérifié.",
      tone: "negative",
    });
    score -= 4;
  }

  const finalScore = clampScore(Math.round(score));

  return {
    available: true,
    reason: null,
    score: finalScore,
    label: rentabilityLabel(finalScore),
    confidencePct: rentabilityConfidencePct({
      manualRent: Boolean(manualRent),
      marketMarginAvailable: inputs.marketMarginPerM2 != null,
      surface,
      totalCost: acquisition.totalCost,
    }),
    rentSource,
    monthlyRent: Math.round(monthlyRent),
    annualGrossRent: Math.round(annualGrossRent),
    annualNetOperatingIncome: Math.round(annualNetOperatingIncome),
    grossYieldPct: roundPct(grossYieldPct),
    netYieldPct: roundPct(netYieldPct),
    annualDebtService: Math.round(debt.annualDebtService),
    cashflowMonthly: Math.round(cashflowMonthly),
    cashOnCashPct: cashOnCashPct == null ? null : roundPct(cashOnCashPct),
    breakEvenOccupancyPct: breakEvenOccupancyPct == null ? null : roundPct(breakEvenOccupancyPct),
    totalCost: Math.round(acquisition.totalCost),
    assumptions,
    factors,
  };
}

export function marketCeilingVerdict(result: MarketCeilingResult): {
  label: string;
  detail: string;
  tone: "good" | "ok" | "warn" | "bad";
} {
  if (!result.available) {
    return {
      label: "Marché à compléter",
      detail: result.reason ?? "Il manque une référence de marché fiable.",
      tone: "warn",
    };
  }
  if (!result.maxBidIsReachable) {
    return {
      label: "Projet difficile à sécuriser",
      detail: "Les frais et travaux dépassent déjà le seuil de marché retenu.",
      tone: "bad",
    };
  }
  if (result.marginPerM2 >= 200) {
    return {
      label: "Sous le seuil de sécurité",
      detail: `${formatSigned(result.marginPerM2)} €/m² de marge tout compris.`,
      tone: "good",
    };
  }
  if (result.marginPerM2 >= 0) {
    return {
      label: "Encore dans la zone cible",
      detail: `${formatSigned(result.marginPerM2)} €/m² avant le seuil.`,
      tone: "ok",
    };
  }
  if (result.marginPerM2 >= -200) {
    return {
      label: "Seuil presque dépassé",
      detail: `${formatSigned(result.marginPerM2)} €/m² au-dessus du seuil.`,
      tone: "warn",
    };
  }
  return {
    label: "Au-dessus du marché cible",
    detail: `${formatSigned(result.marginPerM2)} €/m² au-dessus du seuil.`,
    tone: "bad",
  };
}

function solveMaxBid(targetTotalCost: number, options: AcquisitionCostOptions): number {
  if (targetTotalCost <= 0) return 0;
  const fixedCosts = computeAcquisitionCosts({ price: 0, ...options }).totalCost;
  if (fixedCosts >= targetTotalCost) return 0;

  let low = 0;
  let high = targetTotalCost;
  for (let index = 0; index < 48; index += 1) {
    const mid = (low + high) / 2;
    const total = computeAcquisitionCosts({ price: mid, ...options }).totalCost;
    if (total <= targetTotalCost) low = mid;
    else high = mid;
  }
  return Math.max(0, Math.floor(low / 100) * 100);
}

function rentabilityAssumptions(inputs: RentabilityScoreInputs) {
  const surface = Math.max(0, inputs.surface || 0);
  const estimatedMonthlyRent = surface * (defaultRentPerM2(inputs.department) ?? 0);
  const annualGrossRent = (cleanPositive(inputs.monthlyRent) ?? estimatedMonthlyRent) * 12;

  return {
    vacancyPct: clamp(inputs.vacancyPct ?? 5, 0, 35),
    annualNonRecoverableCharges: Math.max(
      0,
      inputs.annualNonRecoverableCharges ?? annualGrossRent * 0.07,
    ),
    annualPropertyTax: Math.max(0, inputs.annualPropertyTax ?? annualGrossRent * 0.08),
    annualInsurance: Math.max(0, inputs.annualInsurance ?? annualGrossRent * 0.015),
    downPaymentPct: clamp(inputs.downPaymentPct ?? 20, 0, 100),
    annualInterestRatePct: clamp(inputs.annualInterestRatePct ?? 4.2, 0, 20),
    loanDurationYears: Math.max(1, Math.min(35, Math.round(inputs.loanDurationYears ?? 20))),
    loanInsuranceRatePct: clamp(inputs.loanInsuranceRatePct ?? 0.25, 0, 5),
    targetGrossYieldPct: clamp(inputs.targetGrossYieldPct ?? 6.5, 0, 30),
    targetNetYieldPct: clamp(inputs.targetNetYieldPct ?? 4.5, 0, 25),
  };
}

function computeDebtService(
  totalCost: number,
  assumptions: ReturnType<typeof rentabilityAssumptions>,
) {
  const downPayment = totalCost * (assumptions.downPaymentPct / 100);
  const principal = Math.max(0, totalCost - downPayment);
  const monthlyRate = assumptions.annualInterestRatePct / 100 / 12;
  const months = assumptions.loanDurationYears * 12;
  const monthlyLoanPayment =
    principal <= 0
      ? 0
      : monthlyRate <= 0
        ? principal / months
        : (principal * monthlyRate) / (1 - (1 + monthlyRate) ** -months);
  const monthlyInsurance = (principal * (assumptions.loanInsuranceRatePct / 100)) / 12;

  return {
    downPayment,
    principal,
    annualDebtService: (monthlyLoanPayment + monthlyInsurance) * 12,
  };
}

function addYieldFactor({
  factors,
  key,
  label,
  valuePct,
  targetPct,
}: {
  factors: RentabilityScoreFactor[];
  key: string;
  label: string;
  valuePct: number;
  targetPct: number;
}) {
  const spread = valuePct - targetPct;
  let delta = -12;
  if (spread >= 2) delta = 16;
  else if (spread >= 0) delta = 10;
  else if (spread >= -1) delta = 4;

  factors.push({
    key,
    label,
    delta,
    detail: `${formatPct(valuePct)} vs objectif ${formatPct(targetPct)}.`,
    tone: delta > 0 ? "positive" : delta === 4 ? "neutral" : "negative",
  });
  return delta;
}

function addCashflowFactor(factors: RentabilityScoreFactor[], cashflowMonthly: number) {
  let delta = -14;
  if (cashflowMonthly >= 300) delta = 14;
  else if (cashflowMonthly >= 0) delta = 8;
  else if (cashflowMonthly >= -150) delta = -6;

  factors.push({
    key: "cashflow",
    label: "Cashflow mensuel",
    delta,
    detail: `${Math.round(cashflowMonthly).toLocaleString("fr-FR")} €/mois après dette estimée.`,
    tone: delta > 0 ? "positive" : delta > -10 ? "neutral" : "negative",
  });
  return delta;
}

function addBreakEvenFactor(
  factors: RentabilityScoreFactor[],
  breakEvenOccupancyPct: number | null,
) {
  if (breakEvenOccupancyPct == null) return 0;

  let delta = -12;
  if (breakEvenOccupancyPct <= 80) delta = 8;
  else if (breakEvenOccupancyPct <= 92) delta = 2;
  else if (breakEvenOccupancyPct <= 100) delta = -4;

  factors.push({
    key: "break_even",
    label: "Occupation d'équilibre",
    delta,
    detail: `${formatPct(breakEvenOccupancyPct)} d'occupation nécessaire pour couvrir charges et dette.`,
    tone: delta > 0 ? "positive" : delta >= 0 ? "neutral" : "negative",
  });
  return delta;
}

function addMarketMarginFactor(
  factors: RentabilityScoreFactor[],
  marketMarginPerM2: number | null | undefined,
) {
  if (marketMarginPerM2 == null || !Number.isFinite(marketMarginPerM2)) return 0;

  let delta = -10;
  if (marketMarginPerM2 >= 250) delta = 10;
  else if (marketMarginPerM2 >= 0) delta = 5;
  else if (marketMarginPerM2 >= -150) delta = -4;

  factors.push({
    key: "market_margin",
    label: "Marge vs marché cible",
    delta,
    detail: `${formatSigned(marketMarginPerM2)} €/m² par rapport au seuil tout compris.`,
    tone: delta > 0 ? "positive" : delta >= 0 ? "neutral" : "negative",
  });
  return delta;
}

function rentabilityLabel(score: number): string {
  if (score >= 80) return "Très rentable à confirmer";
  if (score >= 65) return "Rendement attractif";
  if (score >= 50) return "Équilibre à travailler";
  return "Rentabilité fragile";
}

function rentabilityConfidencePct({
  manualRent,
  marketMarginAvailable,
  surface,
  totalCost,
}: {
  manualRent: boolean;
  marketMarginAvailable: boolean;
  surface: number;
  totalCost: number;
}) {
  let confidence = 45;
  if (surface > 0) confidence += 15;
  if (totalCost > 0) confidence += 15;
  if (manualRent) confidence += 15;
  if (marketMarginAvailable) confidence += 10;
  return clamp(Math.round(confidence), 0, 95);
}

function unavailableRentabilityResult(
  reason: string,
  totalCost: number,
  assumptions: ReturnType<typeof rentabilityAssumptions>,
): RentabilityScoreResult {
  return {
    available: false,
    reason,
    score: null,
    label: "Rentabilité à compléter",
    confidencePct: 0,
    rentSource: "department_estimate",
    monthlyRent: null,
    annualGrossRent: null,
    annualNetOperatingIncome: null,
    grossYieldPct: null,
    netYieldPct: null,
    annualDebtService: null,
    cashflowMonthly: null,
    cashOnCashPct: null,
    breakEvenOccupancyPct: null,
    totalCost: Math.round(totalCost),
    assumptions,
    factors: [],
  };
}

function unavailableResult(
  reason: string,
  surface: number,
  inputs: MarketCeilingInputs,
  simulated: AcquisitionCostResult,
): MarketCeilingResult {
  return {
    available: false,
    reason,
    surface,
    scenario: inputs.scenario,
    basis: "manual",
    basisLabel: "à compléter",
    marketReferencePricePerM2: 0,
    safetyDiscountPct: inputs.customSafetyDiscountPct ?? DEFAULTS.safetyDiscountPct,
    safetyDiscountPerM2: 0,
    maxAllInPricePerM2: 0,
    targetTotalCost: 0,
    maxBid: 0,
    maxBidPricePerM2: 0,
    maxBidIsReachable: false,
    simulated,
    simulatedBidPricePerM2: surface > 0 ? simulated.price / surface : 0,
    simulatedAllInPricePerM2: surface > 0 ? simulated.totalCost / surface : 0,
    marginTotal: 0,
    marginPerM2: 0,
    maxWorksAtSimulatedPrice: 0,
    p10PricePerM2: cleanPositive(inputs.p10PricePerM2),
    p25PricePerM2: cleanPositive(inputs.p25PricePerM2),
    medianPricePerM2: cleanPositive(inputs.medianPricePerM2),
    p75PricePerM2: cleanPositive(inputs.p75PricePerM2),
    p90PricePerM2: cleanPositive(inputs.p90PricePerM2),
  };
}

function cleanPositive(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function roundPct(value: number): number {
  return Math.round(value * 10) / 10;
}

function clampScore(value: number): number {
  return clamp(value, 0, 100);
}

function formatSigned(value: number): string {
  if (Math.abs(value) < 1) return "0";
  return `${value > 0 ? "+" : ""}${Math.round(value)}`;
}

function formatPct(value: number): string {
  return `${roundPct(value).toLocaleString("fr-FR")} %`;
}
