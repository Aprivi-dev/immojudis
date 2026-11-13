import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { persistFactCandidates } from "@/lib/information-agent-inbound/attachments";
import { extractInformationAgentFacts } from "@/lib/information-agent-inbound/fact-extraction";
import { detectPossiblePromptInjection } from "@/lib/information-agent-inbound/prompt-injection";
import {
  detectInformationAgentContactOptOut,
  detectPossibleInformationAgentContactOptOut,
  detectWrongRecipientSignal,
} from "@/lib/information-agent-inbound/reply-intent";
import { isAutomaticReply, replyMentionsLot } from "@/lib/information-agent-inbound/reply-signals";
import {
  inboundReviewReason,
  normalizeInboundSenderAuthentication,
} from "@/lib/information-agent-inbound/sender-authentication";
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
  activateEvaluationDatabase,
  type Row,
} from "@/lib/information-agent/evaluation/fake-supabase";

/**
 * Les deux étapes TypeScript du banc, sur la VRAIE chaîne, sans réseau ni base, pour CHAQUE message entrant
 * du dossier (messages antérieurs, message évalué, messages postérieurs) :
 * 1. réception et règles : relecture décidée à la réception (expéditeur, authentification, opposition
 *    possible, mauvais destinataire, consigne adressée à un modèle), opposition, réponse automatique, puis
 *    faits des règles (`extractInformationAgentFacts`), lot non nommé et enregistrement des candidats par
 *    `persistFactCandidates` dans une base en mémoire ;
 * 2. moteur : la passe de simulation `runAutoPublicationSimulation` lit la table des candidats complétée par
 *    le worker Python et inscrit ses décisions au journal en mémoire.
 * Sont refaits ici, faute d'export : l'ordre des décisions de la réception et le choix de son motif
 * (`processInboundEmail`, mêmes fonctions appelées), le « lot non nommé » (trois lignes) et l'état écrit
 * après traitement (dossier et message en relecture dès qu'une pièce « corps » existe).
 */

/** Date de la passe du moteur et de réception de la réponse évaluée (fictives, fixes : banc rejouable). */
const EVALUATION_NOW = new Date("2026-11-20T12:00:00.000Z");
const RECEIVED_AT = Date.parse("2026-11-20T09:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type CaseMessage = {
  /** `corps` (message évalué), `anterieur-N` ou `posterieur-N`. */
  role: string;
  messageId: string;
  subject: string;
  /** Corps tel que la réception le garde (`cleanInboundBody`). */
  bodyText: string;
  receivedAt: string;
  attachments: EvaluationCase["message"]["pieces_jointes"];
};

function evaluationIds(evaluationCase: EvaluationCase) {
  const id = evaluationCase.id;
  return {
    saleId: `${id}-sale`,
    caseId: `${id}-case`,
    messageId: (role: string) => (role === "corps" ? `${id}-message` : `${id}-message-${role}`),
    bodyAssetId: (role: string) => (role === "corps" ? `${id}-asset-body` : `${id}-asset-${role}`),
    attachmentAssetId: (index: number) => `${id}-asset-pj-${index + 1}`,
  };
}

/** Messages entrants du dossier, dans l'ordre de réception. */
function caseMessages(evaluationCase: EvaluationCase): CaseMessage[] {
  const ids = evaluationIds(evaluationCase);
  const { contexte, message } = evaluationCase;
  const neighbour = (
    role: string,
    offsetHours: number,
    item: { objet: string; corps: string },
  ) => ({
    role,
    messageId: ids.messageId(role),
    subject: item.objet,
    bodyText: cleanInboundBody(item.corps, null),
    receivedAt: new Date(RECEIVED_AT + offsetHours * HOUR_MS).toISOString(),
    attachments: [],
  });
  return [
    ...contexte.messages_anterieurs.map((item, index) =>
      neighbour(`anterieur-${index + 1}`, index - contexte.messages_anterieurs.length, item),
    ),
    {
      role: "corps",
      messageId: ids.messageId("corps"),
      subject: message.objet,
      bodyText: cleanInboundBody(message.corps, null),
      receivedAt: new Date(RECEIVED_AT).toISOString(),
      attachments: message.pieces_jointes,
    },
    ...contexte.messages_posterieurs.map((item, index) =>
      neighbour(`posterieur-${index + 1}`, index + 1, item),
    ),
  ];
}

