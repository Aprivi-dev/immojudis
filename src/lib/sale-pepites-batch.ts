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
import { claimCronLease, releaseCronLease } from "@/lib/cron-lease.server";
import { FEE_REGIMES } from "@/lib/fee-regime";
import { openFeeRegimesFromEnv } from "@/lib/fee-regime.server";
import { floodFacts, type FloodVerdict } from "@/lib/flood-risk";
import { floodPositionKey } from "@/lib/flood-risk-position.server";
import {
  floodPositionOf,
  readFloodSales,
  readSaleCommunes,
  readStoredFloodRisks,
  type FloodSale,
  type SaleCommune,
  type StoredFloodRow,
} from "@/lib/flood-risk-store.server";
import { isMissingDatabaseObject } from "@/lib/postgrest-errors";
import { evaluateSaleForPepite, type PepiteSaleFacts } from "@/lib/pepite-input";
import { activePepiteRuleVersion } from "@/lib/pepite-rule-switch.server";
import {
  PEPITE_REFRESH_HOURS,
  PEPITE_LATEST_RULE_VERSION,
  applyPepiteStability,
  pepiteReasonCodes,
  type PepiteEvaluation,
  type PepiteRuleVersion,
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
import { isBusyWriteError } from "@/lib/write-busy";

/**
 * Calcule la pépite des ventes en ligne et la stocke (table `auction_sale_pepites`, voir la migration
 * 20261104100000). Le calcul reste en TypeScript : c'est le chemin de la fiche (assainissement de la
 * vente, relecture IA, conflit de valorisation, estimation stockée sans mise en file d'attente,
 * `computeSaleCeiling`), lu avec le rôle de service sur `v_auction_sales_app`, puis la règle
 * `pepite-v1` ou `pepite-v2` (`pepite-policy.ts`) et sa stabilité.
 *
 * Règle appliquée : `pepite-v1` tant que l'interrupteur serveur `PEPITE_RULE_V2_ENABLED` est fermé (défaut : le
 * traitement ne lit alors pas la table d'inondation et rien ne change) ; `pepite-v2` quand il est ouvert : le
 * verdict d'inondation de chaque vente est lu dans la table privée alimentée par `/api/cron/sale-flood-risk`
 * (jamais un appel réseau ici). Sans cette table ni celle des communes, la passe se termine proprement
 * (`skipped: "not_migrated"`). Voir `pepite-rule-switch.server.ts`.
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
/** Durée du bail : au-delà de `maxDuration` (300 s) de la route, il expire seul si la passe meurt. */
export const SALE_PEPITES_LEASE_SECONDS = 360;
/**
 * Passé ce délai depuis le début de la passe, l'écriture n'attend plus de verrou : les paquets restants sont différés
 * (la route est coupée à 300 s, et chaque attente de verrou peut durer jusqu'au délai de la requête).
 */
export const SALE_PEPITES_WRITE_DEADLINE_MS = 250_000;
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
  /** Clé du régime de la vente (`details.regime`) ; `null` : inconnue ou sans régime (vente non applicable). */
  regimeKey?: string | null;
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
  rule: PepiteRuleVersion;
  engine: string;
  /** Les versions des régimes de frais. */
  regimes: readonly string[];
  /** La version de chaque régime, par clé : l'obsolescence se juge régime par régime (n° 30). */
  regimeByKey?: Readonly<Record<string, string>>;
};

export function currentPepiteVersions(
  env: Record<string, string | undefined> = process.env,
): PepiteVersions {
  return {
    rule: activePepiteRuleVersion(env),
    engine: CEILING_ENGINE_VERSION,
    regimes: Object.values(FEE_REGIMES).flatMap((regime) => (regime ? [regime.version] : [])),
    regimeByKey: Object.fromEntries(
      Object.entries(FEE_REGIMES).flatMap(([key, regime]) =>
        regime ? [[key, regime.version]] : [],
      ),
    ),
  };
}

