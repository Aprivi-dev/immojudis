import "server-only";
import {
  FLOOD_DERIVE_VERSION,
  classifyFloodPosition,
  deriveFloodVerdict,
  floodProbePoints,
  floodRefreshReason,
  isFloodProbeSetPartial,
  type FloodProbeObservation,
  type FloodRefreshReason,
  type FloodRiskObservation,
  type FloodVerdict,
} from "@/lib/flood-risk";
import { floodPositionKey } from "@/lib/flood-risk-position.server";
import {
  claimFloodRiskLease,
  floodPositionOf,
  readFloodSales,
  readSaleCommunes,
  readStoredFloodRisks,
  releaseFloodRiskLease,
  storeErrorCode,
  updateFloodRisk,
  upsertFloodRisks,
  type FloodRiskInsert,
  type FloodSale,
  type SaleCommune,
  type StoredFloodRow,
} from "@/lib/flood-risk-store.server";
import { fetchPpriPerimeter } from "@/lib/land-planning-ppri";
import {
  createStartPacer,
  fetchCommuneTri,
  fetchTriZonage,
  type FloodApiOptions,
} from "@/lib/land-risks-provider";
import { syncSaleCommunes } from "@/lib/sale-communes-sync.server";

/**
 * Observe le risque d'inondation des ventes à venir et le stocke (table `auction_sale_flood_risk`, migration
 * 20261106100200) : c'est le traitement planifié de `/api/cron/sale-flood-risk`, distinct du calcul des pépites,
 * qui ne fait JAMAIS d'appel réseau et ne lit que le verdict stocké (`sale-pepites-batch.ts`).
 *
 *  - une vente est observée quand elle n'a pas de verdict, quand sa position ou sa précision change, quand une
 *    tentative a échoué (retentée après `FLOOD_RETRY_HOURS` h), quand la dérivation change de version, et tous les
 *    `FLOOD_REFRESH_DAYS` jours (`floodRefreshReason`) ;
 *  - position précise (adresse, parcelle) : `tri_zonage` au point (Géorisques) puis le périmètre PPRi (servitude
 *    PM1, API Carto) ; une parcelle multiple : chaque centroïde (au plus 5) ; une rue : le point et quatre points du
 *    tampon (seul `high` est retenu, voir `flood-risk.ts`) ; position approximative (centre de commune,
 *    absente, drapeau douteux, lieu-dit ou numéro peu sûr de la BAN) : AUCUN appel de position, seulement la question « la commune compte-t-elle un TRI ? »
 *    (GASPAR, mise en cache par commune) ;
 *  - cadence de 2 à 3 appels par seconde (`FLOOD_MIN_INTERVAL_MS`), tous services confondus ; un 429 arrête la
 *    passe (coupe-circuit) ;
 *  - une source en échec n'écrase JAMAIS un verdict connu : seule la tentative est consignée ; la dernière valeur
 *    valable reste utilisée 180 jours (`effectiveFloodVerdict`) ;
 *  - un verdict « aucun risque élevé » dont le périmètre des PPRi n'a pas pu être lu n'écrase jamais un verdict
 *    déjà connu pour la même position (« exposé », ou « aucun risque élevé » lu en entier) : seule la tentative
 *    est consignée (`ppri_unreadable`) ;
 *  - une seule passe à la fois (bail `sale_flood_risk_lease`, migration 20261106100500) : une seconde passe
 *    simultanée rend `skipped: "busy"` ;
 *  - temps borné : aucune sonde ne démarre s'il reste moins de `FLOOD_MIN_REMAINING_MS` (40 s) sur les 300 s de
 *    `maxDuration` de la route ; chaque appel est limité à `FLOOD_CALL_TIMEOUT_MS` (8 s) ; les verdicts sont
 *    écrits par paquets de `WRITE_CHUNK` ventes pendant la passe, non à sa fin ;
 *  - seules les coordonnées de la vente partent aux services de l'État, jamais son adresse ; ni la sortie du
 *    traitement ni ses erreurs ne portent de coordonnée, d'URL ni de réponse de la source ; les appels refusent
 *    toute redirection.
 */

