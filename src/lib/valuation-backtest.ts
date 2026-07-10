import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import {
  buildDvfComparableAnalysis,
  type DvfComparableCandidate,
} from "@/lib/dvf-comparable-engine";
import { haversineKm } from "@/lib/geo";
import { featureIncluded, isPlanPeriodActive, normalizePlanCode } from "@/lib/plans";
import { cleanSaleTitle } from "@/lib/sale-title";
import { getSaleSurface } from "@/lib/surface";
import { recordFeatureUsageEvent } from "@/lib/usage";

type AppSaleRow = Database["public"]["Views"]["v_auction_sales_app"]["Row"];
type DvfTransactionRow = Database["public"]["Tables"]["dvf_transactions"]["Row"];
export type DvfBacktestTransaction = Pick<
  DvfTransactionRow,
  | "id"
  | "source_mutation_id"
  | "sale_date"
  | "total_price_eur"
  | "built_surface_m2"
  | "price_per_m2"
  | "property_type"
  | "dvf_property_type_code"
  | "address"
  | "city"
  | "postal_code"
  | "parcel_id"
  | "department"
  | "latitude"
  | "longitude"
  | "source"
  | "source_url"
>;

const REFERENCE_SALE_COLUMNS =
  "id,title,city,department,postal_code,address,property_type,app_surface_m2,habitable_surface_m2,carrez_surface_m2,land_surface_m2,latitude,longitude";

const DVF_BACKTEST_COLUMNS =
  "id,source_mutation_id,sale_date,total_price_eur,built_surface_m2,price_per_m2,property_type,dvf_property_type_code,address,city,postal_code,parcel_id,department,latitude,longitude,source,source_url";

export const valuationBacktestQuerySchema = z.object({
  saleId: z.string().uuid(),
  radiusM: z.coerce.number().int().min(300).max(2_000).default(1_000),
  months: z.coerce.number().int().min(12).max(84).default(48),
  maxTests: z.coerce.number().int().min(5).max(80).default(30),
});

export type ValuationBacktestQueryInput = z.input<typeof valuationBacktestQuerySchema>;
export type ValuationBacktestQuery = z.output<typeof valuationBacktestQuerySchema>;

export type ValuationBacktestStatus = "strong" | "usable" | "fragile" | "missing";

export type ValuationBacktestPoint = {
  transactionId: string;
  saleDate: string;
  city: string | null;
  propertyType: string | null;
  surfaceM2: number;
  actualPriceEur: number;
  actualPricePerM2: number;
  predictedPriceEur: number | null;
  predictedPricePerM2: number | null;
  errorPct: number | null;
  absoluteErrorPct: number | null;
  comparableSampleSize: number;
  comparableMode: string | null;
  confidenceScore: number;
  distanceM: number | null;
};

export type ValuationBacktestSummary = {
  status: ValuationBacktestStatus;
  confidenceLabel: string;
  testedTransactions: number;
  candidateTransactions: number;
  usableTests: number;
  medianAbsoluteErrorPct: number | null;
  p75AbsoluteErrorPct: number | null;
  within10Pct: number | null;
  within20Pct: number | null;
  averageComparableSampleSize: number | null;
  interpretation: string;
};

export type ValuationBacktestResult = {
  available: boolean;
  summary: ValuationBacktestSummary;
  points: ValuationBacktestPoint[];
  scope: {
    radiusM: number;
    months: number;
    maxTests: number;
    sourceTable: "dvf_transactions";
  };
  nextActions: string[];
  limitations: string[];
};

export type ValuationBacktestResponse = {
  ok: true;
  sale: {
    id: string;
    title: string | null;
    city: string | null;
    department: string | null;
    propertyType: string | null;
    surfaceM2: number | null;
  };
  backtest: ValuationBacktestResult;
};

export type ValuationBacktestSaleContext = {
  department: string | null;
  propertyType: string | null;
  surfaceM2: number | null;
  latitude: number | null;
  longitude: number | null;
};

