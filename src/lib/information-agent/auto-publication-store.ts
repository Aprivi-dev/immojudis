import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  AUTO_PUBLICATION_ELIGIBLE_FIELDS,
  AUTO_PUBLICATION_MODES,
  AUTO_PUBLICATION_POLICY_VERSION,
  planAutoPublicationDecisions,
  proposedNumber,
  type AutoPublicationCounters,
  type AutoPublicationMode,
  type AutoPublicationPlanItem,
} from "@/lib/information-agent/auto-publication-policy";
import { startOfParisDay } from "@/lib/information-agent/paris-time";

/**
 * Accès en base du moteur « publier ou relire » (migration 20261115100000) : lecture du mode, passe de
 * simulation (lecture des faits et de leur contexte, décision, journal) et lecture des dernières décisions.
 * Rien ici n'écrit sur une fiche : le journal est la seule écriture, par la RPC de service qui n'écrit
 * qu'en mode « simulation ».
 */

/** Fenêtre des faits examinés : au-delà, la réponse est hors du délai de 30 jours de toute façon. */
const CANDIDATE_WINDOW_DAYS = 45;
/** Taille d'une page de lecture (liste `in` de PostgREST) et nombre maximal de faits par passe. */
const PAGE_SIZE = 100;
const MAX_CANDIDATES_PER_PASS = 500;
/**
 * Plafond de lignes rendu par PostgREST (`max-rows`, 1000 par défaut). Une lecture qui l'atteint est
 * peut-être tronquée : elle est traitée comme illisible (relecture), jamais comme complète.
 */
export const AUTO_PUBLICATION_MAX_ROWS = 1000;
/** Temps maximal d'écriture des décisions dans une passe (le cron des réponses dure au plus 300 s). */
const PASS_TIME_BUDGET_MS = 60_000;
/** La boucle d'écriture s'arrête après ce nombre d'échecs consécutifs du même code. */
const MAX_SAME_ERROR_STREAK = 3;

/** Codes d'une table ou d'une fonction absente (migration pas encore appliquée). */
const NOT_INSTALLED_CODES = new Set(["PGRST205", "PGRST202", "42P01", "42883"]);

export class AutoPublicationNotInstalledError extends Error {
  constructor() {
    super("Publication automatique non installée (migration 20261115100000 absente).");
  }
}

export type AutoPublicationDecisionRow = {
  outcome: "would_publish" | "review";
  reasons: string[];
  decidedAt: string;
  policyVersion: string;
};

export type AutoPublicationSimulationResult =
  | { status: "inactive"; mode: AutoPublicationMode }
  /** Code déployé avant la migration : rien n'est fait, le cron ne doit pas échouer. */
  | { status: "not_installed" }
  | {
      status: "done";
      /** Faits ouverts lus (en attente, champ de la liste fermée). */
      examined: number;
      /** Faits déjà « publiés » en simulation un jour antérieur : sortis du lot. */
      frozen: number;
      recorded: number;
      /** Décision identique à la dernière du journal : aucun appel. */
      unchanged: number;
      wouldPublish: number;
      review: number;
      /** Faits décidés « relecture » parce qu'une lecture a échoué (signalés dans le journal serveur). */
      unreadable: number;
      /** Décisions que la RPC n'a pas pu écrire. */
      recordFailed: number;
      /** Plus de faits ouverts que la passe n'en examine : les plus récents attendent la suivante. */
      truncated: boolean;
      /** Temps d'écriture épuisé : la suite attend la passe suivante. */
      timedOut: boolean;
      /** Écriture arrêtée après plusieurs échecs consécutifs du même code. */
      stoppedOnRepeatedError: boolean;
    }
  /** La passe a échoué (mode ou liste des faits illisible) ; seul le code d'erreur est gardé. */
  | { status: "failed"; code: string };

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
}

function logFailure(stage: string, error: unknown) {
  console.error(
    JSON.stringify({ scope: "information_agent.auto_publication", stage, code: errorCode(error) }),
  );
}

function isNotInstalled(error: unknown): boolean {
  return NOT_INSTALLED_CODES.has(errorCode(error));
}

/**
 * Mode courant. Table absente : `AutoPublicationNotInstalledError`. Ligne absente ou valeur inconnue :
 * erreur (l'appelant ne décide alors rien).
 */
