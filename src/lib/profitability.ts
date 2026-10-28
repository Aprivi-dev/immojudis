// Calcul d'un seuil d'enchère basé sur le marché local DVF.
// Toutes les valeurs sont en euros sauf indication.
import { clamp } from "@/lib/guards";
import { departmentCode } from "@/lib/department-code";
import {
  defaultRentPerM2,
  RENT_REFERENCE_UNAVAILABLE,
  resolveRentReference,
  type RentReference,
  type RentReferenceSource,
} from "@/lib/rent-reference";

// ─── Barème des émoluments de l'avocat poursuivant ───────────────────────
// Article A444-191 du Code de commerce, qui renvoie au barème proportionnel
// dégressif de l'article A444-102 (tableau 5, modifié par l'arrêté du
// 28 février 2020). Taux HT appliqués tranche par tranche au prix
// d'adjudication. Valeurs recoupées sur plusieurs sources publiques le
// 09/10/2026 ; à confirmer sur Légifrance avant toute évolution :
// https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000041595310
export const EMOLUMENT_SCALE_REFERENCE = "art. A444-191 du Code de commerce";
export const EMOLUMENT_SCALE_DATE = "09/10/2026";
/** Une tranche d'un barème d'émoluments proportionnel dégressif : taux HT jusqu'à `upTo` (inclus). */
export type EmolumentBracket = { upTo: number; rate: number };
/** Barème de l'avocat poursuivant, celui de la vente au tribunal (régime de frais `tribunal`). */
export const TRIBUNAL_EMOLUMENT_BRACKETS: readonly EmolumentBracket[] = [
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

export function computeEmolumentsHT(
  price: number,
  brackets: readonly EmolumentBracket[] = TRIBUNAL_EMOLUMENT_BRACKETS,
): number {
  let remaining = Math.max(0, price || 0);
  let prev = 0;
  let total = 0;
  for (const bracket of brackets) {
    if (remaining <= 0) break;
    const span = Math.min(remaining, bracket.upTo - prev);
    total += span * bracket.rate;
    remaining -= span;
    prev = bracket.upTo;
  }
  return total;
}

/**
 * Frais préalables retenus quand l'annonce ne les chiffre pas. Source unique : le simulateur de
 * frais, les rapports et l'enchère plafond la partagent. Prudent (5 000 €), car ils varient de
 * 2 000 à plus de 10 000 € selon la procédure ; le montant exact est dans le cahier des
 * conditions de vente.
 */
export const DEFAULT_PRELIMINARY_FEES = 5_000;

export const DEFAULTS = {
  fpt: DEFAULT_PRELIMINARY_FEES,
  works: 0,
  /** Honoraires de l'avocat enchérisseur, hors émoluments tarifés (TTC). */
  lawyerFees: 1_500,
};

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
  /** Barème d'émoluments du régime de frais ; absent : celui du tribunal (A444-191). */
  emolumentBrackets?: readonly EmolumentBracket[];
  /**
   * Frais d'organisation et de publicité d'une vente notariale à la bougie : part HT du prix (par
   * exemple 0,02), TVA en sus. Ils entrent dans la base des droits de mutation.
   */
  organizationFeeRate?: number;
  /**
   * Honoraires de négociation à la charge de l'acquéreur (vente notariale interactive) : part du
   * prix. Ils sont exclus de la base des droits (BOFiP, § 30 et 230 relevés par la recherche du
   * 26/10/2026 ; à confirmer sur le BOFiP).
   */
  negotiationFeeRate?: number;
  /** Frais de publicité à la charge de l'acquéreur (vente notariale interactive), en euros. */
  advertisingFees?: number;
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
  /** Frais d'organisation et de publicité d'une vente à la bougie, TTC (0 hors de ce régime). */
  organizationFees: number;
  /** Honoraires de négociation de l'acquéreur (0 hors vente interactive). */
  negotiationFees: number;
  /** Frais de publicité de l'acquéreur (0 hors vente interactive). */
  advertisingFees: number;
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
  emolumentBrackets,
  organizationFeeRate = 0,
  negotiationFeeRate = 0,
  advertisingFees = 0,
}: { price: number } & AcquisitionCostOptions): AcquisitionCostResult {
  const cleanPrice = Math.max(0, price || 0);
  const cleanWorks = Math.max(0, works || 0);
  const cleanFpt = Math.max(0, fpt || 0);
  const cleanLawyerFees = Math.max(0, lawyerFees || 0);
  const emolumentsHT = computeEmolumentsHT(cleanPrice, emolumentBrackets);
  const emolumentsTTC = emolumentsHT * (1 + VAT);
  const organizationFees = cleanPrice * clampRate(organizationFeeRate) * (1 + VAT);
  const negotiationFees = cleanPrice * clampRate(negotiationFeeRate);
  const cleanAdvertisingFees = Math.max(0, advertisingFees || 0);
  // Base des droits de mutation : le prix, plus les charges que l'acquéreur supporte en plus du
  // prix et qui profitent au vendeur (frais d'organisation et de publicité d'une vente à la
  // bougie, publicité d'une vente interactive). Les frais préalables de la saisie (frais de
  // poursuite taxés) en sont exclus : BOFiP BOI-ENR-DMTOI-10-10-30-20 (Adjudication), § 50, qui
  // renvoie à la réponse ministérielle Legendre n° 280 (JO Sénat du 27/11/1997, p. 3289). Les
  // honoraires de négociation en sont exclus aussi (ils ne profitent pas au vendeur). Avant la
  // version « 2026-10-26.2 » du moteur de plafond, les frais préalables étaient comptés dans la base.
  const taxableBase = cleanPrice + organizationFees + cleanAdvertisingFees;
  const rate =
    registrationRate != null && Number.isFinite(registrationRate) && registrationRate >= 0
      ? registrationRate
      : registrationRateForDepartment(department);
  const subjectToVat = taxRegime === "vat";
  const registrationDuties = subjectToVat ? 0 : taxableBase * rate;
  const vatOnPrice = subjectToVat ? cleanPrice * VAT : 0;
  const csi = subjectToVat ? 0 : taxableBase * CSI_RATE;
  const acquisitionFeesTotal =
    emolumentsTTC +
    registrationDuties +
    vatOnPrice +
    csi +
    cleanLawyerFees +
    cleanFpt +
    organizationFees +
    negotiationFees +
    cleanAdvertisingFees;
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
    organizationFees,
    negotiationFees,
    advertisingFees: cleanAdvertisingFees,
    works: cleanWorks,
    acquisitionFeesTotal,
    acquisitionFeesPct: cleanPrice > 0 ? (acquisitionFeesTotal / cleanPrice) * 100 : 0,
    totalCost,
  };
}

