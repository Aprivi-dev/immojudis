import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  CASE_STATUS_COLUMNS,
  PROJECTION_COLUMNS,
  PUBLISHABLE_COLUMNS,
  canonicalMismatchKeys,
  missingProjectionRows,
  sampledSaleIds,
  sanitizeProjectionRows,
  type CanonicalSaleRow,
} from "@/lib/ai-review-projection-rows";
import type { AiReviewProjectionReadModel } from "@/lib/ai-review-guard";
import { getAuctionScenarios } from "@/lib/auction-scenarios.server";
import { CEILING_ENGINE_VERSION } from "@/lib/bid-ceiling-engine";
import { FEE_REGIMES } from "@/lib/fee-regime";
import { openFeeRegimesFromEnv } from "@/lib/fee-regime.server";
import { evaluateSaleForPepite, type PepiteSaleFacts } from "@/lib/pepite-input";
import {
  PEPITE_REFRESH_HOURS,
  PEPITE_RULE_VERSION,
  applyPepiteStability,
  pepiteReasonCodes,
  type PepiteEvaluation,
  type PepiteStability,
  type PepiteStoredState,
  type PepiteStatus,
} from "@/lib/pepite-policy";
import {
  SALE_INPUT_SELECT,
  buildSaleValuationInput,
  marketContextFromStoredRow,
  saleValuationFingerprint,
} from "@/lib/sale-market-estimates";
import type { AuctionSale } from "@/lib/types";

/**
 * Calcule la pépite des ventes en ligne et la stocke (table `auction_sale_pepites`, voir la migration
 * 20261104100000). Le calcul reste en TypeScript : c'est le chemin de la fiche (assainissement de la
 * vente, relecture IA, conflit de valorisation, estimation stockée sans mise en file d'attente,
 * `computeSaleCeiling`), lu avec le rôle de service sur `v_auction_sales_app`, puis la règle
 * `pepite-v1` (`pepite-policy.ts`) et sa stabilité.
 *
 * Mode (`app_private.sale_pepite_settings`) : `off`, la passe ne fait rien ; `shadow`, les résultats sont
 * calculés et stockés mais rien n'est visible du public ; `on`, les fonctions publiques de lecture
 * rendent les pépites. Le mode ne change pas le calcul.
 *
 * Avant la migration, la passe se termine proprement sans rien faire (`skipped: "not_migrated"`) : la
 * lecture publique, elle, ne rendra « pas de pépite ».
 *
 * Ce traitement n'écrit jamais l'événement `bid_ceiling_calculated` ni aucune mesure d'audience, et
 * n'écrit aucun montant dans les journaux : ni la sortie du traitement ni ses erreurs n'en portent.
 * `investment_score`, les données d'avocat, de sponsoring et de profil n'entrent pas dans le calcul.
 */

const PAGE_SIZE = 1000;
/** Plafond de lecture : au-delà, le catalogue en ligne a changé d'échelle et la tâche doit être revue. */
const MAX_ONLINE_SALES = 20_000;
/** Lignes complètes lues par requête (une ligne pèse plusieurs dizaines de ko). */
const READ_CHUNK_SIZE = 25;
const MAX_REPORTED_ERRORS = 5;
/** Part d'évaluations tentées en échec à partir de laquelle la passe est déclarée en échec. */
export const SALE_PEPITES_FAILURE_RATE_THRESHOLD = 0.2;
/** Une évaluation plus ancienne est refaite : la fiche lit aussi des tables liées (documents, scénarios…). */
export const SALE_PEPITES_REFRESH_MS = PEPITE_REFRESH_HOURS * 3_600_000;

type PepiteTableInsert = Database["public"]["Tables"]["auction_sale_pepites"]["Insert"];
type EstimateRow = Database["public"]["Tables"]["auction_sale_market_estimates"]["Row"];

export type OnlineSale = {
  id: string;
  updatedAt: string | null;
  status: string | null;
  saleDate: string | null;
  venueType: string | null;
  startingPriceEur: number | null;
};

export type StoredEvaluation = {
  saleId: string;
  status: string;
  evaluatedAt: string;
  ruleVersion: string;
  engineVersion: string;
  regimeVersion: string | null;
  isPepite: boolean;
  favorableStreak: number;
  frozenAt: string | null;
  lastFavorableAt: string | null;
  dataMissingSince: string | null;
  inputStartingPriceEur: number | null;
  firstPepiteAt: string | null;
};

