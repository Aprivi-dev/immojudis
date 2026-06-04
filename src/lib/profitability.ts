// Calcul d'un seuil d'enchère basé sur le marché local DVF.
// Toutes les valeurs sont en euros sauf indication.

// ─── Barème officiel des émoluments d'avocat poursuivant ─────────────────
// Article A444-191 du Code de commerce (tarif dégressif, HT).
// https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000031012386
const EMOLUMENT_BRACKETS: Array<{ upTo: number; rate: number }> = [
  { upTo: 6_500, rate: 0.07 },
  { upTo: 17_000, rate: 0.0385 },
  { upTo: 30_000, rate: 0.0275 },
  { upTo: Infinity, rate: 0.015 },
];

const VAT = 0.2;
const REGISTRATION = 0.058;

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
  safetyDiscountPct: 12,
};

export type AcquisitionCostResult = {
  price: number;
  emolumentsHT: number;
  emolumentsTTC: number;
  registrationDuties: number;
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
}: {
  price: number;
  works?: number;
  fpt?: number;
}): AcquisitionCostResult {
  const cleanPrice = Math.max(0, price || 0);
  const cleanWorks = Math.max(0, works || 0);
  const cleanFpt = Math.max(0, fpt || 0);
  const emolumentsHT = computeEmolumentsHT(cleanPrice);
  const emolumentsTTC = emolumentsHT * (1 + VAT);
  const registrationDuties = cleanPrice * REGISTRATION;
  const acquisitionFeesTotal = emolumentsTTC + registrationDuties + cleanFpt;
  const totalCost = cleanPrice + acquisitionFeesTotal + cleanWorks;

  return {
    price: cleanPrice,
    emolumentsHT,
    emolumentsTTC,
    registrationDuties,
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
    basis: "p25",
    basisLabel: "bas de marché",
    safetyDiscountPct: 10,
    description: "On part du quart bas des ventes et on garde une marge forte.",
  },
  {
    key: "equilibre",
    label: "Équilibré",
    basis: "median",
    basisLabel: "médiane locale",
    safetyDiscountPct: 12,
    description: "Lecture centrale : prix médian du secteur moins une marge de sécurité.",
  },
  {
    key: "offensif",
    label: "Offensif",
    basis: "median",
    basisLabel: "médiane locale",
    safetyDiscountPct: 6,
    description: "Marge plus courte, à réserver aux dossiers très lisibles.",
  },
] as const;

export type MarketCeilingScenarioKey = (typeof MARKET_CEILING_SCENARIOS)[number]["key"];
export type MarketCeilingBasis = (typeof MARKET_CEILING_SCENARIOS)[number]["basis"];

export type MarketCeilingInputs = {
  surface: number | null;
  price: number;
  works?: number;
  fpt?: number;
  scenario: MarketCeilingScenarioKey | "custom";
  customSafetyDiscountPct?: number;
  medianPricePerM2?: number | null;
  p25PricePerM2?: number | null;
  p75PricePerM2?: number | null;
  manualMarketPricePerM2?: number | null;
};

export type MarketCeilingResult = {
  available: boolean;
  reason?: string;
  surface: number;
  scenario: MarketCeilingScenarioKey | "custom";
  basis: MarketCeilingBasis | "manual";
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
  p25PricePerM2: number | null;
  medianPricePerM2: number | null;
  p75PricePerM2: number | null;
};

export function computeMarketCeiling(inputs: MarketCeilingInputs): MarketCeilingResult {
  const surface = Math.max(0, inputs.surface || 0);
  const simulated = computeAcquisitionCosts({
    price: inputs.price,
    works: inputs.works,
    fpt: inputs.fpt,
  });

  if (surface <= 0) {
    return unavailableResult("Surface manquante", surface, inputs, simulated);
  }

  const manualMarket = cleanPositive(inputs.manualMarketPricePerM2);
  const scenarioConfig =
    MARKET_CEILING_SCENARIOS.find((item) => item.key === inputs.scenario) ??
    MARKET_CEILING_SCENARIOS.find((item) => item.key === "equilibre")!;
  const basis = manualMarket ? "manual" : scenarioConfig.basis;
  const marketReference =
    manualMarket ??
    cleanPositive(basis === "p25" ? inputs.p25PricePerM2 : inputs.medianPricePerM2) ??
    cleanPositive(inputs.medianPricePerM2) ??
    cleanPositive(inputs.p25PricePerM2);

  if (!marketReference) {
    return unavailableResult("Prix de marché local insuffisant", surface, inputs, simulated);
  }

  const safetyDiscountPct =
    inputs.scenario === "custom"
      ? clamp(inputs.customSafetyDiscountPct ?? DEFAULTS.safetyDiscountPct, 0, 40)
      : scenarioConfig.safetyDiscountPct;
  const maxAllInPricePerM2 = marketReference * (1 - safetyDiscountPct / 100);
  const targetTotalCost = Math.max(0, maxAllInPricePerM2 * surface);
  const maxBid = solveMaxBid(targetTotalCost, inputs.works ?? 0, inputs.fpt ?? DEFAULTS.fpt);
  const maxBidCosts = computeAcquisitionCosts({
    price: maxBid,
    works: inputs.works,
    fpt: inputs.fpt,
  });
  const maxBidIsReachable = maxBid > 0 && maxBidCosts.totalCost <= targetTotalCost + 1;

  return {
    available: true,
    surface,
    scenario: inputs.scenario,
    basis,
    basisLabel: manualMarket ? "prix marché saisi" : scenarioConfig.basisLabel,
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
    marginPerM2: Math.round(maxAllInPricePerM2 - simulated.totalCost / surface),
    maxWorksAtSimulatedPrice: Math.max(
      0,
      Math.round(
        targetTotalCost -
          computeAcquisitionCosts({ price: simulated.price, works: 0, fpt: inputs.fpt }).totalCost,
      ),
    ),
    p25PricePerM2: cleanPositive(inputs.p25PricePerM2),
    medianPricePerM2: cleanPositive(inputs.medianPricePerM2),
    p75PricePerM2: cleanPositive(inputs.p75PricePerM2),
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

function solveMaxBid(targetTotalCost: number, works: number, fpt: number): number {
  if (targetTotalCost <= 0) return 0;
  const fixedCosts = computeAcquisitionCosts({ price: 0, works, fpt }).totalCost;
  if (fixedCosts >= targetTotalCost) return 0;

  let low = 0;
  let high = targetTotalCost;
  for (let index = 0; index < 48; index += 1) {
    const mid = (low + high) / 2;
    const total = computeAcquisitionCosts({ price: mid, works, fpt }).totalCost;
    if (total <= targetTotalCost) low = mid;
    else high = mid;
  }
  return Math.max(0, Math.floor(low / 100) * 100);
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
    p25PricePerM2: cleanPositive(inputs.p25PricePerM2),
    medianPricePerM2: cleanPositive(inputs.medianPricePerM2),
    p75PricePerM2: cleanPositive(inputs.p75PricePerM2),
  };
}

function cleanPositive(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatSigned(value: number): string {
  if (Math.abs(value) < 1) return "0";
  return `${value > 0 ? "+" : ""}${Math.round(value)}`;
}
