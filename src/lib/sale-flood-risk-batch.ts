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
 *    toute redirection ;
 *  - une panne partielle ne passe pas pour un succès : quand au moins la moitié des appels échouent, sur au moins
 *    `FLOOD_DEGRADED_MIN_CALLS` appels, la passe lève une erreur (après avoir écrit ce qu'elle a pu) ; après
 *    `FLOOD_NETWORK_FAILURE_LIMIT` pannes réseau de suite, elle s'arrête (coupe-circuit) ; `failedByCode` chiffre
 *    les causes ;
 *  - une réponse vide n'est pas une preuve d'absence de risque : avant le premier appel de position de la passe, donc
 *    avant d'écrire le moindre verdict, un point de contrôle connu (`FLOOD_CONTROL_POINT`) doit rendre le scénario
 *    `01For` ; sinon la passe échoue avec le code `source_degraded` et n'écrit rien ;
 *  - une ligne refusée par la base est isolée en coupant le paquet par moitiés (comme le calcul des pépites) au
 *    lieu de bloquer les 24 autres.
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
/** Part d'appels en échec à partir de laquelle la passe est « dégradée » : la moitié. */
export const FLOOD_DEGRADED_RATE = 0.5;
/** Nombre d'appels (réussis ou non) en dessous duquel un taux d'échec ne dit rien : 20. */
export const FLOOD_DEGRADED_MIN_CALLS = 20;
/** Coupe-circuit : la passe s'arrête après 5 pannes réseau (ou délais dépassés) consécutives. */
export const FLOOD_NETWORK_FAILURE_LIMIT = 5;
/** Au-delà de ce nombre de lignes refusées une à une par la base, la panne n'est plus isolée : la passe échoue. */
export const FLOOD_MAX_REJECTED_ROWS = 5;
/** Au plus ce nombre de codes d'échec distincts dans `failedByCode` (le reste va sous `other`). */
const MAX_FAILURE_CODES = 20;

/**
 * Point de contrôle de la source : sur la Garonne à Toulouse (TRI de Toulouse, `FRF_TRI_TOULOUSE`), en plein lit du
 * fleuve, `tri_zonage` rend le scénario `01For` (aléa de forte probabilité, carte arrêtée le 03/12/2014). Relevé le
 * 28/10/2026 : toute la zone autour (environ 130 m sur 90 m) rend `01For` ; ce n'est pas un point de limite. La
 * cartographie des TRI est stable (arrêtés de 2012 à 2014) : si ce point ne rend plus `01For`, c'est la réponse de
 * l'API qui a changé (paramètre ignoré ou inversé, réponse vide) et aucun verdict « hors zone » ne doit être écrit.
 */
export const FLOOD_CONTROL_POINT = { latitude: 43.6026, longitude: 1.4314 };
export const FLOOD_CONTROL_SCENARIO = "01For";
/** Code de l'erreur levée quand le point de contrôle ne répond pas comme prévu. */
export const FLOOD_SOURCE_DEGRADED_CODE = "source_degraded";

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
  /** Codes de commune changés mais pas encore recopiés (la recopie est par lots) : repris à la passe suivante. */
  communesDeferred: number;
  /** Un verrou ou un délai a arrêté la recopie des communes : ce n'est pas une panne, elle reprend à la passe suivante. */
  communesBusy: boolean;
  /** L'échéance (`timeBudgetMs`) a arrêté la passe avant la fin de la liste. */
  stoppedByDeadline: boolean;
  /** Échecs par code (`network_econnreset`, `http_503`, `timeout`…), jamais une URL ni une coordonnée. */
  failedByCode: Record<string, number>;
  /** Appels de la source suivis d'une observation réussie (hors ventes servies sans appel, par le cache). */
  callsObserved: number;
  /** Appels de la source en échec (hors données invalides, qui ne disent rien de la source). */
  callsFailed: number;
  /** Le coupe-circuit des pannes réseau consécutives a arrêté la passe. */
  circuitOpen: boolean;
  /** Ventes dont l'écriture est restée bloquée par un verrou de ligne au dernier essai (reprises à la passe suivante). */
  writeBusy: number;
  /** Lignes refusées une à une par la base (le reste du paquet a été écrit). */
  writeRejected: number;
  /** Ventes à venir en attente de réobservation (`failure_count > 0`) à la fin de la passe. */
  awaitingReobservation: number;
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
      /** Au moins un appel à la source a été fait pour cette vente (sinon : cache ou aucune donnée à lire). */
      called: boolean;
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
        called: false,
      };
    }
    const cached = communeCache.get(insee);
    let hasTri: boolean;
    let called = false;
    if (cached && now.getTime() - cached.at < COMMUNE_TRI_CACHE_MS) {
      hasTri = cached.hasTri;
    } else {
      if (deadlineReached()) return { kind: "deadline" };
      const response = await fetchCommuneTri(insee, api);
      if (response.kind === "rate_limited") return response;
      if (response.kind === "failure") return response;
      hasTri = response.hasTri;
      called = true;
      communeCache.set(insee, { hasTri, at: now.getTime() });
    }
    return {
      kind: "observed",
      observation: { kind, communeHasTri: hasTri, probes: [] },
      scenarios: [],
      ppriPerimeter: null,
      called,
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
    called: true,
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
    communesDeferred: 0,
    communesBusy: false,
    stoppedByDeadline: false,
    failedByCode: {},
    callsObserved: 0,
    callsFailed: 0,
    circuitOpen: false,
    writeBusy: 0,
    writeRejected: 0,
    awaitingReobservation: 0,
    errors: [],
  };
}

