import "server-only";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { isDiscoveryAlertCompatible } from "@/lib/discovery-alerts";
import { alertMatchesSale } from "@/lib/alerts";
import {
  createAlertNotificationsForMatches,
  suppressAlertNotificationsForMatches,
} from "@/lib/alert-notifications";
import { extractDpe } from "@/lib/dpe";
import { errorDetails, errorSummary } from "@/lib/error-details";
import { estimateSaleGrossYieldPct, pricePerM2 } from "@/lib/geo";
import { resolveMarketGap } from "@/lib/market-gap";
import type { RentLookup } from "@/lib/rent-reference";
import { createRentLookupSession, type RentLookupSession } from "@/lib/rent-reference.server";
import { marketGapWithheldReason } from "@/lib/market-gap-band";
import { listPepiteSaleIds, type PepiteIdsClient } from "@/lib/pepite-sale-ids";
import { featureIncluded } from "@/lib/plans";
import { resolvePlanEntitlements } from "@/lib/property-reports";
import { getSaleAlertDetails, getSalesForAlertEvaluation } from "@/lib/queries";
import { systemAuthForUser } from "@/lib/system-auth";
import { getPrecomputedMarketEstimate } from "@/lib/sale-market-estimates";
import { cleanSaleTitle } from "@/lib/sale-title";
import { getMarketValuationSurfaces, getSaleSurface } from "@/lib/surface";
import type { AuctionSale, SaleFilters, UserAlert, UserWatchedZone } from "@/lib/types";
import { normalizeWatchedZone } from "@/lib/watched-zones";
import { asRecord, numberValue, stringValue } from "@/lib/guards";

type AlertMatchRow = Database["public"]["Tables"]["user_alert_matches"]["Row"];

export type AlertMatchSummary = {
  id: string | null;
  alertId: string;
  alertName: string;
  saleId: string;
  saleTitle: string | null;
  city: string | null;
  department: string | null;
  startingPriceEur: number | null;
  saleDate: string | null;
  reasons: string[];
  marketDiscountPct: number | null;
  matchedAt: string;
  readAt: string | null;
  dismissedAt: string | null;
};

/** Une alerte qui n'a pas pu être évaluée ou enregistrée (message et code de l'erreur d'origine). */
export type AlertEvaluationFailure = {
  alertId: string;
  error: string;
};

export type AlertEvaluationResponse = {
  evaluatedAt: string;
  alertCount: number;
  saleCount: number;
  matchCount: number;
  notificationCount: number;
  persisted: boolean;
  /** Alertes en échec : les autres sont évaluées et enregistrées normalement. */
  failedAlertCount: number;
  alertFailures: AlertEvaluationFailure[];
  matches: AlertMatchSummary[];
};

/**
 * What the browser receives from `POST /api/alerts/matches`: the failed alerts are identified, but
 * the raw error (PostgREST message, details, hint) stays in the server logs and the cron summary.
 */
export type PublicAlertEvaluationResponse = Omit<AlertEvaluationResponse, "alertFailures"> & {
  alertFailures: Array<{ alertId: string; code: "alert_evaluation_failed" }>;
};

/** The user's plan does not include alerts: nothing to evaluate, not a failure. */
export class AlertsNotIncludedError extends Error {
  constructor() {
    super("Alertes avancées réservées à l’offre Analyse.");
    this.name = "AlertsNotIncludedError";
  }
}

export type SmartAlertBatchUserResult = {
  userId: string;
  ok: boolean;
  skipped?: boolean;
  alertCount: number;
  saleCount: number;
  matchCount: number;
  notificationCount: number;
  /** Alertes du compte en échec ; le compte n'échoue que si elles ont toutes échoué. */
  failedAlertCount: number;
  error: string | null;
};

/** Échecs d'alertes gardés dans le résumé de l'exécution (le reste est dans les journaux). */
const MAX_REPORTED_ALERT_FAILURES = 20;

export type SmartAlertBatchRunResult = {
  ok: true;
  /** Users not started because the time budget ran out; they go first next run. */
  deferredUserCount: number;
  startedAt: string;
  finishedAt: string;
  candidateUserCount: number;
  analysedUserCount: number;
  evaluatedUserCount: number;
  failedUserCount: number;
  /** Alertes en échec sur l'ensemble des comptes (un compte reste « évalué » si une seule échoue). */
  failedAlertCount: number;
  alertFailures: Array<AlertEvaluationFailure & { userId: string }>;
  totalMatchCount: number;
  totalNotificationCount: number;
  results: SmartAlertBatchUserResult[];
};

/** Sales read per request while paging through the inventory to evaluate. */
const ALERT_EVALUATION_PAGE_SIZE = 400;
/** Safety ceiling on the sales evaluated for one user in one run. */
const DEFAULT_ALERT_EVALUATION_SALE_LIMIT = 6_000;
const MAX_ALERT_EVALUATION_SALE_LIMIT = 20_000;
/** Overlap with the previous evaluation so a sale updated mid-run is never missed. */
const ALERT_EVALUATION_OVERLAP_MS = 60 * 60 * 1000;
/** Users evaluated in parallel by the daily batch. */
const ALERT_BATCH_CONCURRENCY = 4;
/** The batch stops starting new users after this long; the rest come first next run. */
const DEFAULT_ALERT_BATCH_TIME_BUDGET_MS = 240_000;
/** Lignes écrites par requête : une alerte très large ne doit pas dépasser le délai d'une requête. */
const ALERT_MATCH_UPSERT_BATCH_SIZE = 200;
const DEFAULT_ALERT_MATCH_LIST_LIMIT = 50;
const MAX_ALERT_MATCH_LIST_LIMIT = 200;