/** Un taux de frais en part du prix : entre 0 et 100 %, 0 si la valeur n'est pas un nombre. */
function clampRate(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

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
  /**
   * Coût d'acquisition déjà calculé avec les frais du régime de la vente (barème des émoluments,
   * frais d'organisation, honoraires de négociation, publicité : `computeAcquisitionCosts` avec les
   * `fees` du plafond). Il remplace le calcul fait ici avec les options du tribunal : sans lui, le
   * score d'une vente notariale se calculerait sur des frais qui ne sont pas les siens.
   */
  acquisition?: AcquisitionCostResult;
  monthlyRent?: number | null;
  /**
   * Référence de loyer de la vente (carte ANIL à la commune, lue côté serveur) ; absente, le loyer
   * départemental sert de repli.
   */
  rentReference?: RentReference | null;
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
  rentSource: "manual" | RentReferenceSource;
  /** Fiabilité et millésime de la référence ANIL utilisée ; `null` : loyer saisi ou aucune référence ANIL. */
  rentReliability: RentReference["reliability"] | null;
  rentVintage: number | null;
  rentSourceUpdatedOn: string | null;
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
    emolumentBrackets: inputs.emolumentBrackets,
  };
}

export function computeRentabilityScore(inputs: RentabilityScoreInputs): RentabilityScoreResult {
  const surface = Math.max(0, inputs.surface || 0);
  const acquisition =
    inputs.acquisition ??
    computeAcquisitionCosts({ price: inputs.price, ...costOptionsOf(inputs) });
  const assumptions = rentabilityAssumptions(inputs);
  const manualRent = cleanPositive(inputs.monthlyRent);
  const reference = resolveRentReference(inputs.rentReference, inputs.department);
  const estimatedRent = surface > 0 && reference != null ? surface * reference.rentPerM2 : null;
  const monthlyRent = manualRent ?? estimatedRent;
  const rentSource: RentabilityScoreResult["rentSource"] = manualRent
    ? "manual"
    : (reference?.source ?? "department_estimate");
  const anilReference = !manualRent && reference?.source.startsWith("anil_") ? reference : null;

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
  } else if (anilReference && anilReference.reliability !== "reliable") {
    factors.push({
      key: "rent_source",
      label: "Loyer estimé",
      delta: -4,
      detail:
        "Loyer d’annonce ANIL de fiabilité indicative (peu d’annonces observées dans la commune ou estimation sur un groupe de communes) : à remplacer par un loyer de marché vérifié.",
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
    rentReliability: anilReference?.reliability ?? null,
    rentVintage: anilReference?.vintage ?? null,
    rentSourceUpdatedOn: anilReference?.sourceUpdatedOn ?? null,
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

function rentabilityAssumptions(inputs: RentabilityScoreInputs) {
  const surface = Math.max(0, inputs.surface || 0);
  const estimatedMonthlyRent =
    surface * (defaultRentPerM2(inputs.department, inputs.rentReference) ?? 0);
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
    rentReliability: null,
    rentVintage: null,
    rentSourceUpdatedOn: null,
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
