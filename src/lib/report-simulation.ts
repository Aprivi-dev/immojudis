import { z } from "zod";
import { buildCeilingSnapshot } from "./property-report/ceiling-snapshot";
import { listingValuationConflict } from "./listing-evidence";
import type { AuctionSale } from "./types";
import type { MarketEstimate } from "./market.server";

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

const pct = (max: number) => z.number().finite().min(0).max(max);
const optional = <T extends z.ZodTypeAny>(schema: T) => schema.nullable().optional();

export const ceilingChoicesSchema = z.object({
  project: z.enum(["habiter", "louer", "revendre"]).optional(),
  profile: z.enum(["prudent", "equilibre", "offensif"]).optional(),
  customMarginPct: optional(pct(50)),
  manualPricePerM2: optional(amount),
  works: optional(
    z.object({
      key: z.enum(["aucun", "rafraichissement", "confort", "premium", "devis"]),
      amount,
      months: optional(pct(60)),
    }),
  ),
  occupation: optional(z.enum(["libre", "occupe", "loue", "squat", "inconnu"])),
  releaseMonths: optional(pct(60)),
  releaseCost: optional(amount),
  rentedDiscountPct: optional(pct(50)),
  fpt: optional(amount),
  lawyerFees: optional(amount),
  registrationRatePct: optional(pct(20)),
  taxRegime: z.enum(["registration", "vat"]).optional(),
  monthlyCharges: optional(amount),
  annualPropertyTax: optional(amount),
  financingRatePct: optional(pct(20)),
  monthlyRent: optional(amount),
  targetNetYieldPct: optional(pct(30)),
  sellingCostsPct: optional(pct(15)),
});

export const reportSimulationSchema = z.object({
  version: z.literal(2),
  choices: ceilingChoicesSchema,
  expectedMaxBid: amount,
  rentalScenario: reportRentalScenarioSchema.optional(),
});
export type ReportSimulation = z.infer<typeof reportSimulationSchema>;

/** Scenario saved by reports made before the « compte à rebours » engine. */
const legacyReportSimulationSchema = z.object({
  price: amount,
  works: amount,
  fpt: amount,
  scenario: z.enum(["prudent", "offensif", "custom"]),
  manualMarketPricePerM2: amount.nullable(),
});

/** Recompute user hypotheses against the server's current property and market data. */
export function computeReportSimulation(
  sale: AuctionSale,
  market: MarketEstimate | null,
  input: ReportSimulation,
) {
  const conflict = listingValuationConflict(sale);
  if (conflict) throw new Error(conflict);
  const snapshot = buildCeilingSnapshot(sale, market?.actionable ? market : null, input.choices);
  if (!snapshot.available || snapshot.maxBid !== input.expectedMaxBid) {
    throw new Error(
      "Les données du scénario ont changé. Actualisez la fiche avant de sauvegarder le rapport.",
    );
  }
  return {
    ...snapshot,
    personalRentalScenario: input.rentalScenario
      ? computeReportRentalScenario(input.rentalScenario)
      : null,
  };
}

const PROJECT_LABELS = { habiter: "Habiter", louer: "Louer", revendre: "Revendre" } as const;
const PROFILE_LABELS = {
  prudent: "Prudent",
  equilibre: "Équilibré",
  offensif: "Offensif",
} as const;
const OCCUPATION_LABELS = {
  libre: "Libre",
  occupe: "Occupé",
  loue: "Loué",
  squat: "Occupé sans droit ni titre",
  inconnu: "Non confirmée",
} as const;

/**
 * Part of a saved scenario that a public share link may carry: exactly what
 * `describeReportSimulation` shows. Rent, monthly charges, property tax, financing
 * rate and the rental scenario (rent, debt service) stay private to the owner.
 */
export function publicReportSimulation(value: unknown): Record<string, unknown> | null {
  const current = reportSimulationSchema.safeParse(value);
  if (current.success) {
    const { choices, expectedMaxBid } = current.data;
    return {
      version: 2,
      expectedMaxBid,
      choices: {
        project: choices.project,
        profile: choices.profile,
        customMarginPct: choices.customMarginPct,
        manualPricePerM2: choices.manualPricePerM2,
        works: choices.works ? { key: choices.works.key, amount: choices.works.amount } : undefined,
        occupation: choices.occupation,
        fpt: choices.fpt,
      },
    };
  }
  const legacy = legacyReportSimulationSchema.safeParse(value);
  return legacy.success ? legacy.data : null;
}

/** True for a scenario saved by the « compte à rebours » engine (costs at the starting price). */
export function isCurrentReportSimulation(value: unknown): boolean {
  return reportSimulationSchema.safeParse(value).success;
}

/** Lines describing a saved personal scenario, whatever version saved it. */
export function describeReportSimulation(value: unknown): Array<[string, string]> | null {
  const current = reportSimulationSchema.safeParse(value);
  const euros = (amount: number) =>
    new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency: "EUR",
      maximumFractionDigits: 0,
    }).format(amount);
  if (current.success) {
    const choices = current.data.choices;
    const rows: Array<[string, string]> = [
      ["Projet", PROJECT_LABELS[choices.project ?? "habiter"]],
      [
        "Profil",
        choices.customMarginPct != null
          ? `Marge personnalisée ${choices.customMarginPct} %`
          : PROFILE_LABELS[choices.profile ?? "equilibre"],
      ],
      ["Travaux retenus", choices.works?.amount ? euros(choices.works.amount) : "Aucun"],
      ["Frais préalables", choices.fpt != null ? euros(choices.fpt) : "Hypothèse Immojudis"],
    ];
    if (choices.occupation)
      rows.push(["Occupation retenue", OCCUPATION_LABELS[choices.occupation]]);
    if (choices.manualPricePerM2 != null)
      rows.push([
        "Prix au m² saisi",
        `${Math.round(choices.manualPricePerM2).toLocaleString("fr-FR")} €/m²`,
      ]);
    return rows;
  }
  const legacy = legacyReportSimulationSchema.safeParse(value);
  if (!legacy.success) return null;
  const rows: Array<[string, string]> = [
    ["Prix simulé", euros(legacy.data.price)],
    ["Travaux saisis", euros(legacy.data.works)],
    ["Frais préalables saisis", euros(legacy.data.fpt)],
    [
      "Scénario",
      { prudent: "Prudent", offensif: "Offensif", custom: "Personnalisé" }[legacy.data.scenario],
    ],
  ];
  if (legacy.data.manualMarketPricePerM2 != null)
    rows.push([
      "Référence de marché saisie",
      `${Math.round(legacy.data.manualMarketPricePerM2).toLocaleString("fr-FR")} €/m²`,
    ]);
  return rows;
}