/** Les versions dont dépend un résultat : règle, moteur de plafond et régimes de frais. */
export type PepiteVersions = {
  rule: string;
  engine: string;
  regimes: readonly string[];
};

export function currentPepiteVersions(): PepiteVersions {
  return {
    rule: PEPITE_RULE_VERSION,
    engine: CEILING_ENGINE_VERSION,
    regimes: Object.values(FEE_REGIMES).flatMap((regime) => (regime ? [regime.version] : [])),
  };
}

export type SalePepitesBatchResult = {
  mode: string;
  skipped: "mode_off" | "not_migrated" | null;
  ruleVersion: string;
  online: number;
  pending: number;
  evaluated: number;
  favorable: number;
  published: number;
  notApplicable: number;
  insufficient: number;
  failed: number;
  remaining: number;
  errors: string[];
};

function time(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Une évaluation faite avec une autre version de la règle, du moteur ou d'un régime est obsolète. */
export function isObsoleteEvaluation(evaluation: StoredEvaluation, versions: PepiteVersions) {
  return (
    evaluation.ruleVersion !== versions.rule ||
    evaluation.engineVersion !== versions.engine ||
    (evaluation.regimeVersion != null && !versions.regimes.includes(evaluation.regimeVersion))
  );
}

/**
 * Ventes à (ré)évaluer, les plus urgentes d'abord :
 *   0. les pépites DÉJÀ publiées dont la vente, l'estimation ou le prix ont changé, qui sont évaluées sous
 *      une autre version, ou qui n'ont plus de donnée (délai de tolérance en cours) : une pépite affichée
 *      ne doit pas attendre derrière les ventes jamais évaluées ;
 *   1. jamais évaluées, les plus récemment modifiées en premier ;
 *   2. évaluées avec une autre version (règle, moteur, régime), les plus anciennes d'abord ;
 *   3. vente ou estimation modifiée depuis la dernière évaluation, les plus anciennes d'abord ;
 *   4. évaluées il y a plus de 24 h (tables liées), les plus anciennes d'abord, sauf une vente « non
 *      applicable » qui n'est plus à venir : rien n'y changera.
 * `estimateComputedAt` : date de calcul de l'estimation stockée de chaque vente.
 */
export function pickPendingSales(
  online: OnlineSale[],
  evaluations: StoredEvaluation[],
  estimateComputedAt: ReadonlyMap<string, string | null>,
  versions: PepiteVersions = currentPepiteVersions(),
  now: Date = new Date(),
): string[] {
  const evaluationBySale = new Map(evaluations.map((row) => [row.saleId, row]));
  const published: Array<{ id: string; evaluatedAt: number }> = [];
  const missing: OnlineSale[] = [];
  const outdated: Array<{ id: string; evaluatedAt: number }> = [];
  const modified: Array<{ id: string; evaluatedAt: number }> = [];
  const aged: Array<{ id: string; evaluatedAt: number }> = [];

  for (const sale of online) {
    const evaluation = evaluationBySale.get(sale.id);
    if (!evaluation) {
      missing.push(sale);
      continue;
    }
    const evaluatedAt = time(evaluation.evaluatedAt) ?? 0;
    const obsolete = isObsoleteEvaluation(evaluation, versions);
    const updatedAt = time(sale.updatedAt);
    const estimatedAt = time(estimateComputedAt.get(sale.id) ?? null);
    const changed =
      (updatedAt != null && updatedAt > evaluatedAt) ||
      (estimatedAt != null && estimatedAt > evaluatedAt) ||
      (evaluation.inputStartingPriceEur != null &&
        sale.startingPriceEur != null &&
        evaluation.inputStartingPriceEur !== sale.startingPriceEur);
    if (evaluation.isPepite && (obsolete || changed || evaluation.dataMissingSince != null)) {
      published.push({ id: sale.id, evaluatedAt });
    } else if (obsolete) {
      outdated.push({ id: sale.id, evaluatedAt });
    } else if (changed) {
      modified.push({ id: sale.id, evaluatedAt });
    } else if (
      now.getTime() - evaluatedAt > SALE_PEPITES_REFRESH_MS &&
      !(evaluation.status === "not_applicable" && !isUpcomingSale(sale, now))
    ) {
      aged.push({ id: sale.id, evaluatedAt });
    }
  }

  const byEvaluationDate = (
    left: { id: string; evaluatedAt: number },
    right: { id: string; evaluatedAt: number },
  ) => left.evaluatedAt - right.evaluatedAt || left.id.localeCompare(right.id);

  return [
    ...published.sort(byEvaluationDate).map((sale) => sale.id),
    ...missing
      .sort(
        (left, right) =>
          (time(right.updatedAt) ?? 0) - (time(left.updatedAt) ?? 0) ||
          left.id.localeCompare(right.id),
      )
      .map((sale) => sale.id),
    ...outdated.sort(byEvaluationDate).map((sale) => sale.id),
    ...modified.sort(byEvaluationDate).map((sale) => sale.id),
    ...aged.sort(byEvaluationDate).map((sale) => sale.id),
  ];
}

/** Vente à venir, datée dans le futur : la seule que la règle évalue. */
export function isUpcomingSale(
  sale: { status: string | null; saleDate: string | null },
  now: Date,
): boolean {
  const saleTime = time(sale.saleDate);
  return sale.status === "upcoming" && saleTime != null && saleTime > now.getTime();
}

/**
 * L'état stocké qui sert à la stabilité, QUELLE QUE SOIT sa version : un changement de version de la règle,
 * du moteur ou d'un régime ne remet pas la série à zéro. La vente est réévaluée tout de suite (voir
 * `pickPendingSales`) et une pépite publiée ne reste publiée que si la nouvelle évaluation passe les seuils
 * de sortie.
 */
export function storedStateFor(stored: StoredEvaluation | undefined): PepiteStoredState | null {
  if (!stored) return null;
  return {
    isPepite: stored.isPepite,
    favorableStreak: stored.favorableStreak,
    frozenAt: stored.frozenAt,
    lastFavorableAt: stored.lastFavorableAt,
    dataMissingSince: stored.dataMissingSince,
    inputStartingPriceEur: stored.inputStartingPriceEur,
  };
}

const roundEuro = (value: number | null) => (value == null ? null : Math.round(value));
const roundRatio = (value: number | null) =>
  value == null ? null : Math.round(value * 10_000) / 10_000;

/** Le détail privé stocké avec l'évaluation : jamais publié, jamais écrit dans un journal. */
export function pepiteDetails(evaluation: PepiteEvaluation, facts: PepiteSaleFacts | null): Json {
  const metrics = evaluation.metrics;
  return {
    venueType: facts?.venueType ?? null,
    regime: evaluation.regime,
    occupancy: facts?.occupancy ?? null,
    conditionStatus: facts?.conditionStatus ?? null,
    propertyType: facts?.propertyType ?? null,
    startingPriceEur: roundEuro(metrics.startingPriceEur),
    centralValueEur: roundEuro(metrics.centralValueEur),
    lowValueEur: roundEuro(metrics.lowValueEur),
    referenceCeilingEur: roundEuro(metrics.referenceCeilingEur),
    multiplierKey: metrics.multiplierKey,
    multiplier: roundRatio(metrics.multiplier),
    probablePriceEur: roundEuro(metrics.probablePriceEur),
    rangeLowEur: roundEuro(metrics.rangeLowEur),
    rangeHighEur: roundEuro(metrics.rangeHighEur),
    chanceShare: roundRatio(metrics.chanceShare),
    chanceAtLeast: metrics.chanceAtLeast,
    ceilingBelowStart: metrics.ceilingBelowStart,
    totalCostEur: roundEuro(metrics.totalCostEur),
    costRatio: roundRatio(metrics.costRatio),
    startingShareOfValue: roundRatio(metrics.startingShareOfValue),
    gapDiscountPct: facts?.gapDiscountPct ?? null,
    estimateReliability: facts?.estimateReliability ?? null,
    estimateEffectiveSample: facts?.estimateEffectiveSample ?? null,
    scenarios: facts?.scenarios ?? null,
    favorable: evaluation.favorable,
    holds: evaluation.holds,
    blocking: evaluation.blocking,
    holdMissed: evaluation.holdMissed,
  };
}

/** La ligne à écrire pour une évaluation et sa stabilité. */
export function buildPepiteRow({
  saleId,
  evaluation,
  stability,
  facts,
  stored,
  versions,
  startingPriceEur,
  now,
}: {
  saleId: string;
  evaluation: PepiteEvaluation;
  stability: PepiteStability;
  facts: PepiteSaleFacts | null;
  stored: StoredEvaluation | undefined;
  versions: PepiteVersions;
  startingPriceEur: number | null;
  now: Date;
}): PepiteTableInsert {
  return {
    sale_id: saleId,
    rule_version: versions.rule,
    engine_version: versions.engine,
    regime_version: facts?.regimeVersion ?? null,
    status: evaluation.status,
    is_pepite: stability.isPepite,
    favorable_streak: stability.favorableStreak,
    frozen_at: stability.frozenAt,
    last_favorable_at: stability.lastFavorableAt,
    data_missing_since: stability.dataMissingSince,
    reason_codes: pepiteReasonCodes(evaluation, stability),
    details: pepiteDetails(evaluation, facts),
    // La colonne refuse une valeur qui n'est pas strictement positive.
    input_starting_price_eur:
      startingPriceEur != null && Number.isFinite(startingPriceEur) && startingPriceEur > 0
        ? startingPriceEur
        : null,
    input_estimate_computed_at: facts?.estimateComputedAt ?? null,
    evaluated_at: now.toISOString(),
    first_pepite_at: stored?.firstPepiteAt ?? (stability.isPepite ? now.toISOString() : null),
  };
}

/** Une vente qui n'est pas à venir : « non applicable », sans lecture de la ligne complète. */
export function buildNotApplicableRow(
  sale: OnlineSale,
  stored: StoredEvaluation | undefined,
  versions: PepiteVersions,
  now: Date,
): PepiteTableInsert {
  const evaluation: PepiteEvaluation = {
    ruleVersion: versions.rule,
    status: "not_applicable",
    regime: null,
    favorable: false,
    holds: false,
    blocking: false,
    passed: [],
    missed: ["sale_upcoming"],
    holdMissed: ["sale_upcoming"],
    metrics: {
      startingPriceEur: null,
      centralValueEur: null,
      lowValueEur: null,
      referenceCeilingEur: null,
      multiplierKey: null,
      multiplier: null,
      probablePriceEur: null,
      rangeLowEur: null,
      rangeHighEur: null,
      chanceShare: null,
      chanceAtLeast: false,
      ceilingBelowStart: false,
      totalCostEur: null,
      costRatio: null,
      startingShareOfValue: null,
    },
  };
  return buildPepiteRow({
    saleId: sale.id,
    evaluation,
    stability: {
      isPepite: false,
      favorableStreak: 0,
      frozenAt: null,
      lastFavorableAt: null,
      dataMissingSince: null,
      codes: [],
    },
    facts: null,
    stored,
    versions,
    startingPriceEur: null,
    now,
  });
}

/** Table ou fonction inconnue de la base : la migration n'est pas encore appliquée (déploiement échelonné). */
function isMissingDatabaseObject(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "PGRST202" || code === "PGRST205" || code === "42883" || code === "42P01";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/** Mode de la fonction `get_sale_pepite_mode` ; `null` : la migration n'est pas appliquée. */
async function readMode(): Promise<string | null> {
  const { data, error } = await supabaseAdmin.rpc("get_sale_pepite_mode");
  if (error) {
    if (isMissingDatabaseObject(error)) return null;
    throw error;
  }
  return typeof data === "string" ? data : "off";
}

async function readOnlineSales(): Promise<OnlineSale[]> {
  const sales: OnlineSale[] = [];
  for (let from = 0; from < MAX_ONLINE_SALES; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("v_auction_sales_app")
      .select("id, updated_at, status, sale_date, sale_venue_type, starting_price_eur")
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    for (const row of data ?? []) {
      if (row.id) {
        sales.push({
          id: row.id,
          updatedAt: row.updated_at,
          status: row.status,
          saleDate: row.sale_date,
          venueType: row.sale_venue_type,
          startingPriceEur: row.starting_price_eur,
        });
      }
    }
    if ((data?.length ?? 0) < PAGE_SIZE) return sales;
  }
  throw new Error("Trop de ventes en ligne pour l'évaluation des pépites.");
}

/** Évaluations stockées ; `null` : la table n'existe pas encore. */
async function readStoredEvaluations(): Promise<StoredEvaluation[] | null> {
  const rows: StoredEvaluation[] = [];
  for (let from = 0; from < MAX_ONLINE_SALES; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("auction_sale_pepites")
      .select(
        "sale_id, status, evaluated_at, rule_version, engine_version, regime_version, is_pepite, favorable_streak, frozen_at, last_favorable_at, data_missing_since, input_starting_price_eur, first_pepite_at",
      )
      .order("sale_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      if (isMissingDatabaseObject(error)) return null;
      throw error;
    }
    for (const row of data ?? []) {
      rows.push({
        saleId: row.sale_id,
        status: row.status,
        evaluatedAt: row.evaluated_at,
        ruleVersion: row.rule_version,
        engineVersion: row.engine_version,
        regimeVersion: row.regime_version,
        isPepite: row.is_pepite,
        favorableStreak: row.favorable_streak,
        frozenAt: row.frozen_at,
        lastFavorableAt: row.last_favorable_at,
        dataMissingSince: row.data_missing_since,
        inputStartingPriceEur: row.input_starting_price_eur,
        firstPepiteAt: row.first_pepite_at,
      });
    }
    if ((data?.length ?? 0) < PAGE_SIZE) return rows;
  }
  throw new Error("Trop d'évaluations de pépites stockées.");
}

async function readEstimateDates(): Promise<Map<string, string | null>> {
  const dates = new Map<string, string | null>();
  for (let from = 0; from < MAX_ONLINE_SALES; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("auction_sale_market_estimates")
      .select("auction_sale_id, computed_at")
      .order("auction_sale_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    for (const row of data ?? []) dates.set(row.auction_sale_id, row.computed_at);
    if ((data?.length ?? 0) < PAGE_SIZE) return dates;
  }
  throw new Error("Trop d'estimations stockées pour l'évaluation des pépites.");
}

/**
 * La relecture IA des ventes lues, comme `/api/sales/ai-review` la sert (mêmes lectures, même
 * assainissement, même dérive de la valeur canonique), avec le rôle de service : le traitement ne
 * lit pas pour un compte, il lit toutes les ventes en ligne.
 */
async function loadAiReviewProjections(
  sales: readonly AuctionSale[],
): Promise<Map<string, AiReviewProjectionReadModel[]>> {
  const grouped = new Map<string, AiReviewProjectionReadModel[]>();
  const ids = sales.map((sale) => sale.id);
  if (!ids.length) return grouped;
  const visibleSaleIds = new Set(ids);

  const { data: projections, error: projectionError } = await supabaseAdmin
    .from("v_auction_ai_review_projection_read_model")
    .select(PROJECTION_COLUMNS)
    .in("auction_sale_id", ids);
  if (projectionError) throw projectionError;
  const { data: caseStatuses, error: caseStatusError } = await supabaseAdmin
    .from("auction_ai_review_case_status")
    .select(CASE_STATUS_COLUMNS)
    .in("auction_sale_id", ids);
  if (caseStatusError) throw caseStatusError;

  const safeProjections = sanitizeProjectionRows(projections, visibleSaleIds);
  const missingRows = missingProjectionRows(
    sampledSaleIds(caseStatuses, visibleSaleIds),
    safeProjections,
  );
  let canonicalMismatches = new Set<string>();
  if (
    safeProjections.some((projection) => projection.is_publishable && projection.auction_sale_id)
  ) {
    const { data: publishableRows, error: publishableError } = await supabaseAdmin
      .from("v_auction_ai_review_publishable")
      .select(PUBLISHABLE_COLUMNS)
      .in("auction_sale_id", ids);
    if (publishableError) throw publishableError;
    canonicalMismatches = canonicalMismatchKeys(
      safeProjections,
      publishableRows,
      sales as unknown as CanonicalSaleRow[],
    );
  }
  for (const projection of [
    ...sanitizeProjectionRows(projections, visibleSaleIds, canonicalMismatches),
    ...missingRows,
  ]) {
    if (!projection.auction_sale_id) continue;
    const list = grouped.get(projection.auction_sale_id) ?? [];
    list.push(projection);
    grouped.set(projection.auction_sale_id, list);
  }
  return grouped;
}

async function activeModelIds(estimates: readonly EstimateRow[]): Promise<Set<string>> {
  const ids = [
    ...new Set(
      estimates.flatMap((estimate) =>
        estimate.engine_kind === "hybrid_lightgbm" && estimate.model_version_id
          ? [estimate.model_version_id]
          : [],
      ),
    ),
  ];
  if (!ids.length) return new Set();
  const { data, error } = await supabaseAdmin
    .from("valuation_model_versions")
    .select("id")
    .eq("status", "active")
    .in("id", ids);
  if (error) throw error;
  return new Set((data ?? []).map((row) => row.id));
}

const AUCTION_SALE_SELECT = `${SALE_INPUT_SELECT},score_status:raw_payload->>score_status` as const;

export async function runSalePepitesBatch({
  limit = 300,
  now = new Date(),
  timeBudgetMs = 240_000,
}: {
  limit?: number;
  now?: Date;
  /** Temps au-delà duquel on ne lit plus de nouveau lot (la prochaine exécution reprend). */
  timeBudgetMs?: number;
} = {}): Promise<SalePepitesBatchResult> {
  const startedAt = Date.now();
  const versions = currentPepiteVersions();
  const result: SalePepitesBatchResult = {
    mode: "unknown",
    skipped: null,
    ruleVersion: versions.rule,
    online: 0,
    pending: 0,
    evaluated: 0,
    favorable: 0,
    published: 0,
    notApplicable: 0,
    insufficient: 0,
    failed: 0,
    remaining: 0,
    errors: [],
  };
  const fail = (count: number, error: unknown) => {
    result.failed += count;
    if (result.errors.length < MAX_REPORTED_ERRORS) result.errors.push(errorMessage(error));
  };

  // Avant la migration (fonction ou table absente) ou en mode « off » : rien n'est lu ni écrit.
  const mode = await readMode();
  if (mode == null) return { ...result, skipped: "not_migrated" };
  result.mode = mode;
  if (mode === "off") return { ...result, skipped: "mode_off" };

  const [online, stored] = await Promise.all([readOnlineSales(), readStoredEvaluations()]);
  if (stored == null) return { ...result, skipped: "not_migrated" };
  const estimateDates = await readEstimateDates();
  const storedBySale = new Map(stored.map((row) => [row.saleId, row]));
  const onlineBySale = new Map(online.map((sale) => [sale.id, sale]));

  const pending = pickPendingSales(online, stored, estimateDates, versions, now);
  const selected = pending.slice(0, Math.max(1, Math.min(2000, Math.floor(limit))));
  result.online = online.length;
  result.pending = pending.length;

  const regimes = openFeeRegimesFromEnv();
  const toWrite: PepiteTableInsert[] = [];
  const evaluate = (row: PepiteTableInsert, status: PepiteStatus) => {
    toWrite.push(row);
    if (status === "pepite") result.favorable += 1;
    if (row.is_pepite) result.published += 1;
    if (status === "not_applicable") result.notApplicable += 1;
    if (status === "insufficient") result.insufficient += 1;
  };

  const readable: string[] = [];
  for (const id of selected) {
    const sale = onlineBySale.get(id);
    if (!sale) continue;
    if (isUpcomingSale(sale, now)) readable.push(id);
    else
      evaluate(buildNotApplicableRow(sale, storedBySale.get(id), versions, now), "not_applicable");
  }

  for (let index = 0; index < readable.length; index += READ_CHUNK_SIZE) {
    if (Date.now() - startedAt > timeBudgetMs) break;
    const ids = readable.slice(index, index + READ_CHUNK_SIZE);
    try {
      const [salesRead, inputsRead, estimatesRead] = await Promise.all([
        supabaseAdmin.from("v_auction_sales_app").select("*").in("id", ids),
        supabaseAdmin.from("auction_sales").select(AUCTION_SALE_SELECT).in("id", ids),
        supabaseAdmin.from("auction_sale_market_estimates").select("*").in("auction_sale_id", ids),
      ]);
      if (salesRead.error) throw salesRead.error;
      if (inputsRead.error) throw inputsRead.error;
      if (estimatesRead.error) throw estimatesRead.error;

      const sales = (salesRead.data ?? []) as unknown as AuctionSale[];
      const inputsBySale = new Map((inputsRead.data ?? []).map((row) => [row.id, row]));
      const estimateBySale = new Map(
        (estimatesRead.data ?? []).map((row) => [row.auction_sale_id, row]),
      );
      const [projections, modelIds] = await Promise.all([
        loadAiReviewProjections(sales),
        activeModelIds(estimatesRead.data ?? []),
      ]);

      for (const sale of sales) {
        try {
          const inputs = inputsBySale.get(sale.id);
          const estimateRow = estimateBySale.get(sale.id) ?? null;
          // Même lecture que `getStoredSaleMarketContext` : l'estimation stockée, valable seulement
          // pour les caractéristiques du bien qu'elle a lues, et jamais de mise en file d'attente.
          // Sans la ligne de la vente (empreinte invérifiable), l'estimation est traitée comme absente.
          const verifiable = estimateRow != null && (!estimateRow.estimate || inputs != null);
          const context = marketContextFromStoredRow(
            verifiable ? estimateRow : null,
            verifiable && estimateRow?.estimate && inputs
              ? saleValuationFingerprint(buildSaleValuationInput(inputs))
              : undefined,
          );
          const scenarios = await getAuctionScenarios(sale);
          const { evaluation, facts } = evaluateSaleForPepite({
            sale,
            scoreStatus: inputs?.score_status ?? null,
            aiProjections: projections.get(sale.id) ?? [],
            aiReviewStatus: "ready",
            regimes,
            estimate: estimateRow && verifiable ? { row: estimateRow, context } : null,
            modelActive:
              estimateRow?.model_version_id != null && modelIds.has(estimateRow.model_version_id),
            scenarios,
            now,
          });
          const previous = storedBySale.get(sale.id);
          const stability = applyPepiteStability({
            previous: storedStateFor(previous),
            evaluation,
            startingPriceEur: facts.startingPriceColumnEur,
            saleDate: sale.sale_date,
            now,
          });
          evaluate(
            buildPepiteRow({
              saleId: sale.id,
              evaluation,
              stability,
              facts,
              stored: previous,
              versions,
              startingPriceEur: facts.startingPriceColumnEur,
              now,
            }),
            evaluation.status,
          );
        } catch (evaluationError) {
          fail(1, evaluationError);
        }
      }
      // Une vente sélectionnée que la vue ne rend plus (retirée entre-temps) n'est pas une erreur.
    } catch (readError) {
      fail(ids.length, readError);
    }
  }

  // Écriture par paquets. Un paquet refusé est réessayé par moitiés pour isoler la ligne fautive : les autres
  // sont écrites, la fautive est consignée (identifiant de la vente et code d'erreur, jamais un montant).
  let written = 0;
  const writeRows = async (rows: PepiteTableInsert[]): Promise<"missing" | void> => {
    const { error } = await supabaseAdmin
      .from("auction_sale_pepites")
      .upsert(rows, { onConflict: "sale_id" });
    if (!error) {
      written += rows.length;
      return;
    }
    if (isMissingDatabaseObject(error)) return "missing";
    if (rows.length === 1) {
      fail(
        1,
        `Écriture refusée pour la vente ${rows[0].sale_id} (code ${error.code ?? "inconnu"})`,
      );
      return;
    }
    const middle = Math.ceil(rows.length / 2);
    if ((await writeRows(rows.slice(0, middle))) === "missing") return "missing";
    return writeRows(rows.slice(middle));
  };
  for (let index = 0; index < toWrite.length; index += 200) {
    if ((await writeRows(toWrite.slice(index, index + 200))) === "missing") {
      return { ...result, skipped: "not_migrated" };
    }
  }
  result.evaluated = written;
  result.remaining = Math.max(0, pending.length - written);

  // Aucune évaluation alors qu'il y en avait à faire : la tâche est en panne, on la signale.
  if (result.evaluated === 0 && result.failed > 0) {
    throw new Error(`Évaluation des pépites impossible : ${result.errors.join(" ; ")}`);
  }
  // Un échec partiel n'est pas un succès quand il cesse d'être isolé.
  const attempted = result.evaluated + result.failed;
  if (result.failed > 0 && result.failed / attempted >= SALE_PEPITES_FAILURE_RATE_THRESHOLD) {
    throw new Error(
      `Évaluation des pépites partielle : ${result.failed} échec(s) sur ${attempted} évaluation(s) tentée(s) (seuil ${SALE_PEPITES_FAILURE_RATE_THRESHOLD * 100} %) : ${result.errors.join(" ; ")}`,
    );
  }
  return result;
}