export async function listUserAlertMatches({
  auth,
  limit = DEFAULT_ALERT_MATCH_LIST_LIMIT,
  includeDismissed = false,
}: {
  auth: SupabaseAuthContext;
  limit?: number;
  includeDismissed?: boolean;
}): Promise<{ matches: AlertMatchSummary[] }> {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "alerts.advanced")) {
    throw new Error("Alertes avancées réservées à l’offre Analyse.");
  }

  let query = auth.supabase
    .from("user_alert_matches")
    .select("*")
    .eq("user_id", auth.userId)
    .order("matched_at", { ascending: false })
    .limit(clampLimit(limit, MAX_ALERT_MATCH_LIST_LIMIT));

  if (!includeDismissed) query = query.is("dismissed_at", null);

  const { data, error } = await query;
  if (error) throw error;

  return {
    matches: (data ?? []).map(alertMatchRowToSummary),
  };
}

/** Une alerte « Seulement les pépites » (`advanced_criteria.pepite_only`). */
function isPepiteAlert(alert: Pick<UserAlert, "advanced_criteria">): boolean {
  return alert.advanced_criteria?.pepite_only === true;
}

const PEPITE_IDS_CACHE_MS = 60_000;
let pepiteIdsCache: { at: number; ids: Promise<ReadonlySet<string>> } | null = null;

/**
 * Les pépites publiables, lues côté serveur avec le rôle de service par la fonction publique
 * `list_public_pepite_sale_ids` : la liste vide tant que le mode n'est pas « on » (une alerte ne prévient
 * jamais d'une pépite que le site n'affiche pas) et aux mêmes gardes que la fiche. La table privée
 * `auction_sale_pepites` n'est jamais lue ici. Gardée une minute entre deux comptes d'un même passage ;
 * une panne n'est pas gardée et fait échouer les alertes qui en ont besoin (elles gardent leur date
 * d'évaluation et sont reprises au passage suivant).
 */
export function loadPepiteSaleIdsForAlerts(now = Date.now()): Promise<ReadonlySet<string>> {
  if (pepiteIdsCache && now - pepiteIdsCache.at < PEPITE_IDS_CACHE_MS) return pepiteIdsCache.ids;
  const entry = {
    at: now,
    ids: listPepiteSaleIds({
      rpc: (fn) => supabaseAdmin.rpc(fn),
    } as PepiteIdsClient).then((ids) => new Set(ids) as ReadonlySet<string>),
  };
  pepiteIdsCache = entry;
  entry.ids.catch(() => {
    if (pepiteIdsCache === entry) pepiteIdsCache = null;
  });
  return entry.ids;
}

/** Pour les tests : oublie la liste gardée. */
export function resetPepiteSaleIdsForAlertsCache(): void {
  pepiteIdsCache = null;
}

type AlertEvaluationEntry = {
  alert: UserAlert;
  matches: AlertMatchSummary[];
  rows: Database["public"]["Tables"]["user_alert_matches"]["Insert"][];
  notificationCount?: number;
  /** Ventes enregistrées sans notification (base silencieuse du changement de loyers de référence). */
  silentSaleIds?: Set<string>;
};

/**
 * Variable d'environnement posée AU DÉPLOIEMENT du passage à la carte des loyers de l'ANIL (date ISO).
 * Absente : aucune base silencieuse.
 */
export const RENT_BASIS_SWITCH_ENV = "ALERT_RENT_BASIS_SWITCH_AT";
/** La base silencieuse ne dure que 48 heures après le changement. */
export const RENT_BASIS_SILENT_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Base silencieuse. Le passage à la carte des loyers de l'ANIL fait entrer des ventes dans les alertes à
 * critère de rendement sans qu'elles aient changé : sans précaution, le premier passage enverrait d'un
 * coup toutes ces « nouvelles » correspondances. Les mailles de déduplication (correspondance unique par
 * alerte et vente, notification unique par correspondance) n'y suffisent pas : le pipeline réécrit
 * `updated_at` à chaque collecte, donc la fenêtre incrémentale relit presque tout le catalogue.
 *
 * Pour une alerte à critère de rendement évaluée avant le changement (`last_evaluated_at` renseigné et
 * antérieur à `ALERT_RENT_BASIS_SWITCH_AT`), pendant les 48 heures qui suivent, les correspondances qui
 * n'existaient pas avec le loyer départemental sont enregistrées SANS notification. Les ventes qui
 * correspondaient déjà, et toute alerte créée ou modifiée depuis (`last_evaluated_at` nul), gardent le
 * comportement normal.
 */
export function isRentBasisSilentPass(
  alert: Pick<UserAlert, "min_yield_pct" | "last_evaluated_at">,
  evaluatedAt: string,
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): boolean {
  if (alert.min_yield_pct == null || !alert.last_evaluated_at) return false;
  const switchAt = Date.parse(env[RENT_BASIS_SWITCH_ENV] ?? "");
  const now = Date.parse(evaluatedAt);
  const last = Date.parse(alert.last_evaluated_at);
  if (![switchAt, now, last].every(Number.isFinite)) return false;
  return now >= switchAt && now < switchAt + RENT_BASIS_SILENT_WINDOW_MS && last < switchAt;
}

