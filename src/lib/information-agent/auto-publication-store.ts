import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  AUTO_PUBLICATION_MODES,
  AUTO_PUBLICATION_POLICY_VERSION,
  planAutoPublicationDecisions,
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

export type AutoPublicationDecisionRow = {
  outcome: "would_publish" | "review";
  reasons: string[];
  decidedAt: string;
  policyVersion: string;
};

export type AutoPublicationSimulationResult =
  | { status: "inactive"; mode: AutoPublicationMode }
  | {
      status: "done";
      examined: number;
      recorded: number;
      wouldPublish: number;
      review: number;
      /** Faits décidés « relecture » parce qu'une lecture a échoué (signalés dans le journal serveur). */
      unreadable: number;
      /** Décisions que la RPC n'a pas pu écrire. */
      recordFailed: number;
      /** Plus de faits ouverts que la passe n'en examine : les plus récents attendent la suivante. */
      truncated: boolean;
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

/** Mode courant. Ligne absente ou valeur inconnue : erreur (l'appelant ne décide alors rien). */
export async function loadAutoPublicationMode(): Promise<AutoPublicationMode> {
  const { data, error } = await supabaseAdmin
    .from("information_agent_auto_publication_settings")
    .select("mode")
    .eq("singleton", true)
    .maybeSingle();
  if (error) throw error;
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

/** Lit par paquets ; une erreur rend `null` (les faits concernés passeront en relecture). */
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
      .in("status", ["pending", "conflict"])
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

/** Décisions « would_publish » déjà au journal, pour les plafonds et les champs remplis en simulation. */
async function loadCounters(
  now: Date,
  batch: CandidateRow[],
): Promise<AutoPublicationCounters | null> {
  const batchFacts = new Set(batch.map((row) => row.id));
  const { data: todayRows, error: todayError } = await supabaseAdmin
    .from("information_agent_auto_publication_decisions")
    .select("fact_id")
    .eq("outcome", "would_publish")
    .gte("decided_at", startOfParisDay(now).toISOString())
    .limit(1000);
  if (todayError) {
    logFailure("counters_today", todayError);
    return null;
  }
  const caseRows = await readInChunks(
    "counters_case",
    batch.map((row) => row.case_id),
    (ids) =>
      supabaseAdmin
        .from("information_agent_auto_publication_decisions")
        .select("fact_id,case_id")
        .eq("outcome", "would_publish")
        .in("case_id", ids)
        .limit(1000),
  );
  const saleRows = await readInChunks(
    "counters_sale",
    batch.map((row) => row.sale_id),
    (ids) =>
      supabaseAdmin
        .from("information_agent_auto_publication_decisions")
        .select("fact_id,sale_id,fact_key")
        .eq("outcome", "would_publish")
        .in("sale_id", ids)
        .limit(1000),
  );
  if (!caseRows || !saleRows) return null;
  const today = new Set(
    (todayRows ?? []).map((row) => row.fact_id).filter((id) => !batchFacts.has(id)),
  ).size;
  const factsByCase = new Map<string, Set<string>>();
  for (const row of caseRows) {
    if (batchFacts.has(row.fact_id)) continue;
    factsByCase.set(row.case_id, (factsByCase.get(row.case_id) ?? new Set()).add(row.fact_id));
  }
  return {
    today,
    byCase: new Map([...factsByCase].map(([caseId, facts]) => [caseId, facts.size])),
    filled: new Set(
      saleRows
        .filter((row) => !batchFacts.has(row.fact_id))
        .map((row) => `${row.sale_id}:${row.fact_key}`),
    ),
  };
}

/**
 * Passe de simulation : en mode « simulation » seulement, décide pour chaque fait ouvert (en attente ou en
 * conflit, reçu depuis 45 jours) et inscrit la décision au journal quand elle change. Hors simulation : rien
 * n'est lu ni calculé. Une lecture de contexte qui échoue donne « relecture » (motif `input_unreadable`) et
 * est signalée ; la lecture du mode ou de la liste des faits qui échoue lève une erreur.
 */
export async function runAutoPublicationSimulation({
  now = new Date(),
}: { now?: Date } = {}): Promise<AutoPublicationSimulationResult> {
  const mode = await loadAutoPublicationMode();
  if (mode !== "simulation") return { status: "inactive", mode };

  const { rows: candidates, truncated } = await loadOpenCandidates(now);
  const messageIds = candidates.map((row) => row.message_id);
  const [messages, cases, sales, siblings, counters] = await Promise.all([
    readInChunks("messages", messageIds, (ids) =>
      supabaseAdmin
        .from("information_agent_messages")
        .select("id,direction,received_at,subject,body_text,metadata")
        .in("id", ids),
    ),
    readInChunks(
      "cases",
      candidates.map((row) => row.case_id),
      (ids) =>
        supabaseAdmin
          .from("information_agent_cases")
          .select("id,sent_at,recipient_kind")
          .in("id", ids),
    ),
    readInChunks(
      "sales",
      candidates.map((row) => row.sale_id),
      (ids) =>
        supabaseAdmin
          .from("auction_sales")
          .select("id,property_type,surface_m2,app_surface_m2,land_surface_m2,rooms_count")
          .in("id", ids),
    ),
    readInChunks("siblings", messageIds, (ids) =>
      supabaseAdmin
        .from("information_agent_fact_candidates")
        .select("id,message_id,fact_key")
        .in("message_id", ids)
        .limit(5000),
    ),
    candidates.length ? loadCounters(now, candidates) : Promise.resolve(null),
  ]);

  const messageById = new Map((messages ?? []).map((row) => [row.id, row]));
  const caseById = new Map((cases ?? []).map((row) => [row.id, row]));
  const saleById = new Map((sales ?? []).map((row) => [row.id, row]));
  const items: AutoPublicationPlanItem[] = candidates.map((row) => {
    const message = messageById.get(row.message_id);
    const informationCase = caseById.get(row.case_id);
    const sale = saleById.get(row.sale_id);
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
          ? { sentAt: informationCase.sent_at, recipientKind: informationCase.recipient_kind }
          : null,
        sale: sale
          ? {
              propertyType: sale.property_type,
              surfaceM2: sale.surface_m2,
              appSurfaceM2: sale.app_surface_m2,
              landSurfaceM2: sale.land_surface_m2,
              roomsCount: sale.rooms_count,
            }
          : null,
        otherCandidatesForKey: siblings
          ? siblings.filter(
              (other) =>
                other.message_id === row.message_id &&
                other.fact_key === row.fact_key &&
                other.id !== row.id,
            ).length
          : null,
        // Calculé par le plan à partir des compteurs (null : journal illisible).
        fieldFilledInSimulation: counters ? false : null,
        readFailed: !messages || !cases || !sales || !siblings,
      },
    };
  });

  const result = {
    status: "done" as const,
    examined: items.length,
    recorded: 0,
    wouldPublish: 0,
    review: 0,
    unreadable: 0,
    recordFailed: 0,
    truncated,
  };
  for (const { item, decision } of planAutoPublicationDecisions(items, counters)) {
    if (decision.outcome === "would_publish") result.wouldPublish += 1;
    else result.review += 1;
    if ((decision.reasons as readonly string[]).includes("input_unreadable")) {
      result.unreadable += 1;
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
    } else if (data === true) {
      result.recorded += 1;
    }
  }
  if (result.unreadable > 0) logFailure("unreadable_inputs", { code: String(result.unreadable) });
  return result;
}

/** Dernière décision de chaque fait demandé (journal), par identifiant de fait. */
export async function loadLatestAutoPublicationDecisions(
  factIds: string[],
): Promise<Map<string, AutoPublicationDecisionRow>> {
  const rows = await readInChunks("latest_decisions", factIds, (ids) =>
    supabaseAdmin
      .from("information_agent_auto_publication_decisions")
      .select("fact_id,outcome,reasons,decided_at,policy_version")
      .in("fact_id", ids)
      .order("decided_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(5000),
  );
  if (!rows) throw new Error("Journal des décisions illisible.");
  const latest = new Map<string, AutoPublicationDecisionRow>();
  for (const row of rows) {
    if (latest.has(row.fact_id)) continue;
    if (row.outcome !== "would_publish" && row.outcome !== "review") {
      throw new Error("Décision illisible dans le journal.");
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