export async function getValuationBacktest({
  auth,
  input,
  now = new Date(),
}: {
  auth: SupabaseAuthContext;
  input: ValuationBacktestQuery;
  now?: Date;
}): Promise<ValuationBacktestResponse> {
  await assertValuationBacktestAvailable(auth);

  const sale = await getReferenceSale(auth, input.saleId);
  const latitude = finiteNumber(sale.latitude);
  const longitude = finiteNumber(sale.longitude);
  if (latitude == null || longitude == null) {
    throw new Error("Backtest indisponible : la vente n'est pas géocodée.");
  }

  const transactions = await fetchBacktestTransactions({
    sale,
    latitude,
    longitude,
    radiusM: input.radiusM,
    months: input.months,
    maxTests: input.maxTests,
    now,
  });
  const surface = getSaleSurface(sale);
  const backtest = buildValuationBacktest({
    transactions,
    reference: { latitude, longitude },
    subject: {
      propertyType: sale.property_type,
      surfaceM2: surface.value,
    },
    options: {
      radiusM: input.radiusM,
      months: input.months,
      maxTests: input.maxTests,
      now,
    },
  });

  await recordFeatureUsageEvent({
    auth,
    eventKey: "valuation.backtest_viewed",
    subjectType: "auction_sale",
    subjectId: sale.id,
    metadata: {
      status: backtest.summary.status,
      tested_transactions: backtest.summary.testedTransactions,
      usable_tests: backtest.summary.usableTests,
      median_absolute_error_pct: backtest.summary.medianAbsoluteErrorPct,
      radius_m: input.radiusM,
      months: input.months,
    },
  });

  return {
    ok: true,
    sale: {
      id: sale.id,
      title: cleanSaleTitle(sale.title),
      city: sale.city,
      department: sale.department,
      propertyType: sale.property_type,
      surfaceM2: surface.value,
    },
    backtest,
  };
}

export async function buildValuationBacktestForSale({
  sale,
  radiusM = 1_000,
  months = 48,
  maxTests = 30,
  now = new Date(),
}: {
  sale: ValuationBacktestSaleContext;
  radiusM?: number;
  months?: number;
  maxTests?: number;
  now?: Date;
}): Promise<ValuationBacktestResult> {
  const latitude = finiteNumber(sale.latitude);
  const longitude = finiteNumber(sale.longitude);
  if (latitude == null || longitude == null) {
    return missingBacktest({
      radiusM,
      months,
      maxTests,
      reason: "Vente non géocodée : backtest DVF indisponible.",
    });
  }

  const transactions = await fetchBacktestTransactions({
    sale,
    latitude,
    longitude,
    radiusM,
    months,
    maxTests,
    now,
  });

  return buildValuationBacktest({
    transactions,
    reference: { latitude, longitude },
    subject: {
      propertyType: sale.propertyType,
      surfaceM2: sale.surfaceM2,
    },
    options: {
      radiusM,
      months,
      maxTests,
      now,
    },
  });
}

async function assertValuationBacktestAvailable(auth: SupabaseAuthContext) {
  if (auth.isAdmin || auth.accountTier === "premium") return;

  const { data, error } = await auth.supabase
    .from("user_subscriptions")
    .select("plan_code,status,current_period_end")
    .eq("user_id", auth.userId)
    .maybeSingle();

  if (error) throw error;
  const plan =
    data && isPlanPeriodActive(data.status, data.current_period_end)
      ? normalizePlanCode(data.plan_code)
      : "decouverte";

  if (!featureIncluded(plan, "property.soldComparables")) {
    throw new Error("Backtest de valorisation réservé au plan Analyse.");
  }
}