/** Les loyers de la carte de l'ANIL n'ont pas pu être lus : une alerte à critère de rendement n'avance pas. */
export class RentReferenceUnavailableError extends Error {
  constructor() {
    super(
      "Loyers de référence (ANIL) indisponibles : l'alerte à critère de rendement est reprise au prochain passage.",
    );
    this.name = "RentReferenceUnavailableError";
  }
}

export async function evaluateUserAlertMatches({
  auth,
  saleLimit = DEFAULT_ALERT_EVALUATION_SALE_LIMIT,
  persist = true,
  rentSession = createRentLookupSession(),
}: {
  auth: SupabaseAuthContext;
  saleLimit?: number;
  persist?: boolean;
  /**
   * Références de loyer (carte ANIL) partagées : le cron en ouvre une par exécution, pour toutes les
   * alertes de tous les comptes ; seule, une évaluation en ouvre une.
   */
  rentSession?: RentLookupSession;
}): Promise<AlertEvaluationResponse> {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "alerts.advanced")) {
    throw new AlertsNotIncludedError();
  }

  const discovery = !plan.hasAnalysisAccess;
  const evaluatedAt = new Date().toISOString();
  const activeAlerts = await getActiveUserAlerts(auth);
  const alerts = discovery
    ? activeAlerts.filter(isDiscoveryAlertCompatible).slice(0, 1)
    : activeAlerts;
  // « Seulement les pépites » : une vente devient pépite sans que sa ligne change (`updated_at`), la lecture
  // « depuis la dernière évaluation » la manquerait. La fenêtre incrémentale reste celle de tous les comptes ;
  // on y ajoute seulement les ventes de la liste des pépites (lues par identifiant), évaluées par les alertes
  // « pépites » seules : une alerte d'un autre critère ne relit rien de plus.
  let pepiteSaleIds: ReadonlySet<string> | null = null;
  let pepiteFailure: unknown = null;
  const wantsPepites = alerts.some(isPepiteAlert);
  if (wantsPepites) {
    try {
      pepiteSaleIds = await loadPepiteSaleIdsForAlerts();
    } catch (error) {
      pepiteFailure = error;
    }
  }
  const evaluationLimit = clampLimit(saleLimit, MAX_ALERT_EVALUATION_SALE_LIMIT);
  const sales = alerts.length
    ? await loadSalesToEvaluate({ auth, alerts, discovery, limit: evaluationLimit })
    : [];
  const pepiteOnlySaleIds = new Set<string>();
  if (pepiteSaleIds && pepiteSaleIds.size > 0 && alerts.length) {
    const known = new Set(sales.map((sale) => sale.id.toLowerCase()));
    const missing = [...pepiteSaleIds].filter((id) => !known.has(id));
    for (const sale of await loadSalesByIds({ auth, ids: missing, discovery })) {
      if (sales.length >= evaluationLimit) break;
      sales.push(sale);
      pepiteOnlySaleIds.add(sale.id);
    }
  }
  const marketDiscountCache = new Map<string, Promise<number | null>>();
  const watchedZones = await getUserWatchedZonesForAlerts({ auth, alerts });
  // Une alerte Découverte n'a pas de critère DPE et son résumé ne garde ni DPE ni pièces.
  if (!discovery) await attachAlertDetails({ auth, alerts, sales, watchedZones, pepiteSaleIds });
  const failures: AlertEvaluationFailure[] = [];

  // Chaque alerte est évaluée, enregistrée puis marquée évaluée isolément : l'échec de l'une est
  // compté et journalisé, sans empêcher les autres ni faire échouer le compte. Une alerte en échec
  // garde son ancienne date d'évaluation : le passage suivant la reprend en entier.
  const entries: AlertEvaluationEntry[] = [];
  for (const alert of alerts) {
    const entry: AlertEvaluationEntry = { alert, matches: [], rows: [] };
    try {
      await collectAlertMatches({
        entry,
        auth,
        sales,
        discovery,
        evaluatedAt,
        watchedZones,
        marketDiscountCache,
        pepiteSaleIds,
        pepiteFailure,
        pepiteOnlySaleIds,
        rentSession,
      });
      if (persist) {
        await persistAlertEvaluation({ entry, auth, evaluatedAt, discovery });
      }
    } catch (error) {
      failures.push(recordAlertFailure({ userId: auth.userId, alert, error }));
      continue;
    }
    entries.push(entry);
  }

  const matches = entries.flatMap((entry) => entry.matches);
  const notificationCount = entries.reduce(
    (total, entry) => total + (entry.notificationCount ?? 0),
    0,
  );

  return {
    evaluatedAt,
    alertCount: alerts.length,
    saleCount: sales.length,
    matchCount: matches.length,
    notificationCount,
    persisted: persist,
    failedAlertCount: failures.length,
    alertFailures: failures,
    matches,
  };
}