/** Panne réseau ou délai dépassé : de quoi compter pour le coupe-circuit. */
function isNetworkFailureCode(code: string): boolean {
  return code === "network" || code.startsWith("network_") || code === "timeout";
}

/** Une donnée invalide de la vente ne dit rien de l'état de la source : elle ne compte pas dans le taux d'échec. */
function isSourceFailureCode(code: string): boolean {
  return code !== "invalid_position" && code !== "invalid_commune";
}

/**
 * Interroge le point de contrôle connu. `null` : la source répond comme prévu (scénario `01For`) ; sinon le code
 * de ce qu'elle a rendu (`no_scenario`, `rate_limited`, `network_…`, `http_…`), jamais de coordonnée.
 */
export async function checkFloodControlPoint(api: FloodApiOptions): Promise<string | null> {
  const response = await fetchTriZonage(FLOOD_CONTROL_POINT, api);
  if (response.kind === "rate_limited") return "rate_limited";
  if (response.kind === "failure") return response.code;
  return response.scenarios.includes(FLOOD_CONTROL_SCENARIO) ? null : "no_scenario";
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
    if (isSourceFailureCode(code)) result.callsFailed += 1;
    const known = code in result.failedByCode;
    const key =
      known || Object.keys(result.failedByCode).length < MAX_FAILURE_CODES ? code : "other";
    result.failedByCode[key] = (result.failedByCode[key] ?? 0) + 1;
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
  result.communesDeferred = synced.deferred;
  result.communesBusy = synced.busy;

  const [sales, storedRows, communes] = await Promise.all([
    readFloodSales(),
    readStoredFloodRisks(),
    readSaleCommunes(),
  ]);
  if (storedRows == null || communes == null) return { ...result, skipped: "not_migrated" };
  const stored = new Map(storedRows.map((row) => [row.saleId, row]));
  result.upcoming = sales.filter((sale) => isUpcoming(sale, now)).length;

  /** Ventes à venir en attente de réobservation (`failure_count > 0`), tenues à jour pendant la passe. */
  const awaiting = new Set<string>();
  for (const sale of sales) {
    if (isUpcoming(sale, now) && (stored.get(sale.id)?.failureCount ?? 0) > 0) {
      awaiting.add(sale.id);
    }
  }

  const pending = pickFloodPending(sales, stored, communes, now);
  const selected = pending.slice(0, Math.max(1, Math.min(1000, Math.floor(limit))));
  result.pending = pending.length;

  let toWrite: FloodRiskInsert[] = [];
  /** Paquets bloqués par un verrou de ligne, réessayés en fin de passe. */
  let deferred: FloodRiskInsert[] = [];
  let writtenRows = 0;
  /** Codes des lignes refusées une à une par la base. */
  const rejectedCodes = new Set<string>();
  /** Le point de contrôle a répondu comme prévu (fait une fois par passe, avant la première sonde de position). */
  let controlPassed = false;

  /**
   * Écrit un paquet. Verrou de ligne (57014, 55P03, 40P01) : le paquet est différé. Autre refus : le paquet est
   * coupé par moitiés jusqu'à isoler la ou les lignes fautives, comme `writeRows` du calcul des pépites ; trop de
   * lignes refusées (`FLOOD_MAX_REJECTED_ROWS`) : la panne n'est plus isolée, la passe échoue. `false` : la table
   * n'existe pas.
   */
  const writeRows = async (rows: FloodRiskInsert[]): Promise<boolean> => {
    try {
      const done = await upsertFloodRisks(rows);
      if (done) writtenRows += rows.length;
      return done;
    } catch (error) {
      const code = storeErrorCode(error);
      if (BUSY_WRITE_CODES.has(code)) {
        deferred.push(...rows);
        return true;
      }
      if (rows.length === 1) {
        result.writeRejected += 1;
        rejectedCodes.add(code);
        if (result.errors.length < MAX_REPORTED_ERRORS) result.errors.push(`write_refused_${code}`);
        if (result.writeRejected > FLOOD_MAX_REJECTED_ROWS) throw error;
        return true;
      }
      const middle = Math.ceil(rows.length / 2);
      if (!(await writeRows(rows.slice(0, middle)))) return false;
      return writeRows(rows.slice(middle));
    }
  };

  /** Écrit le paquet en cours ; `false` si la table n'existe pas. */
  const flush = async (): Promise<boolean> => {
    if (toWrite.length === 0) return true;
    const rows = toWrite;
    toWrite = [];
    return writeRows(rows);
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
  let networkStreak = 0;
  for (const item of selected) {
    if (deadlineReached()) {
      result.stoppedByDeadline = true;
      break;
    }
    const commune = communes.get(item.sale.id);
    const position = floodPositionOf(item.sale, commune);
    const key = floodPositionKey(position);
    const kind = classifyFloodPosition(position);
    if (kind !== "approximate" && !controlPassed) {
      // Avant le premier appel de position, donc avant toute écriture de verdict : la source répond-elle encore
      // comme prévu au point de contrôle ? Sinon « hors zone » ne voudrait rien dire (réponse vide, paramètre ignoré).
      const problem = await checkFloodControlPoint(apiOptions);
      if (problem === "rate_limited") {
        result.rateLimited = true;
        break;
      }
      if (problem) {
        throw new Error(
          `Source Géorisques dégradée (${FLOOD_SOURCE_DEGRADED_CODE}) : le point de contrôle ne rend pas le scénario ${FLOOD_CONTROL_SCENARIO} (${problem}) ; aucun verdict écrit dans cette passe`,
        );
      }
      controlPassed = true;
    }
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
      awaiting.add(item.sale.id);
      networkStreak = isNetworkFailureCode(outcome.code) ? networkStreak + 1 : 0;
      await recordAttempt(item, outcome.code, key, kind, commune);
      if (networkStreak >= FLOOD_NETWORK_FAILURE_LIMIT) {
        // Coupe-circuit : la source ne répond plus du tout, inutile d'insister ; la passe suivante reprend.
        result.circuitOpen = true;
        break;
      }
    } else {
      networkStreak = 0;
      const derived = deriveFloodVerdict(outcome.observation);
      const previous = item.stored;
      if (degradesKnownVerdict(derived, previous, key)) {
        // Périmètre des PPRi illisible : le verdict connu reste, la tentative est consignée comme une panne.
        fail("ppri_unreadable");
        awaiting.add(item.sale.id);
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
        if (outcome.called) result.callsObserved += 1;
        awaiting.delete(item.sale.id);
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
      result.writeBusy = deferred.length;
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
  if (result.writeRejected > 0 && writtenRows === 0) {
    throw new Error(
      `Écriture des verdicts d'inondation impossible : ${result.writeRejected} ligne(s) refusée(s) (code ${[...rejectedCodes].join(", ")})`,
    );
  }
  result.remaining = Math.max(0, pending.length - done);
  result.awaitingReobservation = awaiting.size;

  // Aucune observation alors qu'il y en avait à faire : la tâche est en panne (ou limitée), on le signale.
  if (result.observed === 0 && pending.length > 0 && (result.failed > 0 || result.rateLimited)) {
    throw new Error(
      `Observation du risque d'inondation impossible : ${result.rateLimited ? "limite de débit (429)" : result.errors.join(", ")}`,
    );
  }
  // Panne partielle : la moitié des appels (au moins 20) échouent. Ce qui a pu être observé est écrit, mais la
  // passe n'est pas un succès : la supervision (`cron.stale`) doit le voir au lieu d'un « vert » trompeur.
  const calls = result.callsObserved + result.callsFailed;
  if (calls >= FLOOD_DEGRADED_MIN_CALLS && result.callsFailed / calls >= FLOOD_DEGRADED_RATE) {
    throw new Error(
      `Observation du risque d'inondation dégradée : ${result.callsFailed} appel(s) en échec sur ${calls} (seuil ${FLOOD_DEGRADED_RATE * 100} %), par code ${formatFailedByCode(result.failedByCode)}${result.circuitOpen ? ", coupe-circuit ouvert" : ""}`,
    );
  }
  return result;
}

/** `network_econnreset=70, http_503=10` : les codes d'échec chiffrés, plus fréquents d'abord. */
function formatFailedByCode(failedByCode: Record<string, number>): string {
  return Object.entries(failedByCode)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([code, count]) => `${code}=${count}`)
    .join(", ");
}