export function buildValuationBacktest({
  transactions,
  reference,
  subject,
  options,
}: {
  transactions: DvfBacktestTransaction[];
  reference: { latitude: number; longitude: number };
  subject: { propertyType: string | null; surfaceM2: number | null };
  options: {
    radiusM: number;
    months: number;
    maxTests: number;
    now?: Date;
  };
}): ValuationBacktestResult {
  const now = options.now ?? new Date();
  const oldestTestDate = addMonthsDate(now, -options.months);
  const normalized = transactions
    .map((transaction) => normalizeTransaction(transaction, reference))
    .filter((transaction): transaction is NormalizedBacktestTransaction => transaction != null)
    .filter(
      (transaction) => transaction.distanceM == null || transaction.distanceM <= options.radiusM,
    )
    .sort((a, b) => new Date(b.saleDate).getTime() - new Date(a.saleDate).getTime());
  const eligibleTests = normalized
    .filter((transaction) => new Date(transaction.saleDate).getTime() >= oldestTestDate.getTime())
    .filter((transaction) => propertyTypeMatches(transaction.propertyType, subject.propertyType))
    .filter((transaction) => surfaceComparable(transaction.surfaceM2, subject.surfaceM2))
    .slice(0, options.maxTests);
  const points = eligibleTests.map((test) =>
    backtestPointForTransaction({
      test,
      pool: normalized,
      radiusM: options.radiusM,
      months: Math.min(36, options.months),
      now,
    }),
  );
  const summary = buildBacktestSummary({
    points,
    candidateTransactions: normalized.length,
  });

  return {
    available: summary.usableTests >= 3,
    summary,
    points,
    scope: {
      radiusM: options.radiusM,
      months: options.months,
      maxTests: options.maxTests,
      sourceTable: "dvf_transactions",
    },
    nextActions: backtestNextActions(summary),
    limitations: [
      "Ce backtest mesure la capacité du moteur DVF à retrouver des ventes passées proches ; il ne prédit pas la concurrence en audience.",
      "Les transactions DVF ne décrivent pas l'état intérieur, les travaux, l'occupation, les servitudes ni les modalités judiciaires.",
      "Un faible volume de tests ou une erreur élevée impose de renforcer la fourchette par des références manuelles.",
    ],
  };
}

async function getReferenceSale(
  auth: SupabaseAuthContext,
  saleId: string,
): Promise<AppSaleRow & { id: string }> {
  const { data, error } = await auth.supabase
    .from("v_auction_sales_app")
    .select(REFERENCE_SALE_COLUMNS)
    .eq("id", saleId)
    .maybeSingle();

  if (error) throw error;
  if (!data?.id) throw new Error("Vente introuvable ou non accessible.");
  return data as AppSaleRow & { id: string };
}

async function fetchBacktestTransactions({
  sale,
  latitude,
  longitude,
  radiusM,
  months,
  maxTests,
  now,
}: {
  sale: { department?: string | null };
  latitude: number;
  longitude: number;
  radiusM: number;
  months: number;
  maxTests: number;
  now: Date;
}): Promise<DvfBacktestTransaction[]> {
  const bbox = bboxAround(latitude, longitude, radiusM);
  const comparableLookbackMonths = Math.min(36, months);
  const minSaleDate = addMonths(now, -(months + comparableLookbackMonths));
  let query = supabaseAdmin
    .from("dvf_transactions")
    .select(DVF_BACKTEST_COLUMNS)
    .gte("sale_date", minSaleDate)
    .gte("latitude", bbox.latMin)
    .lte("latitude", bbox.latMax)
    .gte("longitude", bbox.lngMin)
    .lte("longitude", bbox.lngMax)
    .not("built_surface_m2", "is", null)
    .not("price_per_m2", "is", null)
    .gte("built_surface_m2", 9)
    .order("sale_date", { ascending: false })
    .limit(Math.min(2_000, Math.max(maxTests * 80, 240)));

  if (sale.department) query = query.eq("department", sale.department);

  const { data, error } = await query;
  if (error) throw new Error(`Backtest DVF indisponible : ${error.message}`);
  return (data ?? []) as DvfBacktestTransaction[];
}