async function collectAlertMatches({
  entry,
  auth,
  sales,
  discovery,
  evaluatedAt,
  watchedZones,
  marketDiscountCache,
  pepiteSaleIds,
  pepiteFailure,
  pepiteOnlySaleIds,
  rentSession,
}: {
  entry: AlertEvaluationEntry;
  rentSession: RentLookupSession;
  auth: SupabaseAuthContext;
  sales: AuctionSale[];
  discovery: boolean;
  evaluatedAt: string;
  watchedZones: Map<string, UserWatchedZone>;
  marketDiscountCache: Map<string, Promise<number | null>>;
  pepiteSaleIds: ReadonlySet<string> | null;
  pepiteFailure: unknown;
  /** Ventes lues seulement pour les alertes « pépites » : les autres alertes ne les évaluent pas. */
  pepiteOnlySaleIds: ReadonlySet<string>;
}): Promise<void> {
  const { alert } = entry;
  // Liste des pépites illisible : l'alerte échoue (et garde sa date d'évaluation) au lieu de n'avoir aucune
  // correspondance et d'avancer.
  if (isPepiteAlert(alert) && pepiteFailure) throw pepiteFailure;
  if (discovery && !isDiscoveryAlertCompatible(alert)) return;
  const watchedZone = alert.watched_zone_id
    ? (watchedZones.get(alert.watched_zone_id) ?? null)
    : null;
  if (alert.watched_zone_id && !watchedZone) return;

  // Loyers de la carte ANIL à la commune. Le code commune se lit en base (`raw_payload` est lourd) : une
  // alerte à critère de rendement ne le lit que pour les ventes qu'elle retient sur ses autres critères ;
  // les autres alertes, seulement pour leurs ventes retenues (résumé enregistré).
  let rents: RentLookup | undefined;
  if (!discovery && alert.min_yield_pct != null) {
    const withoutYield = { ...alert, min_yield_pct: null, min_market_discount_pct: null };
    const candidates = sales.filter(
      (sale) =>
        (isPepiteAlert(alert) || !pepiteOnlySaleIds.has(sale.id)) &&
        alertMatchesSale(withoutYield, sale, { watchedZone, pepiteSaleIds }).matches,
    );
    rents = await rentSession.load(candidates);
    // Lecture de la carte de l'ANIL en échec : la session retombe sur le repère départemental, ce qui calculerait les
    // correspondances sur une autre base que celle annoncée ET consommerait la fenêtre de la base silencieuse. L'alerte
    // échoue donc (elle garde sa date d'évaluation) et sera reprise au prochain passage.
    if (rentSession.unavailable(candidates)) throw new RentReferenceUnavailableError();
  }
  // Base silencieuse du changement de loyers de référence (voir `isRentBasisSilentPass`).
  const silentPass = !discovery && isRentBasisSilentPass(alert, evaluatedAt);
  const matched: Array<{ sale: AuctionSale; summary: AlertMatchSummary }> = [];
  for (const sale of sales) {
    if (!isPepiteAlert(alert) && pepiteOnlySaleIds.has(sale.id)) continue;
    let marketDiscountPct: number | null = null;
    if (alert.min_market_discount_pct != null) {
      const preliminary = alertMatchesSale({ ...alert, min_market_discount_pct: null }, sale, {
        watchedZone,
        pepiteSaleIds,
        rents,
      });
      if (!preliminary.matches) continue;
      marketDiscountPct = await getCachedMarketDiscount(marketDiscountCache, sale);
    }

    const baseContext = {
      ...(alert.min_market_discount_pct == null ? {} : { marketDiscountPct }),
      watchedZone,
      pepiteSaleIds,
      rents,
    };
    const result = alertMatchesSale(alert, sale, baseContext);
    if (!result.matches) continue;
    // Correspondance qui n'existait pas avec le loyer départemental : due au changement de loyers.
    if (
      silentPass &&
      !alertMatchesSale(alert, sale, { ...baseContext, rents: undefined }).matches
    ) {
      (entry.silentSaleIds ??= new Set()).add(sale.id);
    }

    const summary = buildAlertMatchSummary({
      alert,
      sale,
      reasons: result.reasons,
      marketDiscountPct,
      matchedAt: evaluatedAt,
    });
    if (discovery) {
      summary.saleTitle = "Vente immobilière";
      summary.marketDiscountPct = null;
      summary.reasons = isPepiteAlert(alert)
        ? ["Critères publics correspondants", "pépite"]
        : ["Critères publics correspondants"];
    }
    entry.matches.push(summary);
    matched.push({ sale, summary });
  }

  // Les résumés enregistrés citent le rendement estimé : mêmes références que le critère.
  const snapshotRents =
    rents ?? (discovery ? undefined : await rentSession.load(matched.map((item) => item.sale)));
  for (const { sale, summary } of matched) {
    entry.rows.push({
      user_id: auth.userId,
      alert_id: alert.id,
      sale_id: sale.id,
      match_reasons: summary.reasons,
      matched_at: evaluatedAt,
      match_snapshot: asJson(
        buildAlertMatchSnapshot({
          alert,
          sale,
          summary,
          watchedZone,
          discovery,
          rents: snapshotRents,
        }),
      ),
    });
  }
}

/**
 * Enregistre les correspondances d'une alerte par lots (une alerte très large ferait sinon une
 * seule requête de plusieurs milliers de lignes, au-delà du délai d'une requête), crée ses
 * notifications, puis la marque évaluée. L'ordre compte : la date d'évaluation n'avance qu'une
 * fois le reste écrit, et tout est rejouable sans doublon (upsert).
 */
