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
import { z } from "zod";
import { startOfParisDay } from "@/lib/paris-time";
import { chunks } from "@/lib/chunks";

/**
 * Accès en base du moteur « publier ou relire » (migrations 20261115100000 et 20261211100000) : lecture du mode,
 * passe du moteur (lecture des faits, de leur contexte et du verdict de Haiku, décision, journal) et lecture des
 * dernières décisions. En simulation, le journal est la seule écriture. En mode automatique, une décision
 * « publier » appelle `publish_information_agent_fact_auto` : SEUL appelant de la seule RPC qui publie avec
 * l'auteur 'auto' (invariant information-agent-single-automatic-publication-path). La RPC relit le mode sous
 * verrou (arrêt d'urgence), redit les contrôles de sécurité et tient les plafonds en base.
 */

/** Fenêtre des faits examinés : au-delà, la réponse est hors du délai de 30 jours de toute façon. */
const CANDIDATE_WINDOW_DAYS = 45;
/** Taille d'une page de lecture (liste `in` de PostgREST) et nombre maximal de faits par passe. */
const PAGE_SIZE = 100;
const MAX_CANDIDATES_PER_PASS = 500;
/**
 * Lignes demandées par lecture. Le plafond réel du serveur (`max-rows` de PostgREST) n'est pas connu : chaque
 * lecture demande le total exact (`count: "exact"`) et une lecture dont le total dépasse les lignes reçues
 * est tronquée, donc traitée comme illisible, jamais comme complète.
 */
const AUTO_PUBLICATION_REQUEST_ROWS = 1000;
/** Temps maximal d'écriture des décisions dans une passe (le cron des réponses dure au plus 300 s). */
const PASS_TIME_BUDGET_MS = 60_000;
/** La boucle d'écriture s'arrête après ce nombre d'échecs consécutifs du même code. */
const MAX_SAME_ERROR_STREAK = 3;

