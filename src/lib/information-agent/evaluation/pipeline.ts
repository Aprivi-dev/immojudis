import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { persistFactCandidates } from "@/lib/information-agent-inbound/attachments";
import { extractInformationAgentFacts } from "@/lib/information-agent-inbound/fact-extraction";
import { replyMentionsLot } from "@/lib/information-agent-inbound/reply-signals";
import { normalizeInboundSenderAuthentication } from "@/lib/information-agent-inbound/sender-authentication";
import { cleanInboundBody, replyTextForExtraction } from "@/lib/information-agent-inbound/text";
import type { SharedCase } from "@/lib/information-agent-inbound/types";
import { runAutoPublicationSimulation } from "@/lib/information-agent/auto-publication-store";
import {
  EVALUATION_FIELDS,
  type EvaluationCase,
  type EvaluationField,
} from "@/lib/information-agent/evaluation/dataset";
import {
  EvaluationDatabase,
  evaluationSupabase,
  useEvaluationDatabase,
  type Row,
} from "@/lib/information-agent/evaluation/fake-supabase";

/**
 * Les deux étapes TypeScript du banc, sur la VRAIE chaîne, sans réseau ni base :
 * 1. règles : corps nettoyé comme à la réception (`cleanInboundBody`, `replyTextForExtraction`), faits des
 *    règles (`extractInformationAgentFacts`), lot non nommé, puis enregistrement des candidats par
 *    `persistFactCandidates` (contrôle du lot, conflit avec la fiche, motifs) dans une base en mémoire ;
 * 2. moteur : la passe de simulation `runAutoPublicationSimulation` lit la table des candidats complétée par
 *    le worker Python (fichier de l'étape Python) et inscrit ses décisions au journal en mémoire.
 * Seul le calcul du « lot non nommé » (trois lignes de `processInboundEmail`, non exportées) est refait ici.
 */

/** Date de la passe du moteur et de réception de la réponse évaluée (fictives, fixes : banc rejouable). */
export const EVALUATION_NOW = new Date("2026-11-20T12:00:00.000Z");
const RECEIVED_AT = "2026-11-20T09:00:00.000Z";
const LATER_RECEIVED_AT = "2026-11-20T10:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;

export function evaluationIds(evaluationCase: EvaluationCase) {
  const id = evaluationCase.id;
  return {
    saleId: `${id}-sale`,
    caseId: `${id}-case`,
    messageId: `${id}-message`,
    bodyAssetId: `${id}-asset-body`,
    attachmentAssetId: (index: number) => `${id}-asset-pj-${index + 1}`,
  };
}

function assertEvaluationClient() {
  // Garde-fou : le banc n'écrit jamais ailleurs qu'en mémoire.
  if ((supabaseAdmin as unknown) !== evaluationSupabase) {
    throw new Error("Banc d'évaluation : le client Supabase doit être remplacé par la base en mémoire");
  }
}

function saleRow(evaluationCase: EvaluationCase): Row {
  const { contexte } = evaluationCase;
  return {
    id: evaluationIds(evaluationCase).saleId,
    property_type: contexte.type_de_bien,
    ...contexte.fiche,
    occupancy_status: null,
    sale_date: null,
    starting_price_eur: null,
    address: null,
    quality_flags: contexte.quality_flags,
    source_lot_selection: contexte.lot_vendu
      ? { status: "selected", ...contexte.lot_vendu }
      : null,
  };
}

/** Candidat tel que le worker Python le lit et que le moteur le décide (sans extrait ni libellé). */
export type StageCandidate = {
  id: string;
  fact_key: string;
  proposed_value: unknown;
  display_value: string | null;
  status: string;
  evidence_asset_id: string | null;
  source_page: number | null;
  metadata: unknown;
};

export type RulesStageEntry = {
  /** Texte de la pièce « corps du message » que le worker lit (null : aucune pièce créée). */
  body_evidence_text: string | null;
  lot_unidentified: boolean;
  candidates: StageCandidate[];
};