async function persistAlertEvaluation({
  entry,
  auth,
  evaluatedAt,
  discovery,
}: {
  entry: AlertEvaluationEntry;
  auth: SupabaseAuthContext;
  evaluatedAt: string;
  discovery: boolean;
}): Promise<void> {
  const { alert, matches, rows } = entry;
  for (let offset = 0; offset < rows.length; offset += ALERT_MATCH_UPSERT_BATCH_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("user_alert_matches")
      .upsert(rows.slice(offset, offset + ALERT_MATCH_UPSERT_BATCH_SIZE), {
        onConflict: "alert_id,sale_id",
      })
      .select("*");
    if (error) throw error;

    const persistedBySale = new Map((data ?? []).map((row) => [row.sale_id, row]));
    for (const match of matches.slice(offset, offset + ALERT_MATCH_UPSERT_BATCH_SIZE)) {
      const persistedRow = persistedBySale.get(match.saleId);
      if (persistedRow) {
        match.id = persistedRow.id;
        match.readAt = persistedRow.read_at;
        match.dismissedAt = persistedRow.dismissed_at;
      }
    }
  }

  // Correspondances tues par la base silencieuse : leurs notifications sont créées au statut « cancelled », pour que
  // la clé d'unicité bloque toute notification au passage suivant (la vente relue correspondrait de nouveau, hors
  // fenêtre silencieuse). Écrit AVANT que `last_evaluated_at` n'avance : en cas d'échec, l'alerte est rejouée.
  const silentMatches = matches.filter(
    (match) => match.id && entry.silentSaleIds?.has(match.saleId),
  );
  for (let offset = 0; offset < silentMatches.length; offset += ALERT_MATCH_UPSERT_BATCH_SIZE) {
    await suppressAlertNotificationsForMatches({
      auth,
      matches: silentMatches.slice(offset, offset + ALERT_MATCH_UPSERT_BATCH_SIZE),
      alerts: [alert],
      now: new Date(evaluatedAt),
      discovery,
    });
  }
  const persistedMatches = matches.filter(
    (match) => match.id && !entry.silentSaleIds?.has(match.saleId),
  );
  let notificationCount = 0;
  for (let offset = 0; offset < persistedMatches.length; offset += ALERT_MATCH_UPSERT_BATCH_SIZE) {
    const result = await createAlertNotificationsForMatches({
      auth,
      matches: persistedMatches.slice(offset, offset + ALERT_MATCH_UPSERT_BATCH_SIZE),
      alerts: [alert],
      now: new Date(evaluatedAt),
      discovery,
    });
    notificationCount += result.notificationCount;
  }
  entry.notificationCount = notificationCount;

  const { error } = await auth.supabase
    .from("user_alerts")
    .update({ last_evaluated_at: evaluatedAt, last_match_count: matches.length })
    .eq("id", alert.id)
    .eq("user_id", auth.userId);
  if (error) throw error;
}

/** Journalise l'échec d'une alerte avec son message et son code (jamais « Évaluation impossible »). */
function recordAlertFailure({
  userId,
  alert,
  error,
}: {
  userId: string;
  alert: Pick<UserAlert, "id" | "name">;
  error: unknown;
}): AlertEvaluationFailure {
  const { message, code } = errorDetails(error, "Évaluation impossible");
  console.error(
    JSON.stringify({
      scope: "smart-alerts",
      level: "error",
      outcome: "alert_failed",
      userId,
      alertId: alert.id,
      code,
      message,
    }),
  );
  return { alertId: alert.id, error: errorSummary(error, "Évaluation impossible") };
}

/**
 * Sales an evaluation must look at: everything still open when an alert has
 * never been evaluated (or its criteria changed), otherwise only the sales
 * created or modified since the previous evaluation.  Pages are read until the
 * inventory is exhausted so no sale is left out by a fixed first-N window.
 */
async function loadSalesToEvaluate({
  auth,
  alerts,
  discovery,
  limit,
}: {
  auth: SupabaseAuthContext;
  alerts: UserAlert[];
  discovery: boolean;
  limit: number;
}): Promise<AuctionSale[]> {
  const evaluatedAt = alerts.map((alert) =>
    alert.last_evaluated_at ? Date.parse(alert.last_evaluated_at) : Number.NaN,
  );
  const neverEvaluated = evaluatedAt.some((time) => !Number.isFinite(time));
  const filters: SaleFilters = {
    status_in: ["active", "upcoming"],
    ...(neverEvaluated
      ? {}
      : {
          updated_since: new Date(
            Math.min(...evaluatedAt) - ALERT_EVALUATION_OVERLAP_MS,
          ).toISOString(),
        }),
    ...(discovery && alerts.length === 1
      ? { city: alerts[0].city ?? undefined, department: alerts[0].department ?? undefined }
      : {}),
  };

  const sales: AuctionSale[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < limit; offset += ALERT_EVALUATION_PAGE_SIZE) {
    const pageSize = Math.min(ALERT_EVALUATION_PAGE_SIZE, limit - offset);
    const page = await getSalesForAlertEvaluation(filters, pageSize, offset, {
      client: auth.supabase,
      discovery,
    });
    for (const sale of page) {
      if (seen.has(sale.id)) continue;
      seen.add(sale.id);
      sales.push(sale);
    }
    if (page.length < pageSize) break;
  }
  return sales;
}

/**
 * Les ventes ouvertes de ces identifiants (par lots de 100, ceux de la liste des pépites), pour les alertes
 * « Seulement les pépites » : mêmes colonnes et même vue que la lecture incrémentale.
 */
async function loadSalesByIds({
  auth,
  ids,
  discovery,
}: {
  auth: SupabaseAuthContext;
  ids: string[];
  discovery: boolean;
}): Promise<AuctionSale[]> {
  const sales: AuctionSale[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const chunk = ids.slice(offset, offset + 100);
    sales.push(
      ...(await getSalesForAlertEvaluation(
        { status_in: ["active", "upcoming"], ids: chunk },
        chunk.length,
        0,
        { client: auth.supabase, discovery },
      )),
    );
  }
  return sales;
}

/**
 * Relit les colonnes lourdes (blocs des sources, pièces) des seules ventes qu'une alerte retient sur
 * ses autres critères, et les ajoute à ces ventes : la classe DPE se lit dans les blocs, et le résumé
 * enregistré avec la correspondance garde la classe DPE et le nombre de pièces. Les autres ventes
 * échouent déjà sur un critère qui ne dépend pas de ces colonnes.
 */