function assertEvaluationClient() {
  // Garde-fou : le banc n'écrit jamais ailleurs qu'en mémoire.
  if ((supabaseAdmin as unknown) !== evaluationSupabase) {
    throw new Error(
      "Banc d'évaluation : le client Supabase doit être remplacé par la base en mémoire",
    );
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
    source_lot_selection: contexte.lot_vendu ? { status: "selected", ...contexte.lot_vendu } : null,
  };
}

function senderAuthentication(evaluationCase: EvaluationCase) {
  const { authentification } = evaluationCase.contexte;
  return normalizeInboundSenderAuthentication({
    spf: "pass",
    dkim: authentification.dkim === "none" ? null : authentification.dkim,
    dmarc: authentification.dmarc === "none" ? null : authentification.dmarc,
  });
}

/** Ce que la réception décide avant toute extraction (même ordre que `processInboundEmail`). */
type Reception =
  | { statut: "extraction"; motif: null }
  | { statut: "reponse_automatique"; motif: "auto_reply" }
  | { statut: "opposition"; motif: "contact_opposed" }
  | { statut: "relecture"; motif: string };

function receive(evaluationCase: EvaluationCase, message: CaseMessage): Reception {
  const senderMatches = evaluationCase.contexte.expediteur_est_destinataire;
  const authentication = senderAuthentication(evaluationCase);
  if (isAutomaticReply({ headers: {}, subject: message.subject })) {
    return { statut: "reponse_automatique", motif: "auto_reply" };
  }
  if (
    senderMatches &&
    authentication.status === "pass" &&
    detectInformationAgentContactOptOut(message.bodyText)
  ) {
    return { statut: "opposition", motif: "contact_opposed" };
  }
  const wrongRecipient = detectWrongRecipientSignal(message.bodyText);
  const reviewReason =
    inboundReviewReason({ senderMatches, senderAuthentication: authentication }) ??
    (detectPossibleInformationAgentContactOptOut(message.bodyText)
      ? "possible_opposition"
      : null) ??
    (wrongRecipient
      ? wrongRecipient === "strong" && authentication.status === "pass"
        ? "wrong_recipient"
        : "possible_wrong_recipient"
      : null) ??
    (detectPossiblePromptInjection(message.subject) ||
    detectPossiblePromptInjection(message.bodyText)
      ? "possible_prompt_injection"
      : null);
  return reviewReason
    ? { statut: "relecture", motif: reviewReason }
    : { statut: "extraction", motif: null };
}

/** Candidat tel que le worker Python le lit et que le moteur le décide (sans extrait). */
export type StageCandidate = {
  id: string;
  message_id: string;
  fact_key: string;
  proposed_value: unknown;
  display_value: string | null;
  status: string;
  evidence_asset_id: string | null;
  source_page: number | null;
  metadata: unknown;
};

type RulesStageMessage = {
  role: string;
  message_id: string;
  reception: Reception;
  /** Texte de la pièce « corps du message » que le worker lit (null : aucune pièce créée). */
  body_evidence_text: string | null;
  lot_unidentified: boolean;
};

export type RulesStageEntry = { messages: RulesStageMessage[]; candidates: StageCandidate[] };