type NormalizedBacktestTransaction = {
  id: string;
  saleDate: string;
  totalPriceEur: number;
  surfaceM2: number;
  pricePerM2: number;
  propertyType: string | null;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  parcelId: string | null;
  source: string | null;
  sourceUrl: string | null;
  latitude: number | null;
  longitude: number | null;
  distanceM: number | null;
};

function backtestPointForTransaction({
  test,
  pool,
  radiusM,
  months,
  now,
}: {
  test: NormalizedBacktestTransaction;
  pool: NormalizedBacktestTransaction[];
  radiusM: number;
  months: number;
  now: Date;
}): ValuationBacktestPoint {
  const testDate = new Date(test.saleDate);
  const candidates = pool
    .filter((candidate) => candidate.id !== test.id)
    .filter((candidate) => new Date(candidate.saleDate).getTime() < testDate.getTime())
    .map((candidate) => normalizedToCandidate(candidate, test))
    .filter((candidate) => candidate.distanceM == null || candidate.distanceM <= radiusM);
  const analysis = buildDvfComparableAnalysis({
    subject: {
      surfaceM2: test.surfaceM2,
      propertyType: test.propertyType,
      startingPriceEur: null,
    },
    candidates,
    options: {
      now: testDate.getTime() <= now.getTime() ? testDate : now,
      minSampleSize: 3,
      maxRadiusM: radiusM,
      maxAgeMonths: months,
      limit: 12,
    },
  });
  const predictedPricePerM2 = analysis.medianPricePerM2;
  const predictedPriceEur = predictedPricePerM2
    ? Math.round(predictedPricePerM2 * test.surfaceM2)
    : null;
  const errorPct =
    predictedPriceEur && test.totalPriceEur
      ? round(((predictedPriceEur - test.totalPriceEur) / test.totalPriceEur) * 100, 1)
      : null;

  return {
    transactionId: test.id,
    saleDate: test.saleDate,
    city: test.city,
    propertyType: test.propertyType,
    surfaceM2: test.surfaceM2,
    actualPriceEur: Math.round(test.totalPriceEur),
    actualPricePerM2: Math.round(test.pricePerM2),
    predictedPriceEur,
    predictedPricePerM2,
    errorPct,
    absoluteErrorPct: errorPct == null ? null : Math.abs(errorPct),
    comparableSampleSize: analysis.sampleSize,
    comparableMode: analysis.comparableMode,
    confidenceScore: analysis.confidenceScore,
    distanceM: test.distanceM,
  };
}

function buildBacktestSummary({
  points,
  candidateTransactions,
}: {
  points: ValuationBacktestPoint[];
  candidateTransactions: number;
}): ValuationBacktestSummary {
  const usable = points.filter(
    (point) => point.absoluteErrorPct != null && point.comparableSampleSize >= 3,
  );
  const errors = usable
    .map((point) => point.absoluteErrorPct)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b);
  const medianError = percentileRounded(errors, 0.5, 1);
  const p75Error = percentileRounded(errors, 0.75, 1);
  const status = backtestStatus({ usableTests: usable.length, medianError });
  const within10Pct = shareUnder(errors, 10);
  const within20Pct = shareUnder(errors, 20);

  return {
    status,
    confidenceLabel: backtestConfidenceLabel(status),
    testedTransactions: points.length,
    candidateTransactions,
    usableTests: usable.length,
    medianAbsoluteErrorPct: medianError,
    p75AbsoluteErrorPct: p75Error,
    within10Pct,
    within20Pct,
    averageComparableSampleSize: averageRounded(
      usable.map((point) => point.comparableSampleSize),
      1,
    ),
    interpretation: backtestInterpretation({ status, usableTests: usable.length, medianError }),
  };
}

