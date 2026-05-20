// Calcul de rentabilité spécifique aux ventes aux enchères judiciaires.
// Toutes les valeurs sont en euros sauf indication.

import { defaultRentPerM2 } from "./geo";

// ─── Barème officiel des émoluments d'avocat poursuivant ─────────────────
// Article A444-191 du Code de commerce (tarif dégressif, HT).
// https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000031012386
const EMOLUMENT_BRACKETS: Array<{ upTo: number; rate: number }> = [
  { upTo: 6_500, rate: 0.07 },
  { upTo: 17_000, rate: 0.0385 },
  { upTo: 30_000, rate: 0.0275 },
  { upTo: Infinity, rate: 0.015 },
];

const VAT = 0.2;             // TVA sur émoluments
const REGISTRATION = 0.058;  // Droits d'enregistrement (~5,80 %)

export function computeEmolumentsHT(price: number): number {
  let remaining = price;
  let prev = 0;
  let total = 0;
  for (const b of EMOLUMENT_BRACKETS) {
    if (remaining <= 0) break;
    const span = Math.min(remaining, b.upTo - prev);
    total += span * b.rate;
    remaining -= span;
    prev = b.upTo;
  }
  return total;
}

export type ProfitabilityInputs = {
  price: number;                  // prix d'adjudication
  surface: number | null;         // m²
  department: string | null;
  // mode expert (tous optionnels — defaults intelligents)
  rentPerM2?: number;             // €/m²/mois
  works?: number;                 // travaux
  fpt?: number;                   // frais préalables taxés
  vacancyPct?: number;            // taux de vacance %
  chargesPct?: number;            // charges non récup. en % du loyer annuel
  propertyTaxMonths?: number;     // taxe foncière en mois de loyer
  managementPct?: number;         // gestion locative %
};

export type ProfitabilityResult = {
  // coûts d'acquisition
  price: number;
  emolumentsHT: number;
  emolumentsTTC: number;
  registrationDuties: number;
  fpt: number;
  works: number;
  acquisitionFeesTotal: number;   // tous frais hors travaux
  acquisitionFeesPct: number;     // % du prix
  totalCost: number;              // coût de revient (prix + frais + travaux)
  // revenus
  monthlyRent: number;
  annualRent: number;
  // charges
  vacancyLoss: number;
  charges: number;
  propertyTax: number;
  management: number;
  netAnnualIncome: number;
  // rendements
  grossYieldPct: number;
  netYieldPct: number;
  // contexte
  rentPerM2Used: number;
  isRentEstimated: boolean;
};

export const DEFAULTS = {
  fpt: 3_000,
  vacancyPct: 8,
  chargesPct: 8,           // 8% du loyer annuel
  propertyTaxMonths: 1,    // ~1 mois de loyer
  managementPct: 0,        // gestion en direct par défaut
};

export function computeProfitability(inputs: ProfitabilityInputs): ProfitabilityResult {
  const price = Math.max(0, inputs.price || 0);
  const works = Math.max(0, inputs.works ?? 0);
  const fpt = Math.max(0, inputs.fpt ?? DEFAULTS.fpt);

  const emolumentsHT = computeEmolumentsHT(price);
  const emolumentsTTC = emolumentsHT * (1 + VAT);
  const registrationDuties = price * REGISTRATION;

  const acquisitionFeesTotal = emolumentsTTC + registrationDuties + fpt;
  const acquisitionFeesPct = price > 0 ? (acquisitionFeesTotal / price) * 100 : 0;
  const totalCost = price + acquisitionFeesTotal + works;

  const rentPerM2Used = inputs.rentPerM2 ?? defaultRentPerM2(inputs.department);
  const isRentEstimated = inputs.rentPerM2 == null;
  const monthlyRent = (inputs.surface ?? 0) * rentPerM2Used;
  const annualRent = monthlyRent * 12;

  const vacancyPct = inputs.vacancyPct ?? DEFAULTS.vacancyPct;
  const chargesPct = inputs.chargesPct ?? DEFAULTS.chargesPct;
  const propertyTaxMonths = inputs.propertyTaxMonths ?? DEFAULTS.propertyTaxMonths;
  const managementPct = inputs.managementPct ?? DEFAULTS.managementPct;

  const vacancyLoss = annualRent * (vacancyPct / 100);
  const charges = annualRent * (chargesPct / 100);
  const propertyTax = monthlyRent * propertyTaxMonths;
  const management = annualRent * (managementPct / 100);

  const netAnnualIncome = annualRent - vacancyLoss - charges - propertyTax - management;

  const grossYieldPct = totalCost > 0 ? (annualRent / totalCost) * 100 : 0;
  const netYieldPct = totalCost > 0 ? (netAnnualIncome / totalCost) * 100 : 0;

  return {
    price,
    emolumentsHT,
    emolumentsTTC,
    registrationDuties,
    fpt,
    works,
    acquisitionFeesTotal,
    acquisitionFeesPct,
    totalCost,
    monthlyRent,
    annualRent,
    vacancyLoss,
    charges,
    propertyTax,
    management,
    netAnnualIncome,
    grossYieldPct,
    netYieldPct,
    rentPerM2Used,
    isRentEstimated,
  };
}

export function yieldVerdict(netPct: number): { label: string; tone: "good" | "ok" | "warn" | "bad" } {
  if (netPct >= 6) return { label: "Rendement attractif", tone: "good" };
  if (netPct >= 4) return { label: "Rendement correct", tone: "ok" };
  if (netPct >= 2) return { label: "Rendement faible", tone: "warn" };
  return { label: "Rendement insuffisant", tone: "bad" };
}