function stageCandidate(row: Row): StageCandidate {
  return {
    id: String(row.id),
    message_id: String(row.message_id),
    fact_key: String(row.fact_key),
    proposed_value: row.proposed_value ?? null,
    display_value: typeof row.display_value === "string" ? row.display_value : null,
    status: String(row.status),
    evidence_asset_id: typeof row.evidence_asset_id === "string" ? row.evidence_asset_id : null,
    source_page: typeof row.source_page === "number" ? row.source_page : null,
    metadata: row.metadata ?? null,
  };
}

/** Étape 1 : réception et règles TypeScript pour chaque message du dossier. */
export async function runRulesStage(evaluationCase: EvaluationCase): Promise<RulesStageEntry> {
  assertEvaluationClient();
  const ids = evaluationIds(evaluationCase);
  const database = activateEvaluationDatabase(new EvaluationDatabase(evaluationCase.id));
  database.rows("auction_sales").push(saleRow(evaluationCase));
  const messages: RulesStageMessage[] = [];
  for (const message of caseMessages(evaluationCase)) {
    const reception = receive(evaluationCase, message);
    if (reception.statut !== "extraction") {
      messages.push({
        role: message.role,
        message_id: message.messageId,
        reception,
        body_evidence_text: null,
        lot_unidentified: false,
      });
      continue;
    }
    const replyText = replyTextForExtraction(message.bodyText);
    const facts = extractInformationAgentFacts(replyText);
    const assets = message.attachments.map((attachment, index) => ({
      id: ids.attachmentAssetId(index),
      filename: attachment.nom,
      mimeType: "text/plain",
      storagePath: `${ids.caseId}/${message.messageId}/${attachment.nom}`,
      size: new TextEncoder().encode(attachment.texte).length,
    }));
    // Comme `processInboundEmail` : vente à plusieurs lots et réponse sans numéro de lot.
    const lotUnidentified =
      facts.length + assets.length > 0 &&
      !replyMentionsLot(replyText) &&
      evaluationCase.contexte.quality_flags.includes("multi_lot_sale");
    await persistFactCandidates({
      sharedCase: { id: ids.caseId, sale_id: ids.saleId } as SharedCase,
      messageId: message.messageId,
      facts,
      assets,
      lotUnidentified,
    });
    // Comme `persistInboundBodyEvidence` : le corps relu par le worker.
    const bodyForEvidence = replyTextForExtraction(message.bodyText).trim();
    messages.push({
      role: message.role,
      message_id: message.messageId,
      reception,
      body_evidence_text:
        bodyForEvidence && bodyForEvidence !== "Réponse reçue sans corps de texte."
          ? bodyForEvidence
          : null,
      lot_unidentified: lotUnidentified,
    });
  }
  return {
    messages,
    candidates: database.rows("information_agent_fact_candidates").map(stageCandidate),
  };
}

/**
 * État du dossier et des messages vu par le moteur :
 * - `hypothese` : un message traité sans relecture de réception est « completed » sans motif et le dossier
 *   « replied », l'état que le moteur exige ;
 * - `etat_reel` : l'état que la chaîne écrit vraiment : message et dossier en « review » dès qu'une pièce
 *   « corps » existe (motif `candidate_or_attachment_review`).
 * Dans les deux variantes, une relecture ou une opposition décidée à la réception garde son état réel.
 */
export type EngineVariant = "hypothese" | "etat_reel";

export type FieldDecision = {
  value: number | null;
  role: string;
  provenance: "regles" | "ia_seule" | "piece_jointe";
  outcome: "would_publish" | "review";
  reasons: string[];
};
export type EngineStageEntry = Record<EvaluationField, FieldDecision[]>;

function processingState(stage: RulesStageMessage, variant: EngineVariant): Row {
  const { reception } = stage;
  if (reception.statut === "reponse_automatique")
    return { status: "ignored", reason: "auto_reply" };
  if (reception.statut !== "extraction") return { status: "review", reason: reception.motif };
  if (variant === "etat_reel" && stage.body_evidence_text) {
    return { status: "review", reason: "candidate_or_attachment_review" };
  }
  return { status: "completed" };
}