export type SalePepitesBatchResult = {
  mode: string;
  skipped: "mode_off" | "not_migrated" | "busy" | null;
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
  /**
   * Évaluations calculées mais non écrites car la ligne de leur vente était verrouillée (publication du pipeline) :
   * elles restent à évaluer et reprennent à la passe suivante.
   */
  deferred: number;
  /** Verdicts d'inondation lus pour les ventes évaluées (règle v2 seulement) ; `null` sous la règle v1. */
  floodVerdicts: Record<FloodVerdict, number> | null;
  errors: string[];
};

function time(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Une évaluation faite avec une autre version de la règle, du moteur ou du régime DE LA VENTE est obsolète. Quand la
 * clé du régime est connue, la version est comparée à celle de CE régime : le barème d'un régime qui change ne
 * laisse pas passer pour à jour l'évaluation d'un autre régime qui avait la même version.
 */
export function isObsoleteEvaluation(evaluation: StoredEvaluation, versions: PepiteVersions) {
  if (evaluation.ruleVersion !== versions.rule || evaluation.engineVersion !== versions.engine) {
    return true;
  }
  if (evaluation.regimeVersion == null) return false;
  const expected = evaluation.regimeKey ? versions.regimeByKey?.[evaluation.regimeKey] : undefined;
  if (expected !== undefined) return evaluation.regimeVersion !== expected;
  return !versions.regimes.includes(evaluation.regimeVersion);
}

/**
 * Vente dont la date d'audience est passée mais que le pipeline n'a pas encore fait sortir du statut « à venir » :
 * l'instantané d'estimation (`app_private.snapshot_sale_market_estimate`) est pris à cette sortie de statut et lit
 * alors l'évaluation de la pépite. Réécrire l'évaluation en « non applicable » avant lui archiverait un
 * « non applicable » au lieu de la dernière évaluation avant l'audience : on la garde (n° 24). Une vente sans
 * évaluation, ou déjà « non applicable », n'a rien à garder.
 */
export function keepsLastEvaluation(
  sale: { status: string | null; saleDate: string | null },
  evaluation: { status: string } | undefined,
  now: Date,
): boolean {
  if (!evaluation || evaluation.status === "not_applicable") return false;
  const saleTime = time(sale.saleDate);
  return sale.status === "upcoming" && saleTime != null && saleTime <= now.getTime();
}

/**
 * Ventes à (ré)évaluer, les plus urgentes d'abord :
 *   0. les pépites DÉJÀ publiées dont la vente, l'estimation, le prix ou le verdict d'inondation ont changé,
 *      qui sont évaluées sous une autre version, ou qui n'ont plus de donnée (délai de tolérance en cours) :
 *      une pépite affichée ne doit pas attendre derrière les ventes jamais évaluées ;
 *   1. jamais évaluées, les plus récemment modifiées en premier ;
 *   2. évaluées avec une autre version (règle, moteur, régime), les plus anciennes d'abord ;
 *   3. vente ou estimation modifiée depuis la dernière évaluation, les plus anciennes d'abord ;
 *   4. évaluées il y a plus de 24 h (tables liées), les plus anciennes d'abord, sauf une vente « non
 *      applicable » qui n'est plus à venir : rien n'y changera.
 * `estimateComputedAt` : date de calcul de l'estimation stockée de chaque vente. `floodChangedAt` : date du dernier
 * changement du verdict d'inondation de chaque vente (règle v2 ; vide sous la règle v1).
 */
export function pickPendingSales(
  online: OnlineSale[],
  evaluations: StoredEvaluation[],
  estimateComputedAt: ReadonlyMap<string, string | null>,
  versions: PepiteVersions = currentPepiteVersions(),
  now: Date = new Date(),
  floodChangedAt: ReadonlyMap<string, string | null> = new Map(),
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
    // Audience passée, instantané pas encore pris : l'évaluation est gardée telle quelle (n° 24).
    if (keepsLastEvaluation(sale, evaluation, now)) continue;
    const evaluatedAt = time(evaluation.evaluatedAt) ?? 0;
    const obsolete = isObsoleteEvaluation(evaluation, versions);
    const updatedAt = time(sale.updatedAt);
    const estimatedAt = time(estimateComputedAt.get(sale.id) ?? null);
    const floodAt = time(floodChangedAt.get(sale.id) ?? null);
    const changed =
      (updatedAt != null && updatedAt > evaluatedAt) ||
      (estimatedAt != null && estimatedAt > evaluatedAt) ||
      (floodAt != null && floodAt > evaluatedAt) ||
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
    // Effectif sur lequel la part est lissée et borne basse de Wilson (pepite-v1.1 et suivantes).
    chanceSample: metrics.chanceSample,
    chanceWilsonLow: roundRatio(metrics.chanceWilsonLow),
    occupancyDiscountPct: metrics.occupancyDiscountPct,
    // Sources des frais : sert au compteur « frais par défaut » de /admin/pepites.
    fees: facts?.fees ?? null,
    feesDefault: metrics.feesDefault,
    ceilingBelowStart: metrics.ceilingBelowStart,
    totalCostEur: roundEuro(metrics.totalCostEur),
    costRatio: roundRatio(metrics.costRatio),
    startingShareOfValue: roundRatio(metrics.startingShareOfValue),
    gapDiscountPct: facts?.gapDiscountPct ?? null,
    // Verdict d'inondation (règle v2) : sert au bloc de la fiche. Ni coordonnée ni commune, seulement le verdict
    // et deux dates de contrôle.
    flood: facts?.flood
      ? {
          verdict: facts.flood.verdict,
          observedAt: facts.flood.observedAt,
          mapDate: facts.flood.mapDate,
          ppriChecked: facts.flood.ppriChecked,
        }
      : null,
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
    // Version du modèle de valeur et moteur de l'estimation lue (migration 20261108140000).
    estimate_model_version: facts?.estimateModelVersion ?? null,
    estimate_engine_kind: facts?.estimateEngineKind ?? null,
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
    frozenQualityMissed: false,
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
      chanceSample: null,
      chanceWilsonLow: null,
      occupancyDiscountPct: null,
      feesDefault: false,
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

/** Colonne inconnue de la base ou du cache de schéma PostgREST (migration pas encore appliquée). */
function isUnknownColumn(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "PGRST204" || code === "42703";
}

function withoutEstimateVersions(row: PepiteTableInsert): PepiteTableInsert {
  const { estimate_model_version: _model, estimate_engine_kind: _engine, ...legacy } = row;
  return legacy;
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

const ONLINE_SALE_COLUMNS =
  "id, updated_at, status, sale_date, sale_venue_type, starting_price_eur";

type OnlineSaleRow = {
  id: string | null;
  updated_at: string | null;
  status: string | null;
  sale_date: string | null;
  sale_venue_type: string | null;
  starting_price_eur: number | null;
};

function onlineSaleOf(row: OnlineSaleRow): OnlineSale | null {
  if (!row.id) return null;
  return {
    id: row.id,
    updatedAt: row.updated_at,
    status: row.status,
    saleDate: row.sale_date,
    venueType: row.sale_venue_type,
    startingPriceEur: row.starting_price_eur,
  };
}

/**
 * Les ventes en ligne, lues par curseur sur `id` (`id > dernier`, pas de décalage : un décalage relit et jette toutes
 * les lignes précédentes à chaque page) :
 *  - les ventes À VENIR, filtrées dans la base (c'est l'immense majorité, la seule que la règle évalue) ;
 *  - puis, séparément, les rares ventes en ligne qui ne le sont pas (statut « inconnu »), pour que leur évaluation
 *    soit toujours ramenée à « non applicable » (une pépite publiée dont la vente perd son statut ne reste pas
 *    publiée). Cette seconde lecture est vide ou minuscule.
 */
async function readOnlineSales(): Promise<OnlineSale[]> {
  const sales: OnlineSale[] = [];
  for (const upcoming of [true, false]) {
    let after: string | null = null;
    for (;;) {
      if (sales.length >= MAX_ONLINE_SALES) {
        throw new Error("Trop de ventes en ligne pour l'évaluation des pépites.");
      }
      let query = supabaseAdmin.from("v_auction_sales_app").select(ONLINE_SALE_COLUMNS);
      query = upcoming
        ? query.eq("status", "upcoming")
        : query.or("status.is.null,status.neq.upcoming");
      if (after) query = query.gt("id", after);
      const { data, error } = await query.order("id", { ascending: true }).limit(PAGE_SIZE);
      if (error) throw error;
      const rows = (data ?? []) as OnlineSaleRow[];
      for (const row of rows) {
        const sale = onlineSaleOf(row);
        if (sale) sales.push(sale);
      }
      const last = rows.at(-1)?.id ?? null;
      if (rows.length < PAGE_SIZE || !last) break;
      after = last;
    }
  }
  return sales;
}

/** Évaluations stockées ; `null` : la table n'existe pas encore. */
async function readStoredEvaluations(): Promise<StoredEvaluation[] | null> {
  const rows: StoredEvaluation[] = [];
  for (let from = 0; from < MAX_ONLINE_SALES; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("auction_sale_pepites")
      .select(
        "sale_id, status, evaluated_at, rule_version, engine_version, regime_version, regime_key:details->>regime, is_pepite, favorable_streak, frozen_at, last_favorable_at, data_missing_since, input_starting_price_eur, first_pepite_at",
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
        regimeKey: typeof row.regime_key === "string" ? row.regime_key : null,
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

/**
 * Détails et motifs de l'évaluation déjà stockée de ces ventes (pépites publiées seulement : une poignée de
 * lignes), pour les garder tels quels pendant le gel à J-7.
 */
async function readStoredDetails(
  saleIds: readonly string[],
): Promise<Map<string, { details: Json; reasonCodes: string[] }>> {
  const kept = new Map<string, { details: Json; reasonCodes: string[] }>();
  if (!saleIds.length) return kept;
  const { data, error } = await supabaseAdmin
    .from("auction_sale_pepites")
    .select("sale_id, details, reason_codes")
    .in("sale_id", [...saleIds]);
  if (error) throw error;
  for (const row of data ?? []) {
    kept.set(row.sale_id, { details: row.details, reasonCodes: row.reason_codes ?? [] });
  }
  return kept;
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

type SalePepitesBatchOptions = {
  limit?: number;
  now?: Date;
  /** Temps au-delà duquel on ne lit plus de nouveau lot (la prochaine exécution reprend). */
  timeBudgetMs?: number;
};

/**
 * Une passe, sous bail : une seconde passe simultanée (pg_cron à :35 et filet quotidien de Vercel, ou rejeu manuel)
 * rend `skipped: "busy"` sans rien lire ni écrire. Le bail est rendu à la fin, même en cas d'erreur ; il expire seul
 * au bout de `SALE_PEPITES_LEASE_SECONDS` si la passe meurt. Sans la migration (fonction de bail absente), la passe
 * continue sans verrou.
 */
export async function runSalePepitesBatch(
  options: SalePepitesBatchOptions = {},
): Promise<SalePepitesBatchResult> {
  const lease = await claimCronLease("sale-pepites", SALE_PEPITES_LEASE_SECONDS);
  if (lease.kind === "busy") {
    return { ...emptyPepitesResult(currentPepiteVersions()), skipped: "busy" };
  }
  try {
    return await runPass(options);
  } finally {
    if (lease.kind === "held") await releaseCronLease("sale-pepites", lease.token);
  }
}

function emptyPepitesResult(versions: PepiteVersions): SalePepitesBatchResult {
  return {
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
    deferred: 0,
    floodVerdicts: null,
    errors: [],
  };
}

async function runPass({
  limit = 300,
  now = new Date(),
  timeBudgetMs = 240_000,
}: SalePepitesBatchOptions): Promise<SalePepitesBatchResult> {
  const startedAt = Date.now();
  const versions = currentPepiteVersions();
  const result = emptyPepitesResult(versions);
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

  // Règle v2 : le verdict d'inondation de chaque vente, lu dans la table privée (aucun appel réseau).
  const v2 = versions.rule === PEPITE_LATEST_RULE_VERSION;
  let flood: {
    stored: Map<string, StoredFloodRow>;
    communes: Map<string, SaleCommune>;
    sales: Map<string, FloodSale>;
  } | null = null;
  if (v2) {
    const [floodSales, floodRows, communes] = await Promise.all([
      readFloodSales(),
      readStoredFloodRisks(),
      readSaleCommunes(),
    ]);
    if (floodRows == null || communes == null) return { ...result, skipped: "not_migrated" };
    flood = {
      stored: new Map(floodRows.map((row) => [row.saleId, row])),
      communes,
      sales: new Map(floodSales.map((sale) => [sale.id, sale])),
    };
    result.floodVerdicts = { high: 0, exposed: 0, none_found: 0, no_signal: 0, unknown: 0 };
  }
  const floodChangedAt = new Map(
    [...(flood?.stored.values() ?? [])].map((row) => [row.saleId, row.verdictChangedAt]),
  );
  const storedBySale = new Map(stored.map((row) => [row.saleId, row]));
  const onlineBySale = new Map(online.map((sale) => [sale.id, sale]));

  const pending = pickPendingSales(online, stored, estimateDates, versions, now, floodChangedAt);
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
    else if (keepsLastEvaluation(sale, storedBySale.get(id), now)) continue;
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
      const [projections, modelIds, storedDetails] = await Promise.all([
        loadAiReviewProjections(sales),
        activeModelIds(estimatesRead.data ?? []),
        // Pépites publiées de ce lot : leurs détails sont gardés si la vente est dans la fenêtre de gel.
        readStoredDetails(ids.filter((id) => storedBySale.get(id)?.isPepite)),
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
          const floodSale = flood?.sales.get(sale.id);
          const saleFlood =
            flood && floodSale
              ? floodFacts(
                  flood.stored.get(sale.id),
                  floodPositionKey(floodPositionOf(floodSale, flood.communes.get(sale.id))),
                  now,
                )
              : { verdict: "unknown" as const, observedAt: null, mapDate: null, ppriChecked: true };
          if (result.floodVerdicts) result.floodVerdicts[saleFlood.verdict] += 1;
          const { evaluation, facts } = evaluateSaleForPepite(
            {
              sale,
              scoreStatus: inputs?.score_status ?? null,
              aiProjections: projections.get(sale.id) ?? [],
              aiReviewStatus: "ready",
              regimes,
              estimate: estimateRow && verifiable ? { row: estimateRow, context } : null,
              modelActive:
                estimateRow?.model_version_id != null && modelIds.has(estimateRow.model_version_id),
              scenarios,
              flood: saleFlood,
              now,
            },
            versions.rule,
          );
          const previous = storedBySale.get(sale.id);
          const stability = applyPepiteStability({
            previous: storedStateFor(previous),
            evaluation,
            startingPriceEur: facts.startingPriceColumnEur,
            saleDate: sale.sale_date,
            now,
          });
          const row = buildPepiteRow({
            saleId: sale.id,
            evaluation,
            stability,
            facts,
            stored: previous,
            versions,
            startingPriceEur: facts.startingPriceColumnEur,
            now,
          });
          // Gel à J-7 (n° 21) : le résultat publié ne change plus, ses détails et ses motifs non plus. Réécrire
          // ceux de la nouvelle évaluation afficherait des seuils contredits par les chiffres (« au moins 70 % »
          // à côté de « 5 ventes sur 10 »). La date d'évaluation, la mise à prix et l'estimation lues continuent
          // d'être mises à jour : la lecture publique en dépend. Le statut reste celui de l'évaluation publiée.
          const frozen = previous?.isPepite && stability.codes.includes("stab:frozen");
          const keep = frozen ? storedDetails.get(sale.id) : undefined;
          if (keep && previous) {
            row.details = keep.details;
            row.reason_codes = keep.reasonCodes.includes("stab:frozen")
              ? keep.reasonCodes
              : [...keep.reasonCodes, "stab:frozen"];
            row.status = previous.status;
          }
          evaluate(row, row.status as PepiteStatus);
        } catch (evaluationError) {
          fail(1, evaluationError);
        }
      }
      // Une vente sélectionnée que la vue ne rend plus (retirée entre-temps) n'est pas une erreur.
    } catch (readError) {
      fail(ids.length, readError);
    }
  }

  // Écriture par paquets. Deux sortes de refus :
  //  - une écriture BLOQUÉE par un verrou (57014, 55P03, 40P01 : la publication du pipeline tient la vente) : le
  //    paquet n'est pas coupé en deux (chaque niveau attendrait le délai complet), il est différé, réessayé une fois
  //    en fin de passe, puis laissé à la passe suivante (ces ventes restent à évaluer) ;
  //  - une ligne INVALIDE (contrainte, type) : le paquet refusé est réessayé par moitiés pour isoler la ligne
  //    fautive. Les autres sont écrites, la fautive est consignée (identifiant de la vente et code d'erreur, jamais
  //    un montant).
  // Passé `SALE_PEPITES_WRITE_DEADLINE_MS`, plus aucun paquet n'est tenté : tout est différé.
  let written = 0;
  let deferred: PepiteTableInsert[] = [];
  const writeDeadlineReached = () => Date.now() - startedAt > SALE_PEPITES_WRITE_DEADLINE_MS;
  // Code déployé avant la migration 20261108140000 : les deux colonnes de version de l'estimation n'existent pas
  // encore. L'écriture est retentée sans elles (rien n'est perdu d'autre que les versions archivées).
  let legacyColumns = false;
  const writeRows = async (rows: PepiteTableInsert[]): Promise<"missing" | void> => {
    if (writeDeadlineReached()) {
      deferred.push(...rows);
      return;
    }
    const { error } = await supabaseAdmin
      .from("auction_sale_pepites")
      .upsert(legacyColumns ? rows.map(withoutEstimateVersions) : rows, { onConflict: "sale_id" });
    if (!error) {
      written += rows.length;
      return;
    }
    if (isMissingDatabaseObject(error)) return "missing";
    if (isBusyWriteError(error)) {
      deferred.push(...rows);
      return;
    }
    if (!legacyColumns && isUnknownColumn(error)) {
      legacyColumns = true;
      return writeRows(rows);
    }
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
  if (deferred.length > 0) {
    // Dernier essai des paquets bloqués ; s'ils le sont encore, la passe suivante reprend ces ventes.
    const retry = deferred;
    deferred = [];
    for (let index = 0; index < retry.length; index += 200) {
      if ((await writeRows(retry.slice(index, index + 200))) === "missing") {
        return { ...result, skipped: "not_migrated" };
      }
    }
  }
  result.deferred = deferred.length;
  if (deferred.length > 0 && result.errors.length < MAX_REPORTED_ERRORS) {
    result.errors.push(`write_busy_${deferred.length}`);
  }
  result.evaluated = written;
  result.remaining = Math.max(0, pending.length - written);

  // Rien n'a pu être écrit de toute la passe alors que des évaluations étaient prêtes : ventes verrouillées pendant
  // toute la passe. La tâche est en panne, la supervision doit le voir (comme pour le traitement d'inondation).
  if (written === 0 && deferred.length > 0) {
    throw new Error(
      "Écriture des évaluations de pépites impossible : ventes verrouillées pendant toute la passe",
    );
  }

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