async function attachAlertDetails({
  auth,
  alerts,
  sales,
  watchedZones,
  pepiteSaleIds,
}: {
  auth: SupabaseAuthContext;
  alerts: UserAlert[];
  sales: AuctionSale[];
  watchedZones: Map<string, UserWatchedZone>;
  pepiteSaleIds: ReadonlySet<string> | null;
}): Promise<void> {
  const ids = sales
    .filter((sale) =>
      alerts.some((alert) => {
        const watchedZone = alert.watched_zone_id
          ? (watchedZones.get(alert.watched_zone_id) ?? null)
          : null;
        if (alert.watched_zone_id && !watchedZone) return false;
        return alertMatchesSale(
          { ...alert, dpe_classes: [], min_market_discount_pct: null, min_yield_pct: null },
          sale,
          { watchedZone, pepiteSaleIds },
        ).matches;
      }),
    )
    .map((sale) => sale.id);
  if (!ids.length) return;

  const details = new Map(
    (await getSaleAlertDetails(ids, { client: auth.supabase })).map((row) => [row.id, row]),
  );
  for (const sale of sales) {
    const detail = details.get(sale.id);
    if (!detail) continue;
    sale.source_blocks = detail.source_blocks;
    sale.documents = detail.documents;
    sale.documents_rich = detail.documents_rich;
  }
}