/** Échec d'une lecture d'état global : la passe s'arrête sans rien écrire (code seul, sans détail). */
export class AutoPublicationPassError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Passe de simulation arrêtée sans écriture : ${code}.`);
    this.code = code;
  }
}

export type AutoPublicationDecisionRow = {
  outcome: "would_publish" | "published" | "review";
  reasons: string[];
  decidedAt: string;
  policyVersion: string;
};

export type AutoPublicationPassResult =
  | { status: "inactive"; mode: AutoPublicationMode }
  | {
      /**
       * `time_limit_reached` : la limite de temps a arrêté l'écriture (visible, pas un échec). `stopped` : le mode
       * a changé pendant la passe (arrêt d'urgence) ; la RPC de publication n'a plus rien publié.
       */
      status: "done" | "time_limit_reached" | "stopped";
      mode: "simulation" | "auto";
      /** Faits ouverts lus (en attente, champ de la liste fermée). */
      examined: number;
      /** Faits déjà « publiés » en simulation un jour antérieur : sortis du lot. */
      frozen: number;
      recorded: number;
      /** Décision identique à la dernière du journal : aucun appel. */
      unchanged: number;
      wouldPublish: number;
      /** Mode automatique : faits publiés par la RPC dans cette passe. */
      published: number;
      review: number;
      /** Mode automatique : publication remise à la passe suivante (vente occupée par un import, conflit). */
      deferred: number;
      /** Mode automatique : publication en échec, laissée en relecture humaine (motif `publication_failed`). */
      publishFailed: number;
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
    throw new Error("Auto-publication setting missing or unreadable");
  }
  return mode as AutoPublicationMode;
}

/**
 * Lit par paquets d'identifiants. Une erreur, ou un paquet qui atteint le plafond de lignes (lecture
 * peut-être tronquée), rend `null` et est signalé : les faits concernés passeront en relecture.
 */
async function readInChunks<T>(
  stage: string,
  ids: string[],
  read: (ids: string[]) => PromiseLike<{ data: T[] | null; error: unknown; count?: number | null }>,
): Promise<T[] | null> {
  const rows: T[] = [];
  for (const part of chunks([...new Set(ids)])) {
    const { data, error, count } = await read(part);
    if (error) {
      logFailure(stage, error);
      return null;
    }
    if (isTruncated(data, count)) {
      logFailure(stage, { code: "truncated" });
      return null;
    }
    rows.push(...(data ?? []));
  }
  return rows;
}

/** Lecture tronquée : total inconnu, ou total supérieur aux lignes reçues. */
function isTruncated(data: unknown[] | null, count: number | null | undefined): boolean {
  return typeof count !== "number" || count > (data ?? []).length;
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
  let total = 0;
  while (rows.length < MAX_CANDIDATES_PER_PASS) {
    // La page suivante part de ce qui est déjà lu : un serveur qui rend moins que demandé ne fait rien sauter.
    const offset = rows.length;
    const { data, error, count } = await supabaseAdmin
      .from("information_agent_fact_candidates")
      .select(
        "id,case_id,message_id,sale_id,fact_key,status,evidence_asset_id,reviewed_by,proposed_value,metadata",
        { count: "exact" },
      )
      .eq("status", "pending")
      .in("fact_key", [...AUTO_PUBLICATION_ELIGIBLE_FIELDS])
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    if (typeof count !== "number") {
      throw Object.assign(new Error("Open facts total missing"), { code: "count_missing" });
    }
    total = count;
    rows.push(...((data ?? []) as CandidateRow[]));
    // Fin de liste : tout le total est lu (une page plus courte que demandé ne suffit pas à le dire).
    if (rows.length >= total || !(data ?? []).length) break;
  }
  return { rows, truncated: rows.length < total };
}

/** Dernière décision de chaque fait demandé, ou `null` si la lecture a échoué ou a été tronquée. */
async function readLatestDecisions(
  factIds: string[],
): Promise<Map<string, AutoPublicationDecisionRow> | null> {
  const rows = await readInChunks("latest_decisions", factIds, (ids) =>
    supabaseAdmin
      .from("information_agent_auto_publication_decisions")
      .select("id,fact_id,outcome,reasons,decided_at,policy_version", { count: "exact" })
      .in("fact_id", ids)
      .order("decided_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(AUTO_PUBLICATION_REQUEST_ROWS),
  );
  if (!rows) return null;
  const latest = new Map<string, AutoPublicationDecisionRow>();
  for (const row of rows) {
    if (latest.has(row.fact_id)) continue;
    if (
      row.outcome !== "would_publish" &&
      row.outcome !== "published" &&
      row.outcome !== "review"
    ) {
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
  outcome: "would_publish" | "published",
): Promise<AutoPublicationCounters | null> {
  const inPlan = new Set(plan.map((row) => row.id));
  const {
    data: todayRows,
    error: todayError,
    count: todayCount,
  } = await supabaseAdmin
    .from("information_agent_auto_publication_decisions")
    .select("id,fact_id", { count: "exact" })
    .eq("outcome", outcome)
    .gte("decided_at", startOfParisDay(now).toISOString())
    .order("decided_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(AUTO_PUBLICATION_REQUEST_ROWS);
  if (todayError) {
    logFailure("counters_today", todayError);
    return null;
  }
  if (isTruncated(todayRows, todayCount)) {
    logFailure("counters_today", { code: "truncated" });
    return null;
  }
  const caseRows = await readInChunks(
    "counters_case",
    plan.map((row) => row.case_id),
    (ids) =>
      supabaseAdmin
        .from("information_agent_auto_publication_decisions")
        .select("id,fact_id,case_id", { count: "exact" })
        .eq("outcome", outcome)
        .in("case_id", ids)
        .order("id", { ascending: true })
        .limit(AUTO_PUBLICATION_REQUEST_ROWS),
  );
  const saleRows = await readInChunks(
    "counters_sale",
    plan.map((row) => row.sale_id),
    (ids) =>
      supabaseAdmin
        .from("information_agent_auto_publication_decisions")
        .select("id,fact_id,sale_id,fact_key", { count: "exact" })
        .eq("outcome", outcome)
        .in("sale_id", ids)
        .order("id", { ascending: true })
        .limit(AUTO_PUBLICATION_REQUEST_ROWS),
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

/**
 * `other` est reçu après `own` : date de réception, puis date d'écriture, puis identifiant (deux messages
 * reçus à la même seconde sont départagés, jamais ignorés). Une date illisible compte comme postérieure.
 */
function receivedAfter(other: MessageRow, own: MessageRow): boolean {
  const [a, b] = [receivedTime(other), receivedTime(own)];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  if (a !== b) return a > b;
  const [c, d] = [Date.parse(other.created_at), Date.parse(own.created_at)];
  if (!Number.isFinite(c) || !Number.isFinite(d)) return true;
  if (c !== d) return c > d;
  return other.id > own.id;
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
  const factIds = plan.map((row) => row.id);
  const [messages, cases, sales, related, assets, arbitrations] = await Promise.all([
    readInChunks<MessageRow>("messages", caseIds, (ids) =>
      supabaseAdmin
        .from("information_agent_messages")
        .select("id,case_id,direction,received_at,created_at,subject,body_text,metadata", {
          count: "exact",
        })
        .in("case_id", ids)
        .eq("direction", "inbound")
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(AUTO_PUBLICATION_REQUEST_ROWS),
    ),
    readInChunks("cases", caseIds, (ids) =>
      supabaseAdmin
        .from("information_agent_cases")
        .select("id,sent_at,recipient_kind,status,metadata,normalized_recipient_email", {
          count: "exact",
        })
        .in("id", ids)
        .order("id", { ascending: true })
        .limit(AUTO_PUBLICATION_REQUEST_ROWS),
    ),
    readInChunks("sales", saleIds, (ids) =>
      supabaseAdmin
        .from("auction_sales")
        .select(
          "id,property_type,surface_m2,app_surface_m2,app_surface_kind,surface_scope,habitable_surface_m2,carrez_surface_m2,land_surface_m2,rooms_count,quality_flags,source_lot_selection:raw_payload->source_lot_selection",
          { count: "exact" },
        )
        .in("id", ids)
        .order("id", { ascending: true })
        .limit(AUTO_PUBLICATION_REQUEST_ROWS),
    ),
    // Toutes les valeurs proposées pour les champs éligibles de ces ventes (tout statut, toute provenance).
    readInChunks("related_candidates", saleIds, (ids) =>
      supabaseAdmin
        .from("information_agent_fact_candidates")
        .select("id,message_id,sale_id,fact_key,status,proposed_value", { count: "exact" })
        .in("sale_id", ids)
        .in("fact_key", eligible)
        .order("id", { ascending: true })
        .limit(AUTO_PUBLICATION_REQUEST_ROWS),
    ),
    assetIds.length
      ? readInChunks("assets", assetIds, (ids) =>
          supabaseAdmin
            .from("information_agent_evidence_assets")
            .select("id,metadata", { count: "exact" })
            .in("id", ids)
            .order("id", { ascending: true })
            .limit(AUTO_PUBLICATION_REQUEST_ROWS),
        )
      : Promise.resolve([]),
    // Verdicts de Haiku, le plus récent d'abord (validés par le moteur, jamais crus sur parole).
    readInChunks("arbitrations", factIds, (ids) =>
      supabaseAdmin
        .from("information_agent_auto_publication_arbitrations")
        .select("id,fact_id,status,publish,reason_code,value,prompt_version,recorded_at", {
          count: "exact",
        })
        .in("fact_id", ids)
        .order("recorded_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(AUTO_PUBLICATION_REQUEST_ROWS),
    ),
  ]);
  // Opposition du destinataire (registre des contacts, toute portée), lue après le dossier.
  const recipients = (cases ?? []).flatMap((row) =>
    row.normalized_recipient_email ? [row.normalized_recipient_email] : [],
  );
  const opposed = cases
    ? recipients.length
      ? await readInChunks("contacts", recipients, (emails) =>
          supabaseAdmin
            .from("information_agent_contacts")
            .select("id,normalized_email", { count: "exact" })
            .in("normalized_email", emails)
            .eq("opposition_status", "opposed")
            .order("id", { ascending: true })
            .limit(AUTO_PUBLICATION_REQUEST_ROWS),
        )
      : []
    : null;
  const opposedEmails = new Set((opposed ?? []).map((row) => row.normalized_email));
  const latestArbitration = new Map<string, unknown>();
  for (const row of arbitrations ?? []) {
    if (!latestArbitration.has(row.fact_id)) latestArbitration.set(row.fact_id, row);
  }

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
    const otherMessages =
      messages && message
        ? messages
            .filter((other) => other.case_id === row.case_id && other.id !== message.id)
            .map((other) => ({
              after: receivedAfter(other, message),
              subject: other.subject,
              bodyText: other.body_text,
              metadata: other.metadata,
            }))
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
              metadata: informationCase.metadata,
            }
          : null,
        contactOpposed:
          opposed && informationCase
            ? opposedEmails.has(informationCase.normalized_recipient_email)
            : null,
        sale: sale
          ? {
              propertyType: sale.property_type,
              surfaceM2: sale.surface_m2,
              appSurfaceM2: sale.app_surface_m2,
              habitableSurfaceM2: sale.habitable_surface_m2,
              appSurfaceKind: sale.app_surface_kind,
              surfaceScope: sale.surface_scope,
              carrezSurfaceM2: sale.carrez_surface_m2,
              landSurfaceM2: sale.land_surface_m2,
              roomsCount: sale.rooms_count,
              qualityFlags: sale.quality_flags,
              sourceLotSelection: sale.source_lot_selection,
            }
          : null,
        otherMessages,
        arbitration: arbitrations
          ? latestArbitration.has(row.id)
            ? { found: true, row: latestArbitration.get(row.id) }
            : { found: false }
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
        readFailed:
          !messages || !cases || !sales || !related || !assets || !arbitrations || !opposed,
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

/** Codes d'erreur d'une publication à reprendre à la passe suivante : vente tenue par un import, conflit. */
const TRANSIENT_PUBLISH_CODES = new Set(["55P03", "40001", "40P01"]);

/** Réponse de la RPC de publication, validée : une forme inconnue est un échec de publication. */
const publishResultSchema = z.object({
  status: z.enum(["published", "review", "inactive", "missing"]),
});

/**
 * Passe du moteur : en mode « simulation » ou « automatique », décide pour chaque fait en attente d'un champ de la
 * liste fermée reçu depuis 45 jours. Simulation : la décision est inscrite au journal quand elle change.
 * Automatique : une relecture est inscrite au journal ; « publier » appelle `publish_information_agent_fact_auto`,
 * qui relit le mode sous verrou et publie (ou écrit lui-même la relecture). Une publication en échec est laissée en
 * relecture (motif `publication_failed`) et n'est plus retentée ; un verrou d'import ou un conflit la remet à la
 * passe suivante. Hors de ces deux modes, rien n'est lu ni calculé. Une lecture du contexte d'un fait qui échoue ou
 * est tronquée donne « relecture » (motif `input_unreadable`). Une lecture d'état global (mode, liste des faits,
 * dernières décisions, compteurs) qui échoue ou est tronquée arrête la passe en échec SANS RIEN ÉCRIRE.
 */
export async function runAutoPublicationPass({
  now = new Date(),
  timeBudgetMs = PASS_TIME_BUDGET_MS,
  clock = () => Date.now(),
}: {
  now?: Date;
  timeBudgetMs?: number;
  clock?: () => number;
} = {}): Promise<AutoPublicationPassResult> {
  const started = clock();
  const mode = await loadAutoPublicationMode();
  if (mode !== "simulation" && mode !== "auto") return { status: "inactive", mode };

  const { rows: candidates, truncated } = await loadOpenCandidates(now);
  const latest = candidates.length
    ? await readLatestDecisions(candidates.map((row) => row.id))
    : new Map<string, AutoPublicationDecisionRow>();
  if (!latest) throw new AutoPublicationPassError("decisions_unreadable");
  const todayStart = startOfParisDay(now).getTime();
  // Sortis du lot : en simulation, un fait « aurait été publié » un jour antérieur (il compte dans son jour) ; en
  // automatique, un fait dont la publication a échoué avec cette version (relecture humaine, jamais retenté).
  const frozen = new Set(
    [...latest]
      .filter(([, decision]) => {
        if (mode === "auto") {
          return (
            decision.outcome === "review" &&
            decision.policyVersion === AUTO_PUBLICATION_POLICY_VERSION &&
            decision.reasons.includes("publication_failed")
          );
        }
        const at = Date.parse(decision.decidedAt);
        return decision.outcome === "would_publish" && Number.isFinite(at) && at < todayStart;
      })
      .map(([factId]) => factId),
  );
  const plan = candidates.filter((row) => !frozen.has(row.id));
  // Plafonds et champs remplis : état global, lu avant le contexte des faits ; illisible, rien n'est écrit.
  const counters = plan.length
    ? await loadCounters(now, plan, mode === "auto" ? "published" : "would_publish")
    : { today: 0, byCase: new Map<string, number>(), filled: new Set<string>() };
  if (!counters) throw new AutoPublicationPassError("counters_unreadable");
  const items = plan.length ? await buildPlanItems(plan) : [];

  const result: Extract<AutoPublicationPassResult, { examined: number }> = {
    status: "done",
    mode,
    examined: candidates.length,
    frozen: frozen.size,
    recorded: 0,
    unchanged: 0,
    wouldPublish: 0,
    published: 0,
    review: 0,
    deferred: 0,
    publishFailed: 0,
    unreadable: 0,
    recordFailed: 0,
    truncated,
    timedOut: false,
    stoppedOnRepeatedError: false,
  };
  let lastErrorCode: string | null = null;
  let errorStreak = 0;
  const recordDecision = async (
    item: AutoPublicationPlanItem,
    outcome: "would_publish" | "review",
    reasons: readonly string[],
  ): Promise<boolean> => {
    const { data, error } = await supabaseAdmin.rpc(
      "record_information_agent_auto_publication_decision",
      {
        p_fact_id: item.factId,
        p_fact_key: item.factKey,
        p_outcome: outcome,
        p_reasons: [...reasons],
        p_policy_version: AUTO_PUBLICATION_POLICY_VERSION,
      },
    );
    if (error) {
      logFailure("record", error);
      result.recordFailed += 1;
      const code = errorCode(error);
      errorStreak = code === lastErrorCode ? errorStreak + 1 : 1;
      lastErrorCode = code;
      return false;
    }
    errorStreak = 0;
    lastErrorCode = null;
    if (data === true) result.recorded += 1;
    return true;
  };

  for (const { item, decision } of planAutoPublicationDecisions(items, counters)) {
    if ((decision.reasons as readonly string[]).includes("input_unreadable")) {
      result.unreadable += 1;
    }
    const publishNow = mode === "auto" && decision.outcome === "would_publish";
    if (!publishNow && sameDecision(latest.get(item.factId), decision.outcome, decision.reasons)) {
      if (decision.outcome === "would_publish") result.wouldPublish += 1;
      else result.review += 1;
      result.unchanged += 1;
      continue;
    }
    if (clock() - started > timeBudgetMs) {
      result.timedOut = true;
      result.status = "time_limit_reached";
      break;
    }
    if (!publishNow) {
      if (decision.outcome === "would_publish") result.wouldPublish += 1;
      else result.review += 1;
      await recordDecision(item, decision.outcome, decision.reasons);
    } else {
      // Mode automatique : la RPC relit le mode sous verrou, redit les contrôles, tient les plafonds et publie.
      const { data, error } = await supabaseAdmin.rpc("publish_information_agent_fact_auto", {
        p_fact_id: item.factId,
        p_fact_key: item.factKey,
        p_policy_version: AUTO_PUBLICATION_POLICY_VERSION,
      });
      const parsed = error ? null : publishResultSchema.safeParse(data);
      if (parsed?.success) {
        errorStreak = 0;
        lastErrorCode = null;
        if (parsed.data.status === "inactive") {
          // Arrêt d'urgence pendant la passe : plus rien n'est publié.
          result.status = "stopped";
          break;
        }
        if (parsed.data.status === "published") result.published += 1;
        else if (parsed.data.status === "review") result.review += 1;
        continue;
      }
      const code = error ? errorCode(error) : "invalid_result";
      logFailure("publish", { code });
      if (TRANSIENT_PUBLISH_CODES.has(code)) {
        result.deferred += 1;
        continue;
      }
      result.publishFailed += 1;
      result.review += 1;
      await recordDecision(item, "review", ["publication_failed"]);
      errorStreak = code === lastErrorCode ? errorStreak + 1 : 1;
      lastErrorCode = code;
    }
    if (errorStreak >= MAX_SAME_ERROR_STREAK) {
      result.stoppedOnRepeatedError = true;
      break;
    }
  }
  if (result.unreadable > 0) logFailure("unreadable_inputs", { code: String(result.unreadable) });
  return result;
}

/**
 * Passe du moteur pour le cron : ne lève pas, mais rend « failed » (avec le seul code d'erreur, signalé dans le
 * journal serveur) pour que l'appelant fasse échouer le cron après la passe des réponses.
 */
export async function runAutoPublicationPassForCron(): Promise<AutoPublicationPassResult> {
  try {
    return await runAutoPublicationPass();
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
  if (!latest) throw new Error("Auto-publication decision log unreadable or truncated");
  return latest;
}

/**
 * Motif du dernier verdict de Haiku de chaque fait demandé (code de la liste fermée, ou null), pour l'onglet
 * Réponses. Une lecture en échec ou tronquée lève une erreur (« indisponible » à l'écran).
 */
export async function loadLatestArbiterReasons(
  factIds: string[],
): Promise<Map<string, string | null>> {
  if (!factIds.length) return new Map();
  const rows = await readInChunks("arbiter_reasons", factIds, (ids) =>
    supabaseAdmin
      .from("information_agent_auto_publication_arbitrations")
      .select("id,fact_id,reason_code,recorded_at", { count: "exact" })
      .in("fact_id", ids)
      .order("recorded_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(AUTO_PUBLICATION_REQUEST_ROWS),
  );
  if (!rows) throw new Error("Auto-publication verdicts unreadable or truncated");
  const latest = new Map<string, string | null>();
  for (const row of rows) {
    if (!latest.has(row.fact_id)) latest.set(row.fact_id, row.reason_code);
  }
  return latest;
}