/** Intervalle minimal entre deux appels : 400 ms, soit 2,5 appels par seconde. */
export const FLOOD_MIN_INTERVAL_MS = 400;
/** Les communes (a-t-elle un TRI ?) changent rarement : un jour de cache. */
export const COMMUNE_TRI_CACHE_MS = 24 * 3_600_000;
const MAX_REPORTED_ERRORS = 5;
/** Les verdicts sont écrits par paquets de 25 ventes pendant la passe (20 à 25 : ni trop tard, ni trop souvent). */
export const WRITE_CHUNK = 25;
/**
 * Écriture bloquée par un verrou de ligne : la publication du pipeline tient des ventes `FOR UPDATE` le temps de sa
 * transaction, et la clé étrangère d'un verdict attend ce verrou jusqu'au délai de la requête (57014). Le paquet
 * est réessayé en fin de passe, puis laissé à la passe suivante : ces ventes restent en attente.
 */
const BUSY_WRITE_CODES = new Set(["57014", "55P03", "40P01"]);
/** `maxDuration` de la route `/api/cron/sale-flood-risk`. */
export const FLOOD_MAX_DURATION_MS = 300_000;
/** Marge minimale avant `maxDuration` pour démarrer une sonde (une sonde dure au plus ~17 s, plus l'écriture). */
export const FLOOD_MIN_REMAINING_MS = 40_000;
/** Aucune nouvelle sonde au-delà : 260 s écoulées. */
export const FLOOD_DEFAULT_TIME_BUDGET_MS = FLOOD_MAX_DURATION_MS - FLOOD_MIN_REMAINING_MS;
/** Délai d'un appel (TRI, GASPAR ou PM1) : 8 s. */
export const FLOOD_CALL_TIMEOUT_MS = 8_000;

const FLOOD_PACER = createStartPacer(FLOOD_MIN_INTERVAL_MS);
const COMMUNE_TRI_CACHE = new Map<string, { hasTri: boolean; at: number }>();

export type SaleFloodRiskBatchResult = {
  skipped: "not_migrated" | "busy" | null;
  deriveVersion: string;
  /** Ventes à venir examinées. */
  upcoming: number;
  /** Ventes à observer (toutes raisons confondues). */
  pending: number;
  /** Observations réussies et écrites. */
  observed: number;
  /** Observations en échec (verdict connu conservé). */
  failed: number;
  remaining: number;
  /** Un 429 a arrêté la passe. */
  rateLimited: boolean;
  /** Verdicts écrits pendant la passe, par valeur. */
  verdicts: Record<FloodVerdict, number>;
  /** Codes de commune synchronisés depuis le pipeline. */
  communesWritten: number;
  /** Codes de commune refusés par la base (ligne invalide ignorée). */
  communesRejected: number;
  /** L'échéance (`timeBudgetMs`) a arrêté la passe avant la fin de la liste. */
  stoppedByDeadline: boolean;
  /** Codes d'échec (`http_503`, `timeout`…), jamais une URL ni une coordonnée. */
  errors: string[];
};

type PendingSale = {
  sale: FloodSale;
  reason: FloodRefreshReason;
  stored: StoredFloodRow | undefined;
};

const REASON_ORDER: Record<FloodRefreshReason, number> = {
  missing: 0,
  position_changed: 1,
  retry: 2,
  version: 3,
  aged: 4,
};