export async function runSmartAlertEvaluationBatch({
  saleLimit = DEFAULT_ALERT_EVALUATION_SALE_LIMIT,
  timeBudgetMs = DEFAULT_ALERT_BATCH_TIME_BUDGET_MS,
  concurrency = ALERT_BATCH_CONCURRENCY,
}: {
  saleLimit?: number;
  timeBudgetMs?: number;
  concurrency?: number;
} = {}): Promise<SmartAlertBatchRunResult> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  // Every user with an active alert is processed, oldest evaluation first.
  const userIds = await getSmartAlertCandidateUserIds();
  const results: SmartAlertBatchUserResult[] = [];
  // Un seul chargement des loyers par exécution, partagé par toutes les alertes de tous les comptes.
  const rentSession = createRentLookupSession();
  const alertFailures: SmartAlertBatchRunResult["alertFailures"] = [];
  let next = 0;
  let deferred = 0;

  const worker = async () => {
    while (next < userIds.length) {
      const userId = userIds[next];
      next += 1;
      if (Date.now() - startedAtMs > timeBudgetMs) {
        deferred += 1;
        continue;
      }
      try {
        const response = await evaluateUserAlertMatches({
          auth: await systemAuthForUser(userId),
          saleLimit,
          persist: true,
          rentSession,
        });
        // Le compte n'échoue que si toutes ses alertes ont échoué ; sinon les échecs sont comptés.
        const allFailed =
          response.alertCount > 0 && response.failedAlertCount >= response.alertCount;
        alertFailures.push(...response.alertFailures.map((failure) => ({ userId, ...failure })));
        results.push({
          userId,
          ok: !allFailed,
          alertCount: response.alertCount,
          saleCount: response.saleCount,
          matchCount: response.matchCount,
          notificationCount: response.notificationCount,
          failedAlertCount: response.failedAlertCount,
          error: allFailed
            ? `${response.failedAlertCount} alerte(s) en échec : ${response.alertFailures[0]?.error ?? "Évaluation impossible"}`
            : null,
        });
      } catch (error) {
        const skipped = error instanceof AlertsNotIncludedError;
        const message = skipped ? null : errorSummary(error, "Évaluation impossible");
        if (!skipped) {
          console.error(
            JSON.stringify({
              scope: "smart-alerts",
              level: "error",
              outcome: "user_failed",
              userId,
              ...errorDetails(error, "Évaluation impossible"),
            }),
          );
        }
        results.push({
          userId,
          ok: skipped,
          skipped,
          alertCount: 0,
          saleCount: 0,
          matchCount: 0,
          notificationCount: 0,
          failedAlertCount: 0,
          error: message,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  return {
    ok: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    candidateUserCount: userIds.length,
    analysedUserCount: userIds.length - deferred,
    deferredUserCount: deferred,
    evaluatedUserCount: results.filter((result) => result.ok && !result.skipped).length,
    failedUserCount: results.filter((result) => !result.ok).length,
    failedAlertCount: results.reduce((total, result) => total + result.failedAlertCount, 0),
    alertFailures: alertFailures.slice(0, MAX_REPORTED_ALERT_FAILURES),
    totalMatchCount: results.reduce((total, result) => total + result.matchCount, 0),
    totalNotificationCount: results.reduce((total, result) => total + result.notificationCount, 0),
    results,
  };
}

/** Part de comptes en échec à partir de laquelle le passage est déclaré en échec. */
export const SMART_ALERT_FAILURE_RATE_THRESHOLD = 0.2;

/**
 * Un passage où des comptes ont échoué ne compte pas comme un succès quand l'échec n'est plus
 * isolé : échoue si `failedUserCount / analysedUserCount` atteint 20 %. Un compte seul en échec
 * (réseau, donnée) reste dans le rapport sans réveiller la supervision. Les comptes évalués ont déjà
 * été enregistrés ; le rattrapage reprend les autres (les plus anciennement évalués d'abord).
 */
export function assertSmartAlertBatchComplete(
  result: Pick<SmartAlertBatchRunResult, "analysedUserCount" | "failedUserCount" | "results">,
): void {
  if (result.analysedUserCount <= 0 || result.failedUserCount <= 0) return;
  if (result.failedUserCount / result.analysedUserCount < SMART_ALERT_FAILURE_RATE_THRESHOLD)
    return;
  const firstError = result.results.find((entry) => !entry.ok && entry.error)?.error;
  throw new Error(
    `Alertes intelligentes : ${result.failedUserCount} compte(s) en échec sur ${result.analysedUserCount} analysé(s) (seuil ${SMART_ALERT_FAILURE_RATE_THRESHOLD * 100} %)${firstError ? ` ; première erreur : ${firstError}` : ""}.`,
  );
}

export function buildAlertMatchSummary({
  alert,
  sale,
  reasons,
  marketDiscountPct,
  matchedAt,
}: {
  alert: Pick<UserAlert, "id" | "name">;
  sale: Pick<
    AuctionSale,
    "id" | "title" | "city" | "department" | "starting_price_eur" | "sale_date"
  >;
  reasons: string[];
  marketDiscountPct?: number | null;
  matchedAt: string;
}): AlertMatchSummary {
  return {
    id: null,
    alertId: alert.id,
    alertName: alert.name,
    saleId: sale.id,
    saleTitle: cleanSaleTitle(sale.title),
    city: sale.city,
    department: sale.department,
    startingPriceEur: sale.starting_price_eur,
    saleDate: sale.sale_date,
    reasons,
    marketDiscountPct: roundPercent(marketDiscountPct),
    matchedAt,
    readAt: null,
    dismissedAt: null,
  };
}

export function buildAlertMatchSnapshot({
  alert,
  sale,
  summary,
  watchedZone,
  discovery = false,
  rents,
}: {
  alert: Pick<
    UserAlert,
    | "id"
    | "name"
    | "department"
    | "city"
    | "property_type"
    | "max_price_eur"
    | "min_surface_m2"
    | "min_investment_score"
    | "max_price_per_m2"
    | "min_yield_pct"
    | "min_market_discount_pct"
    | "dpe_classes"
    | "require_house_with_land"
    | "watched_zone_id"
  >;
  sale: AuctionSale;
  summary: AlertMatchSummary;
  watchedZone?: UserWatchedZone | null;
  discovery?: boolean;
  /** Références de loyer (carte ANIL) ; absentes, le rendement du résumé suit le loyer départemental. */
  rents?: RentLookup;
}) {
  if (discovery) {
    return {
      audience: "discovery",
      alert: { id: alert.id, name: alert.name },
      sale: {
        id: sale.id,
        title: "Vente immobilière",
        city: sale.city,
        department: sale.department,
        startingPriceEur: sale.starting_price_eur,
        saleDate: sale.sale_date,
      },
      match: {
        // Seule la mention « pépite » (texte, sans montant) s'ajoute au motif public.
        reasons: summary.reasons.includes("pépite")
          ? ["Critères publics correspondants", "pépite"]
          : ["Critères publics correspondants"],
        marketDiscountPct: null,
        matchedAt: summary.matchedAt,
      },
    };
  }
  const surface = getSaleSurface(sale).value;
  const dpe = extractDpe(sale).class;
  const yieldPct = estimateSaleGrossYieldPct(sale, surface, rents?.(sale));
  const documents = documentSignatureParts(sale);

  return {
    alert: {
      id: alert.id,
      name: alert.name,
      criteria: {
        department: alert.department,
        city: alert.city,
        propertyType: alert.property_type,
        maxPriceEur: alert.max_price_eur,
        minSurfaceM2: alert.min_surface_m2,
        minInvestmentScore: alert.min_investment_score,
        maxPricePerM2: alert.max_price_per_m2,
        minYieldPct: alert.min_yield_pct,
        minMarketDiscountPct: alert.min_market_discount_pct,
        dpeClasses: alert.dpe_classes,
        requireHouseWithLand: alert.require_house_with_land,
        watchedZoneId: alert.watched_zone_id,
        watchedZone: watchedZone
          ? {
              id: watchedZone.id,
              name: watchedZone.name,
              zoneKind: watchedZone.zone_kind,
              department: watchedZone.department,
              city: watchedZone.city,
              postalCodePrefix: watchedZone.postal_code_prefix,
              centerLat: watchedZone.center_lat,
              centerLng: watchedZone.center_lng,
              radiusKm: watchedZone.radius_km,
            }
          : null,
      },
    },
    sale: {
      id: sale.id,
      title: cleanSaleTitle(sale.title),
      city: sale.city,
      department: sale.department,
      propertyType: sale.property_type,
      startingPriceEur: sale.starting_price_eur,
      saleDate: sale.sale_date,
      status: sale.status,
      surfaceM2: surface,
      pricePerM2: roundNumber(pricePerM2(sale.starting_price_eur, surface)),
      investmentScore: sale.investment_score,
      documentCount: documents.count,
      documentSignature: documents.signature,
      updatedAt: sale.updated_at,
      dpe,
      grossYieldPct: roundPercent(yieldPct),
      sourceName: sale.source_name,
      sourceUrl: sale.source_url,
    },
    match: {
      reasons: summary.reasons,
      marketDiscountPct: summary.marketDiscountPct,
      matchedAt: summary.matchedAt,
    },
  };
}

function alertMatchRowToSummary(row: AlertMatchRow): AlertMatchSummary {
  const snapshot = asRecord(row.match_snapshot);
  const alert = asRecord(snapshot.alert);
  const sale = asRecord(snapshot.sale);
  const match = asRecord(snapshot.match);

  return {
    id: row.id,
    alertId: row.alert_id,
    alertName: stringValue(asRecord(alert).name) || "Alerte",
    saleId: row.sale_id,
    saleTitle: cleanSaleTitle(stringValue(sale.title)),
    city: stringValue(sale.city),
    department: stringValue(sale.department),
    startingPriceEur: numberValue(sale.startingPriceEur),
    saleDate: stringValue(sale.saleDate),
    reasons: row.match_reasons,
    marketDiscountPct: numberValue(match.marketDiscountPct),
    matchedAt: row.matched_at,
    readAt: row.read_at,
    dismissedAt: row.dismissed_at,
  };
}

async function getActiveUserAlerts(auth: SupabaseAuthContext): Promise<UserAlert[]> {
  const { data, error } = await auth.supabase
    .from("user_alerts")
    .select("*")
    .eq("user_id", auth.userId)
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data ?? []) as UserAlert[];
}

async function getUserWatchedZonesForAlerts({
  auth,
  alerts,
}: {
  auth: SupabaseAuthContext;
  alerts: UserAlert[];
}): Promise<Map<string, UserWatchedZone>> {
  const zoneIds = Array.from(
    new Set(alerts.map((alert) => alert.watched_zone_id).filter((id): id is string => Boolean(id))),
  );
  if (!zoneIds.length) return new Map();

  const { data, error } = await auth.supabase
    .from("user_watched_zones")
    .select("*")
    .eq("user_id", auth.userId)
    .in("id", zoneIds)
    .eq("is_active", true);

  if (error) throw error;

  return new Map((data ?? []).map((row) => [row.id, normalizeWatchedZone(row)]));
}

async function getSmartAlertCandidateUserIds(): Promise<string[]> {
  const pageSize = 1_000;
  const userIds: string[] = [];
  const seen = new Set<string>();
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabaseAdmin
      .from("user_alerts")
      .select("user_id")
      .eq("is_active", true)
      .order("last_evaluated_at", { ascending: true, nullsFirst: true })
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    for (const row of data ?? []) {
      if (seen.has(row.user_id)) continue;
      seen.add(row.user_id);
      userIds.push(row.user_id);
    }
    if ((data?.length ?? 0) < pageSize) break;
  }
  return userIds;
}

async function getCachedMarketDiscount(
  cache: Map<string, Promise<number | null>>,
  sale: AuctionSale,
): Promise<number | null> {
  const existing = cache.get(sale.id);
  if (existing) return existing;

  const promise = estimateMarketDiscountPct(sale);
  cache.set(sale.id, promise);
  return promise;
}

/**
 * Écart entre la mise à prix et la valeur DVF précalculée, ou `null` sans estimation exploitable
 * et pour un écart aberrant (`src/lib/market-gap.ts`) : une telle vente ne remplit donc jamais un
 * critère « décote minimale » et son résumé n'affiche aucun pourcentage. Même entier que la fiche.
 *
 * Même règle que la bande publique (`get_public_sale_market_gap_band`) : seul un bien indiqué libre
 * reçoit un écart. Pour un bien occupé ou d'occupation inconnue, la valeur estimée s'appuie sur des
 * ventes de biens libres et la comparaison ne tient pas : `null`, donc jamais « environ 62 % sous la
 * valeur » pour un bien que la fiche ne situe pas.
 */
export async function estimateMarketDiscountPct(sale: AuctionSale): Promise<number | null> {
  if (marketGapWithheldReason(sale.occupancy_status)) return null;
  const marketSurfaces = getMarketValuationSurfaces(sale);
  const surface = marketSurfaces.builtSurfaceM2 ?? marketSurfaces.landSurfaceM2;
  const startingPrice = sale.starting_price_eur;
  if (
    (!sale.address &&
      !sale.city &&
      !sale.postal_code &&
      (sale.latitude == null || sale.longitude == null)) ||
    surface == null ||
    surface <= 0 ||
    startingPrice == null ||
    startingPrice <= 0
  ) {
    return null;
  }

  try {
    const estimate = await getPrecomputedMarketEstimate(sale.id);
    if (!estimate?.actionable) return null;
    const estimatedValue =
      estimate.estimatedValueEur ??
      (estimate.medianPricePerM2 ? estimate.medianPricePerM2 * surface : null);
    if (!estimatedValue || estimatedValue <= 0) return null;
    const gap = resolveMarketGap({
      estimatedValueEur: estimatedValue,
      startingPriceEur: startingPrice,
    });
    return gap.status === "gap" ? gap.discountPct : null;
  } catch {
    return null;
  }
}

function clampLimit(value: number, max: number): number {
  return Math.max(1, Math.min(max, Math.floor(value || 1)));
}

function roundNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function roundPercent(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function documentSignatureParts(sale: AuctionSale): { count: number; signature: string | null } {
  const values = Array.isArray(sale.documents_rich)
    ? sale.documents_rich.map((document) =>
        [
          document.url,
          document.label,
          document.type ?? document.document_type,
          document.extraction_status,
        ]
          .filter(Boolean)
          .join("|"),
      )
    : primitiveDocumentValues(sale.documents);
  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();

  return {
    count: unique.length,
    signature: unique.length ? unique.join("||") : null,
  };
}

function primitiveDocumentValues(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(primitiveDocumentValues);
  if (typeof value === "object") return Object.values(value).flatMap(primitiveDocumentValues);
  return [];
}

function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}