export async function loadAutoPublicationMode(): Promise<AutoPublicationMode> {
  const { data, error } = await supabaseAdmin
    .from("information_agent_auto_publication_settings")
    .select("mode")
    .eq("singleton", true)
    .maybeSingle();
  if (error) {
    if (isNotInstalled(error)) throw new AutoPublicationNotInstalledError();
    throw error;
  }
  const mode = data?.mode;
  if (!mode || !(AUTO_PUBLICATION_MODES as readonly string[]).includes(mode)) {
    throw new Error("Réglage de publication automatique absent ou illisible.");
  }
  return mode as AutoPublicationMode;
}

function chunks<T>(values: T[], size = PAGE_SIZE): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

/**
 * Lit par paquets d'identifiants. Une erreur, ou un paquet qui atteint le plafond de lignes (lecture
 * peut-être tronquée), rend `null` et est signalé : les faits concernés passeront en relecture.
 */
async function readInChunks<T>(
  stage: string,
  ids: string[],
  read: (ids: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[] | null> {
  const rows: T[] = [];
  for (const part of chunks([...new Set(ids)])) {
    const { data, error } = await read(part);
    if (error) {
      logFailure(stage, error);
      return null;
    }
    if ((data ?? []).length >= AUTO_PUBLICATION_MAX_ROWS) {
      logFailure(stage, { code: "truncated" });
      return null;
    }
    rows.push(...(data ?? []));
  }
  return rows;
}

type CandidateRow = {
  id: string;
  case_id: string;
  message_id: string;
  sale_id: string;
  fact_key: string;
  status: string;
  evidence_asset_id: string | null;
  reviewed_by: string | null;
  proposed_value: unknown;
  metadata: unknown;
};

/** Faits que le moteur peut décider : en attente, champ de la liste fermée, reçus depuis 45 jours. */
async function loadOpenCandidates(
  now: Date,
): Promise<{ rows: CandidateRow[]; truncated: boolean }> {
  const since = new Date(now.getTime() - CANDIDATE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows: CandidateRow[] = [];
  for (let offset = 0; offset < MAX_CANDIDATES_PER_PASS; offset += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("information_agent_fact_candidates")
      .select(
        "id,case_id,message_id,sale_id,fact_key,status,evidence_asset_id,reviewed_by,proposed_value,metadata",
      )
      .eq("status", "pending")
      .in("fact_key", [...AUTO_PUBLICATION_ELIGIBLE_FIELDS])
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...((data ?? []) as CandidateRow[]));
    if ((data ?? []).length < PAGE_SIZE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/** Dernière décision de chaque fait demandé, ou `null` si la lecture a échoué ou a été tronquée. */
async function readLatestDecisions(
  factIds: string[],
): Promise<Map<string, AutoPublicationDecisionRow> | null> {
  const rows = await readInChunks("latest_decisions", factIds, (ids) =>
    supabaseAdmin
      .from("information_agent_auto_publication_decisions")
      .select("id,fact_id,outcome,reasons,decided_at,policy_version")
      .in("fact_id", ids)
      .order("decided_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(AUTO_PUBLICATION_MAX_ROWS),
  );
  if (!rows) return null;
  const latest = new Map<string, AutoPublicationDecisionRow>();
  for (const row of rows) {
    if (latest.has(row.fact_id)) continue;
    if (row.outcome !== "would_publish" && row.outcome !== "review") {
      logFailure("latest_decisions", { code: "invalid_outcome" });
      return null;
    }
    latest.set(row.fact_id, {
      outcome: row.outcome,
      reasons: row.reasons ?? [],
      decidedAt: row.decided_at,
      policyVersion: row.policy_version,
    });
  }
  return latest;
}

/**
 * État de la simulation hors du lot (voir `AutoPublicationCounters`) : faits « publiés » aujourd'hui, par
 * dossier et champs remplis, à partir des décisions « would_publish » du journal, faits du lot exclus.
 */
async function loadCounters(
  now: Date,
  plan: CandidateRow[],
): Promise<AutoPublicationCounters | null> {
  const inPlan = new Set(plan.map((row) => row.id));
  const { data: todayRows, error: todayError } = await supabaseAdmin
    .from("information_agent_auto_publication_decisions")
    .select("id,fact_id")
    .eq("outcome", "would_publish")
    .gte("decided_at", startOfParisDay(now).toISOString())
    .order("decided_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(AUTO_PUBLICATION_MAX_ROWS);
  if (todayError) {
    logFailure("counters_today", todayError);
    return null;
  }
  if ((todayRows ?? []).length >= AUTO_PUBLICATION_MAX_ROWS) {
    logFailure("counters_today", { code: "truncated" });
    return null;
  }
  const caseRows = await readInChunks(
    "counters_case",
    plan.map((row) => row.case_id),
    (ids) =>
      supabaseAdmin
        .from("information_agent_auto_publication_decisions")
        .select("id,fact_id,case_id")
        .eq("outcome", "would_publish")
        .in("case_id", ids)
        .order("id", { ascending: true })
        .limit(AUTO_PUBLICATION_MAX_ROWS),
  );
  const saleRows = await readInChunks(
    "counters_sale",
    plan.map((row) => row.sale_id),
    (ids) =>
      supabaseAdmin
        .from("information_agent_auto_publication_decisions")
        .select("id,fact_id,sale_id,fact_key")
        .eq("outcome", "would_publish")
        .in("sale_id", ids)
        .order("id", { ascending: true })
        .limit(AUTO_PUBLICATION_MAX_ROWS),
  );
  if (!caseRows || !saleRows) return null;
  const today = new Set((todayRows ?? []).map((row) => row.fact_id).filter((id) => !inPlan.has(id)))
    .size;
  const factsByCase = new Map<string, Set<string>>();
  for (const row of caseRows) {
    if (inPlan.has(row.fact_id)) continue;
    factsByCase.set(row.case_id, (factsByCase.get(row.case_id) ?? new Set()).add(row.fact_id));
  }
  return {
    today,
    byCase: new Map([...factsByCase].map(([caseId, facts]) => [caseId, facts.size])),
    filled: new Set(
      saleRows
        .filter((row) => !inPlan.has(row.fact_id))
        .map((row) => `${row.sale_id}:${row.fact_key}`),
    ),
  };
}

type MessageRow = {
  id: string;
  case_id: string | null;
  direction: string | null;
  received_at: string | null;
  created_at: string;
  subject: string | null;
  body_text: string | null;
  metadata: unknown;
};

function receivedTime(message: MessageRow): number {
  const parsed = Date.parse(message.received_at ?? message.created_at);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function sameValue(left: unknown, right: unknown): boolean {
  const a = proposedNumber(left);
  const b = proposedNumber(right);
  return a !== null && b !== null && a === b;
}

/** Contexte de chaque fait du lot : message, messages postérieurs, dossier, vente, autres valeurs, pièce. */
async function buildPlanItems(plan: CandidateRow[]): Promise<AutoPublicationPlanItem[]> {
  const caseIds = plan.map((row) => row.case_id);
  const saleIds = plan.map((row) => row.sale_id);
  const assetIds = plan.flatMap((row) => (row.evidence_asset_id ? [row.evidence_asset_id] : []));
  const eligible = [...AUTO_PUBLICATION_ELIGIBLE_FIELDS];
  const [messages, cases, sales, related, assets] = await Promise.all([
    readInChunks<MessageRow>("messages", caseIds, (ids) =>
      supabaseAdmin
        .from("information_agent_messages")
        .select("id,case_id,direction,received_at,created_at,subject,body_text,metadata")
        .in("case_id", ids)
        .eq("direction", "inbound")
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(AUTO_PUBLICATION_MAX_ROWS),
    ),
    readInChunks("cases", caseIds, (ids) =>
      supabaseAdmin
        .from("information_agent_cases")
        .select("id,sent_at,recipient_kind,status")
        .in("id", ids)
        .order("id", { ascending: true })
        .limit(AUTO_PUBLICATION_MAX_ROWS),
    ),
    readInChunks("sales", saleIds, (ids) =>
      supabaseAdmin
        .from("auction_sales")
        .select(
          "id,property_type,surface_m2,app_surface_m2,habitable_surface_m2,carrez_surface_m2,land_surface_m2,rooms_count",
        )
        .in("id", ids)
        .order("id", { ascending: true })
        .limit(AUTO_PUBLICATION_MAX_ROWS),
    ),
    // Toutes les valeurs proposées pour les champs éligibles de ces ventes (tout statut, toute provenance).
    readInChunks("related_candidates", saleIds, (ids) =>
      supabaseAdmin
        .from("information_agent_fact_candidates")
        .select("id,message_id,sale_id,fact_key,status,proposed_value")
        .in("sale_id", ids)
        .in("fact_key", eligible)
        .order("id", { ascending: true })
        .limit(AUTO_PUBLICATION_MAX_ROWS),
    ),
    assetIds.length
      ? readInChunks("assets", assetIds, (ids) =>
          supabaseAdmin
            .from("information_agent_evidence_assets")
            .select("id,metadata")
            .in("id", ids)
            .order("id", { ascending: true })
            .limit(AUTO_PUBLICATION_MAX_ROWS),
        )
      : Promise.resolve([]),
  ]);

  const messageById = new Map((messages ?? []).map((row) => [row.id, row]));
  const caseById = new Map((cases ?? []).map((row) => [row.id, row]));
  const saleById = new Map((sales ?? []).map((row) => [row.id, row]));
  const assetById = new Map((assets ?? []).map((row) => [row.id, row]));
  return plan.map((row) => {
    const message = messageById.get(row.message_id);
    const informationCase = caseById.get(row.case_id);
    const sale = saleById.get(row.sale_id);
    const asset = row.evidence_asset_id ? assetById.get(row.evidence_asset_id) : undefined;
    const assetMetadata =
      asset?.metadata && typeof asset.metadata === "object" && !Array.isArray(asset.metadata)
        ? (asset.metadata as Record<string, unknown>)
        : null;
    const ownTime = message ? receivedTime(message) : Number.NaN;
    const laterMessages =
      messages && message && Number.isFinite(ownTime)
        ? messages.filter(
            (other) =>
              other.case_id === row.case_id &&
              other.id !== message.id &&
              !(receivedTime(other) <= ownTime),
          )
        : null;
    return {
      factId: row.id,
      caseId: row.case_id,
      saleId: row.sale_id,
      factKey: row.fact_key,
      input: {
        candidate: {
          factKey: row.fact_key,
          status: row.status,
          evidenceAssetId: row.evidence_asset_id,
          evidenceKind: row.evidence_asset_id
            ? assetMetadata
              ? assetMetadata.evidence_kind === "email_body"
                ? "email_body"
                : "attachment"
              : null
            : undefined,
          reviewedBy: row.reviewed_by,
          proposedValue: row.proposed_value,
          metadata: row.metadata,
        },
        message: message
          ? {
              direction: message.direction,
              receivedAt: message.received_at,
              subject: message.subject,
              bodyText: message.body_text,
              metadata: message.metadata,
            }
          : null,
        informationCase: informationCase
          ? {
              sentAt: informationCase.sent_at,
              recipientKind: informationCase.recipient_kind,
              status: informationCase.status,
            }
          : null,
        sale: sale
          ? {
              propertyType: sale.property_type,
              surfaceM2: sale.surface_m2,
              appSurfaceM2: sale.app_surface_m2,
              habitableSurfaceM2: sale.habitable_surface_m2,
              carrezSurfaceM2: sale.carrez_surface_m2,
              landSurfaceM2: sale.land_surface_m2,
              roomsCount: sale.rooms_count,
            }
          : null,
        laterMessages: laterMessages
          ? laterMessages.map((later) => ({
              subject: later.subject,
              bodyText: later.body_text,
              metadata: later.metadata,
            }))
          : null,
        otherCandidatesForKey: related
          ? related.filter(
              (other) =>
                other.message_id === row.message_id &&
                other.fact_key === row.fact_key &&
                other.id !== row.id,
            ).length
          : null,
        otherValuesForSale: related
          ? related.filter(
              (other) =>
                other.sale_id === row.sale_id &&
                other.fact_key === row.fact_key &&
                other.id !== row.id &&
                other.message_id !== row.message_id &&
                other.status === "pending" &&
                !sameValue(other.proposed_value, row.proposed_value),
            ).length
          : null,
        // Calculé par le plan à partir des compteurs.
        fieldFilledInSimulation: false,
        readFailed: !messages || !cases || !sales || !related || !assets,
      },
    };
  });
}

function sameDecision(
  latest: AutoPublicationDecisionRow | undefined,
  outcome: string,
  reasons: readonly string[],
): boolean {
  return (
    latest !== undefined &&
    latest.outcome === outcome &&
    latest.policyVersion === AUTO_PUBLICATION_POLICY_VERSION &&
    latest.reasons.length === reasons.length &&
    latest.reasons.every((reason, index) => reason === reasons[index])
  );
}

/**
 * Passe de simulation : en mode « simulation » seulement, décide pour chaque fait en attente d'un champ de
 * la liste fermée reçu depuis 45 jours, et inscrit la décision au journal quand elle change. Hors
 * simulation : rien n'est lu ni calculé. Une lecture de contexte qui échoue ou atteint le plafond de lignes
 * donne « relecture » (motif `input_unreadable`) et est signalée ; la lecture du mode ou de la liste des
 * faits qui échoue lève une erreur ; une table absente (migration pas encore appliquée) rend
 * `not_installed`.
 */
export async function runAutoPublicationSimulation({
  now = new Date(),
  timeBudgetMs = PASS_TIME_BUDGET_MS,
  clock = () => Date.now(),
}: {
  now?: Date;
  timeBudgetMs?: number;
  clock?: () => number;
} = {}): Promise<AutoPublicationSimulationResult> {
  const started = clock();
  let mode: AutoPublicationMode;
  try {
    mode = await loadAutoPublicationMode();
  } catch (error) {
    if (error instanceof AutoPublicationNotInstalledError) return { status: "not_installed" };
    throw error;
  }
  if (mode !== "simulation") return { status: "inactive", mode };

  const { rows: candidates, truncated } = await loadOpenCandidates(now);
  const latest = candidates.length
    ? await readLatestDecisions(candidates.map((row) => row.id))
    : new Map<string, AutoPublicationDecisionRow>();
  const todayStart = startOfParisDay(now).getTime();
  const frozen = new Set(
    [...(latest ?? [])]
      .filter(([, decision]) => {
        const at = Date.parse(decision.decidedAt);
        return decision.outcome === "would_publish" && Number.isFinite(at) && at < todayStart;
      })
      .map(([factId]) => factId),
  );
  const plan = candidates.filter((row) => !frozen.has(row.id));
  const items = plan.length ? await buildPlanItems(plan) : [];
  // Sans les dernières décisions, ni les faits figés ni les plafonds ne sont sûrs : tout en relecture.
  const counters = plan.length && latest ? await loadCounters(now, plan) : null;

  const result = {
    status: "done" as const,
    examined: candidates.length,
    frozen: frozen.size,
    recorded: 0,
    unchanged: 0,
    wouldPublish: 0,
    review: 0,
    unreadable: 0,
    recordFailed: 0,
    truncated,
    timedOut: false,
    stoppedOnRepeatedError: false,
  };
  let lastErrorCode: string | null = null;
  let errorStreak = 0;
  for (const { item, decision } of planAutoPublicationDecisions(items, counters)) {
    if (decision.outcome === "would_publish") result.wouldPublish += 1;
    else result.review += 1;
    if ((decision.reasons as readonly string[]).includes("input_unreadable")) {
      result.unreadable += 1;
    }
    if (sameDecision(latest?.get(item.factId), decision.outcome, decision.reasons)) {
      result.unchanged += 1;
      continue;
    }
    if (clock() - started > timeBudgetMs) {
      result.timedOut = true;
      break;
    }
    const { data, error } = await supabaseAdmin.rpc(
      "record_information_agent_auto_publication_decision",
      {
        p_fact_id: item.factId,
        p_fact_key: item.factKey,
        p_outcome: decision.outcome,
        p_reasons: decision.reasons,
        p_policy_version: AUTO_PUBLICATION_POLICY_VERSION,
      },
    );
    if (error) {
      logFailure("record", error);
      result.recordFailed += 1;
      const code = errorCode(error);
      errorStreak = code === lastErrorCode ? errorStreak + 1 : 1;
      lastErrorCode = code;
      if (errorStreak >= MAX_SAME_ERROR_STREAK) {
        result.stoppedOnRepeatedError = true;
        break;
      }
      continue;
    }
    errorStreak = 0;
    lastErrorCode = null;
    if (data === true) result.recorded += 1;
  }
  if (result.unreadable > 0) logFailure("unreadable_inputs", { code: String(result.unreadable) });
  return result;
}

/**
 * Passe de simulation pour le cron : ne lève pas, mais rend « failed » (avec le seul code d'erreur, signalé
 * dans le journal serveur) pour que l'appelant fasse échouer le cron après la passe des réponses.
 */
export async function runAutoPublicationSimulationForCron(): Promise<AutoPublicationSimulationResult> {
  try {
    return await runAutoPublicationSimulation();
  } catch (error) {
    logFailure("pass", error);
    return { status: "failed", code: errorCode(error) };
  }
}

/**
 * Dernière décision de chaque fait demandé (journal), par identifiant de fait. Une lecture en échec ou
 * tronquée lève une erreur : l'écran affiche « simulation indisponible », jamais « pas encore calculée » à
 * tort.
 */
export async function loadLatestAutoPublicationDecisions(
  factIds: string[],
): Promise<Map<string, AutoPublicationDecisionRow>> {
  if (!factIds.length) return new Map();
  const latest = await readLatestDecisions(factIds);
  if (!latest) throw new Error("Journal des décisions illisible ou tronqué.");
  return latest;
}