function missingBacktest({
  radiusM,
  months,
  maxTests,
  reason,
}: {
  radiusM: number;
  months: number;
  maxTests: number;
  reason: string;
}): ValuationBacktestResult {
  return {
    available: false,
    summary: {
      status: "missing",
      confidenceLabel: "Backtest insuffisant",
      testedTransactions: 0,
      candidateTransactions: 0,
      usableTests: 0,
      medianAbsoluteErrorPct: null,
      p75AbsoluteErrorPct: null,
      within10Pct: null,
      within20Pct: null,
      averageComparableSampleSize: null,
      interpretation: reason,
    },
    points: [],
    scope: {
      radiusM,
      months,
      maxTests,
      sourceTable: "dvf_transactions",
    },
    nextActions: [
      "Compléter le géocodage ou élargir le périmètre de références.",
      "Recouper la fourchette avec des références manuelles avant de fixer le plafond.",
    ],
    limitations: [
      "Sans transaction DVF comparable testable, le backtest automatique est indisponible.",
    ],
  };
}

function normalizeTransaction(
  transaction: DvfBacktestTransaction,
  reference: { latitude: number; longitude: number },
): NormalizedBacktestTransaction | null {
  const surfaceM2 = positiveNumber(transaction.built_surface_m2);
  const totalPriceEur = positiveNumber(transaction.total_price_eur);
  const pricePerM2 = positiveNumber(transaction.price_per_m2);
  const saleDate = parseDate(transaction.sale_date);
  if (!surfaceM2 || !totalPriceEur || !pricePerM2 || !saleDate) return null;
  const latitude = finiteNumber(transaction.latitude);
  const longitude = finiteNumber(transaction.longitude);
  const distanceM =
    latitude != null && longitude != null
      ? Math.round(
          haversineKm(
            { lat: reference.latitude, lng: reference.longitude },
            { lat: latitude, lng: longitude },
          ) * 1_000,
        )
      : null;

  return {
    id: transaction.source_mutation_id || transaction.id,
    saleDate: transaction.sale_date,
    totalPriceEur,
    surfaceM2,
    pricePerM2,
    propertyType: transaction.property_type ?? transaction.dvf_property_type_code,
    address: transaction.address,
    city: transaction.city,
    postalCode: transaction.postal_code,
    parcelId: transaction.parcel_id,
    source: transaction.source,
    sourceUrl: transaction.source_url,
    latitude,
    longitude,
    distanceM,
  };
}

function normalizedToCandidate(
  transaction: NormalizedBacktestTransaction,
  test: NormalizedBacktestTransaction,
): DvfComparableCandidate {
  const distanceM =
    transaction.latitude != null &&
    transaction.longitude != null &&
    test.latitude != null &&
    test.longitude != null
      ? Math.round(
          haversineKm(
            { lat: test.latitude, lng: test.longitude },
            { lat: transaction.latitude, lng: transaction.longitude },
          ) * 1_000,
        )
      : transaction.distanceM;

  return {
    id: transaction.id,
    saleDate: transaction.saleDate,
    totalPriceEur: transaction.totalPriceEur,
    surfaceM2: transaction.surfaceM2,
    pricePerM2: transaction.pricePerM2,
    propertyType: transaction.propertyType,
    distanceM,
    address: transaction.address,
    city: transaction.city,
    postalCode: transaction.postalCode,
    parcelId: transaction.parcelId,
    source: transaction.source,
    sourceUrl: transaction.sourceUrl,
  };
}

function backtestStatus({
  usableTests,
  medianError,
}: {
  usableTests: number;
  medianError: number | null;
}): ValuationBacktestStatus {
  if (usableTests < 3 || medianError == null) return "missing";
  if (usableTests >= 10 && medianError <= 12) return "strong";
  if (usableTests >= 6 && medianError <= 20) return "usable";
  return "fragile";
}