/** Étape 3 : passe de simulation du moteur sur la table des candidats complétée par le worker. */
export async function runEngineStage(
  evaluationCase: EvaluationCase,
  stage: RulesStageEntry,
  candidates: StageCandidate[],
  variant: EngineVariant,
): Promise<EngineStageEntry> {
  assertEvaluationClient();
  const ids = evaluationIds(evaluationCase);
  const { contexte } = evaluationCase;
  const database = activateEvaluationDatabase(
    new EvaluationDatabase(`${evaluationCase.id}-engine`),
  );
  database
    .rows("information_agent_auto_publication_settings")
    .push({ singleton: true, mode: "simulation" });
  database.rows("auction_sales").push(saleRow(evaluationCase));
  const messages = caseMessages(evaluationCase);
  const states = new Map(
    stage.messages.map((item) => [item.message_id, processingState(item, variant)]),
  );
  const caseInReview = [...states.values()].some((state) => state.status === "review");
  database.rows("information_agent_cases").push({
    id: ids.caseId,
    sent_at: new Date(RECEIVED_AT - contexte.delai_jours * DAY_MS).toISOString(),
    recipient_kind: contexte.destinataire,
    status: caseInReview ? "review" : "replied",
  });
  for (const message of messages) {
    database.rows("information_agent_messages").push({
      id: message.messageId,
      case_id: ids.caseId,
      direction: "inbound",
      received_at: message.receivedAt,
      created_at: message.receivedAt,
      subject: message.subject,
      body_text: message.bodyText,
      metadata: {
        imported_manually: false,
        content_trust: "untrusted",
        sender_matches_recipient: contexte.expediteur_est_destinataire,
        sender_authentication: senderAuthentication(evaluationCase),
        inbound_processing: states.get(message.messageId),
      },
    });
  }
  const bodyAssets = new Set(messages.map((message) => ids.bodyAssetId(message.role)));
  database.rows("information_agent_evidence_assets").push(
    ...[...bodyAssets].map((id) => ({ id, metadata: { evidence_kind: "email_body" } })),
    ...evaluationCase.message.pieces_jointes.map((_, index) => ({
      id: ids.attachmentAssetId(index),
      metadata: { content_trust: "untrusted_external_evidence" },
    })),
  );
  const receivedAt = new Map(messages.map((message) => [message.messageId, message.receivedAt]));
  const roles = new Map(messages.map((message) => [message.messageId, message.role]));
  for (const candidate of candidates) {
    database.rows("information_agent_fact_candidates").push({
      ...candidate,
      case_id: ids.caseId,
      sale_id: ids.saleId,
      reviewed_by: null,
      created_at: receivedAt.get(candidate.message_id),
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
  const entry = Object.fromEntries(
    EVALUATION_FIELDS.map((field) => [field, []]),
  ) as unknown as EngineStageEntry;
  for (const candidate of candidates) {
    if (!(EVALUATION_FIELDS as readonly string[]).includes(candidate.fact_key)) continue;
    const decision = decisions.get(candidate.id);
    const raw = (candidate.proposed_value as { value?: unknown } | null)?.value;
    const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    const value = Number.isFinite(parsed) ? parsed : null;
    const provenance = candidate.evidence_asset_id
      ? bodyAssets.has(candidate.evidence_asset_id)
        ? "ia_seule"
        : "piece_jointe"
      : "regles";
    const role = roles.get(candidate.message_id) ?? "inconnu";
    entry[candidate.fact_key as EvaluationField].push(
      decision
        ? {
            value,
            role,
            provenance,
            outcome: decision.outcome === "would_publish" ? "would_publish" : "review",
            reasons: (decision.reasons as string[]) ?? [],
          }
        : // Candidat non examiné par la passe (en conflit avec la fiche) : relecture.
          { value, role, provenance, outcome: "review", reasons: [candidate.status] },
    );
  }
  return entry;
}