function time(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function isUpcoming(sale: FloodSale, now: Date): boolean {
  const saleTime = time(sale.saleDate);
  return sale.status === "upcoming" && saleTime != null && saleTime > now.getTime();
}

/**
 * Les ventes à observer, les plus urgentes d'abord : jamais observées, position modifiée, tentatives à reprendre,
 * autre version, puis les plus anciennes ; à raison égale, la vente la plus proche passe la première.
 */
export function pickFloodPending(
  sales: readonly FloodSale[],
  stored: ReadonlyMap<string, StoredFloodRow>,
  communes: ReadonlyMap<string, SaleCommune>,
  now: Date,
): PendingSale[] {
  const pending: PendingSale[] = [];
  for (const sale of sales) {
    if (!isUpcoming(sale, now)) continue;
    const key = floodPositionKey(floodPositionOf(sale, communes.get(sale.id)));
    const row = stored.get(sale.id);
    const reason = floodRefreshReason(row, key, now);
    if (reason) pending.push({ sale, reason, stored: row });
  }
  return pending.sort(
    (left, right) =>
      REASON_ORDER[left.reason] - REASON_ORDER[right.reason] ||
      (time(left.reason === "aged" ? (left.stored?.observedAt ?? null) : left.sale.saleDate) ?? 0) -
        (time(right.reason === "aged" ? (right.stored?.observedAt ?? null) : right.sale.saleDate) ??
          0) ||
      left.sale.id.localeCompare(right.sale.id),
  );
}

type Outcome =
  | {
      kind: "observed";
      observation: FloodRiskObservation;
      scenarios: string[][];
      ppriPerimeter: boolean | null;
    }
  | { kind: "failure"; code: string }
  | { kind: "rate_limited" }
  | { kind: "deadline" };

type ObserveContext = {
  api: FloodApiOptions;
  communeCache: Map<string, { hasTri: boolean; at: number }>;
  now: Date;
  /** Vrai quand il reste moins de `FLOOD_MIN_REMAINING_MS` : aucune sonde ne démarre. */
  deadlineReached: () => boolean;
};

/** L'observation d'une vente : les appels de sa position (ou de sa commune), sans jamais rien journaliser. */
async function observe(
  sale: FloodSale,
  commune: SaleCommune | undefined,
  { api, communeCache, now, deadlineReached }: ObserveContext,
): Promise<Outcome> {
  const position = floodPositionOf(sale, commune);
  const kind = classifyFloodPosition(position);

  if (kind === "approximate") {
    // Aucun appel de position : seule la commune compte (un centre de commune n'est jamais envoyé).
    const insee = position.communeInsee;
    if (!insee) {
      return {
        kind: "observed",
        observation: { kind, communeHasTri: null, probes: [] },
        scenarios: [],
        ppriPerimeter: null,
      };
    }
    const cached = communeCache.get(insee);
    let hasTri: boolean;
    if (cached && now.getTime() - cached.at < COMMUNE_TRI_CACHE_MS) {
      hasTri = cached.hasTri;
    } else {
      if (deadlineReached()) return { kind: "deadline" };
      const response = await fetchCommuneTri(insee, api);
      if (response.kind === "rate_limited") return response;
      if (response.kind === "failure") return response;
      hasTri = response.hasTri;
      communeCache.set(insee, { hasTri, at: now.getTime() });
    }
    return {
      kind: "observed",
      observation: { kind, communeHasTri: hasTri, probes: [] },
      scenarios: [],
      ppriPerimeter: null,
    };
  }

  const probes: FloodProbeObservation[] = [];
  const scenarios: string[][] = [];
  let mapDate: string | null = null;
  for (const point of floodProbePoints(position)) {
    // L'échéance est contrôlée avant CHAQUE sonde : une rue en compte cinq.
    if (deadlineReached()) return { kind: "deadline" };
    const tri = await fetchTriZonage(point, api);
    if (tri.kind === "rate_limited") return tri;
    if (tri.kind === "failure") return tri;
    mapDate = mapDate ?? tri.mapDate;
    // Le périmètre PPRi n'est qu'un affichage : son indisponibilité n'empêche pas le verdict d'exclusion.
    const ppri = await fetchPpriPerimeter(point, {
      fetcher: api.fetcher,
      pace: api.pace,
      timeoutMs: api.timeoutMs,
    });
    if (ppri.kind === "rate_limited") return ppri;
    probes.push({
      triScenarios: tri.scenarios,
      ppri: ppri.kind === "ok" ? ppri.inPerimeter : null,
    });
    scenarios.push(tri.scenarios);
  }
  const anyInPerimeter = probes.some((probe) => probe.ppri === true);
  const allRead = probes.every((probe) => probe.ppri !== null);
  return {
    kind: "observed",
    observation: {
      kind,
      communeHasTri: null,
      probes,
      mapDate,
      partial: isFloodProbeSetPartial(position),
    },
    scenarios,
    ppriPerimeter: anyInPerimeter ? true : allRead ? false : null,
  };
}

function emptyVerdicts(): Record<FloodVerdict, number> {
  return { high: 0, exposed: 0, none_found: 0, no_signal: 0, unknown: 0 };
}

export type SaleFloodRiskBatchOptions = {
  limit?: number;
  now?: Date;
  /** Temps écoulé au-delà duquel plus aucune sonde ne démarre (la prochaine exécution reprend). */
  timeBudgetMs?: number;
  /** Client des services externes : `fetcher` (tests), `pace` (cadence), `timeoutMs` (8 s par défaut). */
  api?: FloodApiOptions;
  communeCache?: Map<string, { hasTri: boolean; at: number }>;
  /** Horloge en millisecondes (tests : horloge simulée). */
  clock?: () => number;
};

/**
 * Une passe, sous bail : une seconde passe simultanée rend `skipped: "busy"` sans rien lire ni appeler. Le bail
 * est rendu à la fin, même en cas d'erreur ; il expire seul au bout de `FLOOD_LEASE_SECONDS` si la passe meurt.
 */
export async function runSaleFloodRiskBatch(
  options: SaleFloodRiskBatchOptions = {},
): Promise<SaleFloodRiskBatchResult> {
  const lease = await claimFloodRiskLease();
  if (lease.kind === "busy") {
    return { ...emptyResult(), skipped: "busy" };
  }
  try {
    return await runPass(options);
  } finally {
    if (lease.kind === "held") await releaseFloodRiskLease(lease.token);
  }
}

function emptyResult(): SaleFloodRiskBatchResult {
  return {
    skipped: null,
    deriveVersion: FLOOD_DERIVE_VERSION,
    upcoming: 0,
    pending: 0,
    observed: 0,
    failed: 0,
    remaining: 0,
    rateLimited: false,
    verdicts: emptyVerdicts(),
    communesWritten: 0,
    communesRejected: 0,
    stoppedByDeadline: false,
    errors: [],
  };
}

/**
 * Un verdict « aucun risque élevé » dont le périmètre des PPRi n'a pas été lu est un demi-contrôle : il n'efface
 * pas un verdict déjà connu pour la MÊME position, qu'il soit « exposé » ou « aucun risque élevé » lu en entier.
 */
function degradesKnownVerdict(
  derived: { verdict: FloodVerdict; ppriChecked: boolean },
  previous: StoredFloodRow | undefined,
  key: string,
): boolean {
  if (derived.verdict !== "none_found" || derived.ppriChecked) return false;
  if (!previous || previous.positionKey !== key) return false;
  return (
    previous.verdict === "exposed" || (previous.verdict === "none_found" && previous.ppriChecked)
  );
}

async function runPass({
  limit = 150,
  now = new Date(),
  timeBudgetMs = FLOOD_DEFAULT_TIME_BUDGET_MS,
  api = {},
  communeCache = COMMUNE_TRI_CACHE,
  clock = Date.now,
}: SaleFloodRiskBatchOptions): Promise<SaleFloodRiskBatchResult> {
  const startedAt = clock();
  const deadlineReached = () => clock() - startedAt > timeBudgetMs;
  const result = emptyResult();
  const fail = (code: string) => {
    result.failed += 1;
    if (result.errors.length < MAX_REPORTED_ERRORS) result.errors.push(code);
  };
  const apiOptions: FloodApiOptions = {
    ...api,
    pace: api.pace ?? FLOOD_PACER,
    timeoutMs: api.timeoutMs ?? FLOOD_CALL_TIMEOUT_MS,
  };

  const synced = await syncSaleCommunes(now);
  if (synced.notMigrated) return { ...result, skipped: "not_migrated" };
  result.communesWritten = synced.written;
  result.communesRejected = synced.rejected;

  const [sales, storedRows, communes] = await Promise.all([
    readFloodSales(),
    readStoredFloodRisks(),
    readSaleCommunes(),
  ]);
  if (storedRows == null || communes == null) return { ...result, skipped: "not_migrated" };
  const stored = new Map(storedRows.map((row) => [row.saleId, row]));
  result.upcoming = sales.filter((sale) => isUpcoming(sale, now)).length;

  const pending = pickFloodPending(sales, stored, communes, now);
  const selected = pending.slice(0, Math.max(1, Math.min(1000, Math.floor(limit))));
  result.pending = pending.length;

  let toWrite: FloodRiskInsert[] = [];
  /** Paquets bloqués par un verrou de ligne, réessayés en fin de passe. */
  let deferred: FloodRiskInsert[] = [];
  let writtenRows = 0;
  /** Écrit le paquet en cours ; `false` si la table n'existe pas. */
  const flush = async (): Promise<boolean> => {
    if (toWrite.length === 0) return true;
    const rows = toWrite;
    toWrite = [];
    try {
      const written = await upsertFloodRisks(rows);
      if (written) writtenRows += rows.length;
      return written;
    } catch (error) {
      if (!BUSY_WRITE_CODES.has(storeErrorCode(error))) throw error;
      deferred.push(...rows);
      return true;
    }
  };

  /** Une tentative sans verdict : jamais d'écrasement d'un verdict connu (seule la tentative est consignée). */
  const recordAttempt = async (
    item: PendingSale,
    code: string,
    key: string,
    kind: string,
    commune: SaleCommune | undefined,
  ) => {
    const previous = item.stored;
    if (previous) {
      try {
        await updateFloodRisk(item.sale.id, {
          attempted_at: now.toISOString(),
          failure_count: previous.failureCount + 1,
          last_failure: code,
          updated_at: now.toISOString(),
        });
      } catch (error) {
        // Le détail de l'erreur est déjà réduit à un code par le magasin : on le consigne, la passe continue.
        if (result.errors.length < MAX_REPORTED_ERRORS) {
          result.errors.push(`attempt_write_${storeErrorCode(error)}`);
        }
      }
      return;
    }
    toWrite.push({
      sale_id: item.sale.id,
      verdict: "unknown",
      derive_version: FLOOD_DERIVE_VERSION,
      position_key: key,
      position_kind: kind,
      commune_insee: commune?.communeInsee ?? null,
      observed_at: null,
      attempted_at: now.toISOString(),
      failure_count: 1,
      last_failure: code,
      verdict_changed_at: now.toISOString(),
      updated_at: now.toISOString(),
    });
  };

  let done = 0;
  for (const item of selected) {
    if (deadlineReached()) {
      result.stoppedByDeadline = true;
      break;
    }
    const commune = communes.get(item.sale.id);
    const position = floodPositionOf(item.sale, commune);
    const key = floodPositionKey(position);
    const kind = classifyFloodPosition(position);
    const outcome = await observe(item.sale, commune, {
      api: apiOptions,
      communeCache,
      now,
      deadlineReached,
    });

    if (outcome.kind === "rate_limited") {
      // Coupe-circuit : plus aucun appel pendant cette passe, la suivante reprend.
      result.rateLimited = true;
      break;
    }
    if (outcome.kind === "deadline") {
      // La vente n'est pas finie : rien n'est écrit pour elle, la passe suivante la reprend.
      result.stoppedByDeadline = true;
      break;
    }
    done += 1;
    if (outcome.kind === "failure") {
      fail(outcome.code);
      await recordAttempt(item, outcome.code, key, kind, commune);
    } else {
      const derived = deriveFloodVerdict(outcome.observation);
      const previous = item.stored;
      if (degradesKnownVerdict(derived, previous, key)) {
        // Périmètre des PPRi illisible : le verdict connu reste, la tentative est consignée comme une panne.
        fail("ppri_unreadable");
        await recordAttempt(item, "ppri_unreadable", key, kind, commune);
      } else {
        const unchanged =
          previous?.verdict === derived.verdict &&
          previous.positionKey === key &&
          previous.ppriChecked === derived.ppriChecked;
        result.verdicts[derived.verdict] += 1;
        toWrite.push({
          sale_id: item.sale.id,
          verdict: derived.verdict,
          derive_version: FLOOD_DERIVE_VERSION,
          position_key: key,
          position_kind: kind,
          commune_insee: commune?.communeInsee ?? null,
          commune_has_tri: outcome.observation.communeHasTri,
          tri_scenarios: outcome.scenarios,
          ppri_perimeter: outcome.ppriPerimeter,
          ppri_checked: derived.ppriChecked,
          map_date: outcome.observation.mapDate ?? null,
          observed_at: now.toISOString(),
          attempted_at: now.toISOString(),
          failure_count: 0,
          last_failure: null,
          verdict_changed_at: unchanged
            ? (previous?.verdictChangedAt ?? now.toISOString())
            : now.toISOString(),
          updated_at: now.toISOString(),
        });
        result.observed += 1;
      }
    }

    // Écriture par paquets pendant la passe : un arrêt brutal ne perd que le paquet en cours.
    if (toWrite.length >= WRITE_CHUNK && !(await flush())) {
      return { ...result, skipped: "not_migrated" };
    }
  }

  if (!(await flush())) return { ...result, skipped: "not_migrated" };
  if (deferred.length > 0) {
    // Dernier essai des paquets bloqués ; s'ils le sont encore, la passe suivante reprend ces ventes.
    toWrite = deferred;
    deferred = [];
    if (!(await flush())) return { ...result, skipped: "not_migrated" };
    if (deferred.length > 0) {
      if (result.errors.length < MAX_REPORTED_ERRORS) {
        result.errors.push(`write_busy_${deferred.length}`);
      }
      // Rien n'a pu être écrit de toute la passe : la tâche est en panne, la supervision doit le voir.
      if (writtenRows === 0) {
        throw new Error(
          "Écriture des verdicts d'inondation impossible : ventes verrouillées pendant toute la passe",
        );
      }
    }
  }
  result.remaining = Math.max(0, pending.length - done);

  // Aucune observation alors qu'il y en avait à faire : la tâche est en panne (ou limitée), on le signale.
  if (result.observed === 0 && pending.length > 0 && (result.failed > 0 || result.rateLimited)) {
    throw new Error(
      `Observation du risque d'inondation impossible : ${result.rateLimited ? "limite de débit (429)" : result.errors.join(", ")}`,
    );
  }
  return result;
}