function backtestConfidenceLabel(status: ValuationBacktestStatus): string {
  if (status === "strong") return "Backtest robuste";
  if (status === "usable") return "Backtest exploitable";
  if (status === "fragile") return "Backtest fragile";
  return "Backtest insuffisant";
}

function backtestInterpretation({
  status,
  usableTests,
  medianError,
}: {
  status: ValuationBacktestStatus;
  usableTests: number;
  medianError: number | null;
}) {
  if (status === "strong") {
    return `Le moteur retrouve les ventes proches avec une erreur médiane de ${medianError} % sur ${usableTests} test(s).`;
  }
  if (status === "usable") {
    return `Le backtest est exploitable, mais l'erreur médiane de ${medianError} % impose une marge de sécurité.`;
  }
  if (status === "fragile") {
    return `Le backtest reste fragile : ${usableTests} test(s), erreur médiane ${medianError ?? "n/a"} %.`;
  }
  return "Pas assez de transactions passées comparables pour valider statistiquement la fourchette.";
}

function backtestNextActions(summary: ValuationBacktestSummary): string[] {
  if (summary.status === "strong") {
    return [
      "Utiliser la médiane DVF comme repère principal, en gardant les limites juridiques du dossier.",
      "Contrôler les points travaux, occupation et servitudes avant de figer le plafond.",
    ];
  }
  if (summary.status === "usable") {
    return [
      "Appliquer une marge de sécurité au moins égale à l'erreur médiane observée.",
      "Relire les comparables extrêmes et vérifier l'homogénéité du quartier.",
    ];
  }
  return [
    "Compléter la fourchette avec des références manuelles ou un avis local.",
    "Éviter de fixer la mise maximale uniquement à partir de la médiane DVF.",
  ];
}

function surfaceComparable(surfaceM2: number, subjectSurfaceM2: number | null): boolean {
  if (!subjectSurfaceM2 || subjectSurfaceM2 <= 0) return true;
  const deltaPct = Math.abs((surfaceM2 - subjectSurfaceM2) / subjectSurfaceM2) * 100;
  return deltaPct <= 60;
}

function propertyTypeMatches(value: string | null, reference: string | null): boolean {
  const referenceFamily = propertyTypeFamily(reference);
  if (referenceFamily === "unknown") return true;
  return propertyTypeFamily(value) === referenceFamily;
}

function propertyTypeFamily(value: string | null | undefined): string {
  const text = (value ?? "").toLowerCase();
  if (/maison|house|villa|pavillon/.test(text)) return "house";
  if (/appartement|apartment|studio|t1|t2|t3|t4/.test(text)) return "apartment";
  if (/immeuble|building/.test(text)) return "building";
  if (/terrain|land/.test(text)) return "land";
  return text.trim() || "unknown";
}

function bboxAround(lat: number, lng: number, radiusM: number) {
  const dLat = radiusM / 111_000;
  const dLng = radiusM / (111_000 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return {
    latMin: lat - dLat,
    latMax: lat + dLat,
    lngMin: lng - dLng,
    lngMax: lng + dLng,
  };
}

function addMonths(date: Date, months: number): string {
  return addMonthsDate(date, months).toISOString().slice(0, 10);
}

function addMonthsDate(date: Date, months: number): Date {
  const copy = new Date(date);
  copy.setUTCMonth(copy.getUTCMonth() + months);
  return copy;
}

function percentileRounded(values: number[], percentile: number, digits = 0): number | null {
  if (!values.length) return null;
  const index = (values.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const value =
    lower === upper
      ? values[lower]
      : values[lower] + (values[upper] - values[lower]) * (index - lower);
  return round(value, digits);
}

function shareUnder(values: number[], threshold: number): number | null {
  if (!values.length) return null;
  return round((values.filter((value) => value <= threshold).length / values.length) * 100, 1);
}

function averageRounded(values: number[], digits = 0): number | null {
  if (!values.length) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length, digits);
}

function positiveNumber(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function finiteNumber(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