function stageCandidate(row: Row): StageCandidate {
  return {
    id: String(row.id),
    fact_key: String(row.fact_key),
    proposed_value: row.proposed_value ?? null,
    display_value: typeof row.display_value === "string" ? row.display_value : null,
    status: String(row.status),
    evidence_asset_id: typeof row.evidence_asset_id === "string" ? row.evidence_asset_id : null,
    source_page: typeof row.source_page === "number" ? row.source_page : null,
    metadata: row.metadata ?? null,
  };
}

/** Étape 1 : traitement d'une réponse par les règles TypeScript, comme `processInboundEmail`. */
export async function runRulesStage(evaluationCase: EvaluationCase): Promise<RulesStageEntry> {
  assertEvaluationClient();
  const ids = evaluationIds(evaluationCase);
  const database = useEvaluationDatabase(new EvaluationDatabase(evaluationCase.id));
  database.rows("auction_sales").push(saleRow(evaluationCase));

  const bodyText = cleanInboundBody(evaluationCase.message.corps, null);
  const replyText = replyTextForExtraction(bodyText);
  const facts = extractInformationAgentFacts(replyText);
  const assets = evaluationCase.message.pieces_jointes.map((attachment, index) => ({
    id: ids.attachmentAssetId(index),
    filename: attachment.nom,
    mimeType: "text/plain",
    storagePath: `${ids.caseId}/${ids.messageId}/${attachment.nom}`,
    size: new TextEncoder().encode(attachment.texte).length,
  }));
  // Comme `processInboundEmail` : vente à plusieurs lots et réponse sans numéro de lot.
  const lotUnidentified =
    facts.length + assets.length > 0 &&
    !replyMentionsLot(replyText) &&
    evaluationCase.contexte.quality_flags.includes("multi_lot_sale");
  await persistFactCandidates({
    sharedCase: { id: ids.caseId, sale_id: ids.saleId } as SharedCase,
    messageId: ids.messageId,
    facts,
    assets,
    lotUnidentified,
  });
  // Comme `persistInboundBodyEvidence` : le corps relu par le worker.
  const bodyForEvidence = replyTextForExtraction(bodyText).trim();
  return {
    body_evidence_text:
      bodyForEvidence && bodyForEvidence !== "Réponse reçue sans corps de texte." ? bodyForEvidence : null,
    lot_unidentified: lotUnidentified,
    candidates: database.rows("information_agent_fact_candidates").map(stageCandidate),
  };
}

/**
 * État du dossier et du message évalué vu par le moteur :
 * - `hypothese` : dossier « replied », traitement « completed » sans motif, l'état que le moteur exige ;
 * - `etat_reel` : l'état que la chaîne écrit vraiment après une réponse qui a un corps de texte (dossier
 *   « review », traitement « review », motif `candidate_or_attachment_review`).
 */
export type EngineVariant = "hypothese" | "etat_reel";

export type FieldDecision = { value: number | null; outcome: "would_publish" | "review"; reasons: string[] };
export type EngineStageEntry = Record<EvaluationField, FieldDecision[]>;

function messageMetadata(evaluationCase: EvaluationCase, processing: Row): Row {
  const { contexte } = evaluationCase;
  return {
    imported_manually: false,
    content_trust: "untrusted",
    sender_matches_recipient: contexte.expediteur_est_destinataire,
    sender_authentication: normalizeInboundSenderAuthentication({
      spf: "pass",
      dkim: contexte.authentification.dkim === "none" ? null : contexte.authentification.dkim,
      dmarc: contexte.authentification.dmarc === "none" ? null : contexte.authentification.dmarc,
    }),
    inbound_processing: processing,
  };
}

const REVIEW_PROCESSING = { status: "review", reason: "candidate_or_attachment_review" };

/** Étape 3 : passe de simulation du moteur sur la table des candidats complétée par le worker. */
export async function runEngineStage(
  evaluationCase: EvaluationCase,
  candidates: StageCandidate[],
  variant: EngineVariant,
): Promise<EngineStageEntry> {
  assertEvaluationClient();
  const ids = evaluationIds(evaluationCase);
  const { contexte, message } = evaluationCase;
  const database = useEvaluationDatabase(new EvaluationDatabase(`${evaluationCase.id}-engine`));
  database.rows("information_agent_auto_publication_settings").push({ singleton: true, mode: "simulation" });
  database.rows("auction_sales").push(saleRow(evaluationCase));
  database.rows("information_agent_cases").push({
    id: ids.caseId,
    sent_at: new Date(Date.parse(RECEIVED_AT) - contexte.delai_jours * DAY_MS).toISOString(),
    recipient_kind: contexte.destinataire,
    status: variant === "hypothese" ? "replied" : "review",
  });
  database.rows("information_agent_messages").push({
    id: ids.messageId,
    case_id: ids.caseId,
    direction: "inbound",
    received_at: RECEIVED_AT,
    created_at: RECEIVED_AT,
    subject: message.objet,
    body_text: cleanInboundBody(message.corps, null),
    metadata: messageMetadata(
      evaluationCase,
      variant === "hypothese" ? { status: "completed" } : REVIEW_PROCESSING,
    ),
  });
  contexte.messages_posterieurs.forEach((later, index) => {
    // Un message postérieur qui a un corps est en relecture dans la vraie chaîne, quelle que soit la variante.
    database.rows("information_agent_messages").push({
      id: `${ids.messageId}-later-${index + 1}`,
      case_id: ids.caseId,
      direction: "inbound",
      received_at: LATER_RECEIVED_AT,
      created_at: LATER_RECEIVED_AT,
      subject: later.objet,
      body_text: cleanInboundBody(later.corps, null),
      metadata: messageMetadata(evaluationCase, REVIEW_PROCESSING),
    });
  });
  database.rows("information_agent_evidence_assets").push(
    { id: ids.bodyAssetId, metadata: { evidence_kind: "email_body" } },
    ...message.pieces_jointes.map((_, index) => ({
      id: ids.attachmentAssetId(index),
      metadata: { content_trust: "untrusted_external_evidence" },
    })),
  );
  for (const candidate of candidates) {
    database.rows("information_agent_fact_candidates").push({
      ...candidate,
      case_id: ids.caseId,
      message_id: ids.messageId,
      sale_id: ids.saleId,
      reviewed_by: null,
      created_at: RECEIVED_AT,
    });
  }

  const result = await runAutoPublicationSimulation({ now: EVALUATION_NOW });
  if (result.status !== "done" || result.unreadable || result.recordFailed) {
    throw new Error(`Banc d'évaluation : passe du moteur anormale pour ${evaluationCase.id}`);
  }
  const decisions = new Map(
    database
      .rows("information_agent_auto_publication_decisions")
      .map((row) => [String(row.fact_id), row] as const),
  );
  const entry = Object.fromEntries(EVALUATION_FIELDS.map((field) => [field, []])) as unknown as EngineStageEntry;
  for (const candidate of candidates) {
    if (!(EVALUATION_FIELDS as readonly string[]).includes(candidate.fact_key)) continue;
    const decision = decisions.get(candidate.id);
    const raw = (candidate.proposed_value as { value?: unknown } | null)?.value;
    const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : null;
    entry[candidate.fact_key as EvaluationField].push(
      decision
        ? {
            value: Number.isFinite(value) ? value : null,
            outcome: decision.outcome === "would_publish" ? "would_publish" : "review",
            reasons: (decision.reasons as string[]) ?? [],
          }
        : // Candidat non examiné par la passe (en conflit avec la fiche) : relecture.
          { value: Number.isFinite(value) ? value : null, outcome: "review", reasons: [candidate.status] },
    );
  }
  return entry;
}
