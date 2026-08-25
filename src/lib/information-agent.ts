import { createHash } from "node:crypto";
import { z } from "zod";
import {
  INFORMATION_REQUEST_EMAIL_TEMPLATE_VERSION,
  renderInformationRequestEmail,
} from "../../emails/information-request";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { getPublishedInformationAgentEmailTemplate } from "@/lib/admin-information-agent-email-template";
import { parseDocs } from "@/lib/documents";
import { sendResendEmail } from "@/lib/email-alerts";
import { formatDate, formatPrice } from "@/lib/format";
import {
  DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  renderInformationAgentEmailContent,
  type InformationAgentEmailTemplateContent,
} from "@/lib/information-agent-email-template";
import { LEGAL_DOCUMENTS } from "@/lib/legal-documents";
import { featureIncluded, type PlanCode } from "@/lib/plans";
import { resolvePlanEntitlements } from "@/lib/property-reports";
import { getSale } from "@/lib/property-report/repository";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { propertyImages } from "@/lib/sale-media";
import { saleDisplayTitle } from "@/lib/sale-title";
import { getSaleSurface } from "@/lib/surface";
import type { AuctionSale } from "@/lib/types";

type MissionRow = Database["public"]["Tables"]["information_agent_missions"]["Row"];
type CaseRow = Database["public"]["Tables"]["information_agent_cases"]["Row"];
type FactRow = Database["public"]["Tables"]["information_agent_fact_candidates"]["Row"];

export const INFORMATION_AGENT_QUESTIONS = {
  documents: {
    label: "Pièces du dossier",
    question:
      "Pourriez-vous transmettre le cahier des conditions de vente et les pièces consultables du dossier ?",
  },
  photos: {
    label: "Photos complémentaires",
    question:
      "Disposez-vous de photographies complémentaires ou plus récentes du bien et de ses annexes ?",
  },
  visit: {
    label: "Visites",
    question: "Quelles sont les prochaines dates de visite et les modalités d'inscription ?",
  },
  occupancy: {
    label: "Occupation",
    question:
      "Le bien est-il actuellement libre, occupé ou loué, et cette situation a-t-elle évolué récemment ?",
  },
  surface: {
    label: "Surface",
    question:
      "Pouvez-vous confirmer les surfaces habitables, Carrez et, le cas échéant, celles du terrain ?",
  },
  diagnostics: {
    label: "Diagnostics",
    question:
      "Les diagnostics techniques, notamment le DPE, sont-ils disponibles dans une version à jour ?",
  },
  composition: {
    label: "Composition",
    question:
      "Pouvez-vous confirmer la composition du bien, le nombre de pièces et les éventuelles annexes ?",
  },
  sale_terms: {
    label: "Modalités de vente",
    question:
      "Pouvez-vous confirmer les modalités d'enchère, de consignation et les frais annoncés pour cette vente ?",
  },
} as const;

export type InformationAgentQuestionKey = keyof typeof INFORMATION_AGENT_QUESTIONS;
const QUESTION_KEYS = Object.keys(INFORMATION_AGENT_QUESTIONS) as [
  InformationAgentQuestionKey,
  ...InformationAgentQuestionKey[],
];

export const informationAgentCreateSchema = z.object({
  saleId: z.string().uuid(),
  recipientEmail: z.string().trim().email().max(320).optional(),
  recipientName: z.string().trim().max(180).optional(),
  questionKeys: z.array(z.enum(QUESTION_KEYS)).min(1).max(8).optional(),
});

export const informationAgentListQuerySchema = z.object({
  saleId: z.string().uuid().optional(),
});

const editableMessageFields = {
  recipientEmail: z.string().trim().email().max(320),
  recipientName: z.string().trim().max(180).nullable().optional(),
  subject: z
    .string()
    .trim()
    .min(3)
    .max(200)
    .refine((value) => !/[\r\n]/.test(value), "Objet invalide."),
  bodyText: z.string().trim().min(20).max(8000),
};

export const informationAgentActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve_and_send"),
    missionId: z.string().uuid(),
    approvalConfirmed: z.literal(true),
    shareRequesterEmail: z.literal(true),
    ...editableMessageFields,
  }),
  z.object({
    action: z.literal("cancel"),
    missionId: z.string().uuid(),
  }),
  z.object({
    action: z.literal("record_reply"),
    missionId: z.string().uuid(),
    bodyText: z.string().trim().min(1).max(16000),
    subject: z.string().trim().min(3).max(200).optional(),
  }),
]);

export type InformationAgentCreateInput = z.input<typeof informationAgentCreateSchema>;
export type InformationAgentActionInput = z.input<typeof informationAgentActionSchema>;
export type InformationAgentActionPayload = z.output<typeof informationAgentActionSchema>;

export type InformationAgentGap = {
  key: InformationAgentQuestionKey;
  label: string;
  reason: string;
};

export type InformationAgentMission = {
  id: string;
  caseId: string | null;
  saleId: string | null;
  status: MissionRow["status"];
  recipientKind: MissionRow["recipient_kind"];
  recipientName: string | null;
  recipientEmail: string;
  subject: string;
  bodyText: string;
  questionKeys: InformationAgentQuestionKey[];
  missingInformation: string[];
  failureReason: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  repliedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InformationAgentFact = {
  id: string;
  caseId: string;
  factKey: FactRow["fact_key"];
  displayValue: string;
  confidence: number;
  status: FactRow["status"];
  evidenceExcerpt: string | null;
  createdAt: string;
  reviewedAt: string | null;
};

export type InformationAgentQuota = {
  limit: number | null;
  used: number;
  remaining: number | null;
  windowDays: 30;
};

export type InformationAgentResponse = {
  ok: true;
  mission: InformationAgentMission;
  gaps: InformationAgentGap[];
  quota: InformationAgentQuota;
  plan: { code: PlanCode; label: string };
  facts: InformationAgentFact[];
};

export type InformationAgentListResponse = {
  ok: true;
  missions: InformationAgentMission[];
  quota: InformationAgentQuota;
  facts: InformationAgentFact[];
};

export function detectInformationGaps(sale: AuctionSale): InformationAgentGap[] {
  const gaps: InformationAgentGap[] = [];
  const documents = sale.documents_rich?.length || parseDocs(sale.documents).length;
  const images = propertyImages(sale.media).length;
  const visitDates = meaningfulList(sale.visit_dates);
  const occupancy = sale.occupancy_status?.trim().toLowerCase();
  const surface = getSaleSurface(sale);
  const documentText = JSON.stringify(sale.documents_rich ?? sale.documents ?? "").toLowerCase();

  if (!documents)
    addGap(gaps, "documents", "Aucune pièce consultable n'est rattachée à l'annonce.");
  if (images < 4)
    addGap(
      gaps,
      "photos",
      `${images} photo${images > 1 ? "s" : ""} exploitable${images > 1 ? "s" : ""} seulement.`,
    );
  if (!visitDates.length) addGap(gaps, "visit", "Aucune date de visite exploitable n'est publiée.");
  if (!occupancy || occupancy === "unknown" || occupancy === "inconnu") {
    addGap(gaps, "occupancy", "La situation d'occupation reste à confirmer.");
  }
  if (surface.value == null || surface.estimated) {
    addGap(gaps, "surface", "La surface est absente ou seulement estimée.");
  }
  if (!/(diagnostic|\bdpe\b|performance.nerg)/i.test(documentText)) {
    addGap(gaps, "diagnostics", "Aucun diagnostic technique n'est clairement identifié.");
  }
  if (sale.rooms_count == null) {
    addGap(gaps, "composition", "Le nombre de pièces n'est pas confirmé.");
  }
  if (!sale.sale_procedure || !Object.keys(sale.sale_procedure).length) {
    addGap(gaps, "sale_terms", "Les modalités détaillées de la vente ne sont pas structurées.");
  }

  return gaps;
}

export function buildInformationRequestDraft({
  sale,
  recipientName,
  questionKeys,
  template = DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
}: {
  sale: AuctionSale;
  recipientName?: string | null;
  questionKeys: readonly InformationAgentQuestionKey[];
  template?: InformationAgentEmailTemplateContent;
}): { subject: string; bodyText: string } {
  const title = saleDisplayTitle(sale, "Vente immobilière");
  const location = [sale.postal_code, sale.city].filter(Boolean).join(" ");
  const hearing = formatDate(sale.sale_date);
  const reference = [title, location, sale.tribunal].filter(Boolean).join(" — ");
  return renderInformationAgentEmailContent({
    template,
    values: {
      recipient_name: recipientName?.trim() || "Madame, Monsieur",
      sale_title: title,
      sale_reference: reference || title,
      location: location || "Localisation non précisée",
      tribunal: sale.tribunal || "Tribunal non précisé",
      hearing_date: hearing,
      starting_price: formatPrice(sale.starting_price_eur),
      questions: questionKeys
        .map((key) => `- ${INFORMATION_AGENT_QUESTIONS[key].question}`)
        .join("\n"),
    },
  });
}

export async function createInformationAgentDraft({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: z.output<typeof informationAgentCreateSchema>;
}): Promise<InformationAgentResponse> {
  const plan = await requireInformationAgentAccess(auth);
  await enforceUserRateLimit({
    userId: auth.userId,
    bucketKey: "information-agent.draft",
    limit: 10,
    windowSeconds: 60,
  });

  const [sale, emailTemplate] = await Promise.all([
    getSale(auth.supabase, input.saleId),
    getPublishedInformationAgentEmailTemplate(),
  ]);
  const gaps = detectInformationGaps(sale);
  const defaultQuestions = gaps.length
    ? gaps.map((gap) => gap.key)
    : (["documents", "photos", "visit"] as InformationAgentQuestionKey[]);
  const questionKeys = uniqueQuestionKeys(input.questionKeys ?? defaultQuestions);
  const extractedEmail = extractEmail(sale.lawyer_contact);
  const recipientEmail = input.recipientEmail ?? extractedEmail;
  if (!recipientEmail) {
    throw new Error("Requête invalide : renseignez l'adresse email du professionnel à contacter.");
  }
  const recipientName = input.recipientName ?? sale.lawyer_name;
  const draft = buildInformationRequestDraft({
    sale,
    recipientName,
    questionKeys,
    template: emailTemplate.content,
  });
  const quota = await readInformationAgentQuota(
    auth.userId,
    plan.limits.informationAgentMissionsPer30Days,
  );

  const { data, error } = await supabaseAdmin
    .from("information_agent_missions")
    .insert({
      user_id: auth.userId,
      sale_id: sale.id,
      recipient_kind: sale.lawyer_name || extractedEmail ? "source_lawyer" : "manual_professional",
      recipient_name: recipientName || null,
      recipient_email: recipientEmail,
      subject: draft.subject,
      body_text: draft.bodyText,
      question_keys: questionKeys,
      missing_information: gaps.map((gap) => gap.key),
      sale_snapshot: saleSnapshot(sale),
      privacy_version: LEGAL_DOCUMENTS.privacy.version,
      metadata: {
        draft_source: "deterministic_gap_analysis",
        email_content_template_id: emailTemplate.id,
        email_content_template_revision: emailTemplate.revision,
      },
    })
    .select("*")
    .single();

  if (error) throw error;
  const { error: subscribeError } = await supabaseAdmin.rpc("subscribe_information_agent_mission", {
    p_user_id: auth.userId,
    p_mission_id: data.id,
  });
  if (subscribeError) throw subscribeError;
  const subscribedMission = await loadOwnedMission(auth.userId, data.id);
  return {
    ok: true,
    mission: missionFromRow(subscribedMission),
    gaps,
    quota,
    plan: { code: plan.plan, label: plan.label },
    facts: await listFactsForCases(subscribedMission.case_id ? [subscribedMission.case_id] : []),
  };
}

export async function listInformationAgentMissions({
  auth,
  saleId,
}: {
  auth: SupabaseAuthContext;
  saleId?: string;
}): Promise<InformationAgentListResponse> {
  const plan = await requireInformationAgentAccess(auth);
  let query = supabaseAdmin
    .from("information_agent_missions")
    .select("*")
    .eq("user_id", auth.userId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (saleId) query = query.eq("sale_id", saleId);

  const [{ data, error }, quota] = await Promise.all([
    query,
    readInformationAgentQuota(auth.userId, plan.limits.informationAgentMissionsPer30Days),
  ]);
  if (error) throw error;
  const rows = data ?? [];
  return {
    ok: true,
    missions: rows.map(missionFromRow),
    quota,
    facts: await listFactsForCases(
      rows.flatMap((mission) => (mission.case_id ? [mission.case_id] : [])),
    ),
  };
}

export async function runInformationAgentAction({
  auth,
  input,
  fetchImpl = fetch,
}: {
  auth: SupabaseAuthContext;
  input: InformationAgentActionPayload;
  fetchImpl?: typeof fetch;
}): Promise<InformationAgentListResponse> {
  const plan = await requireInformationAgentAccess(auth);
  await enforceUserRateLimit({
    userId: auth.userId,
    bucketKey: "information-agent.action",
    limit: 8,
    windowSeconds: 60,
  });

  if (input.action === "approve_and_send") {
    await approveAndSendMission({ auth, input, fetchImpl });
  } else if (input.action === "record_reply") {
    await recordMissionReply({ auth, input });
  } else {
    await cancelMission({ auth, missionId: input.missionId });
  }

  const { data, error } = await supabaseAdmin
    .from("information_agent_missions")
    .select("*")
    .eq("user_id", auth.userId)
    .eq("id", input.missionId)
    .single();
  if (error) throw error;

  return {
    ok: true,
    missions: [missionFromRow(data)],
    quota: await readInformationAgentQuota(
      auth.userId,
      plan.limits.informationAgentMissionsPer30Days,
    ),
    facts: await listFactsForCases(data.case_id ? [data.case_id] : []),
  };
}

async function approveAndSendMission({
  auth,
  input,
  fetchImpl,
}: {
  auth: SupabaseAuthContext;
  input: Extract<InformationAgentActionPayload, { action: "approve_and_send" }>;
  fetchImpl: typeof fetch;
}) {
  const mission = await loadOwnedMission(auth.userId, input.missionId);
  if (mission.status !== "draft" && mission.status !== "failed") {
    throw new Error("Requête invalide : cette enquête ne peut plus être modifiée.");
  }

  const { data: edited, error: editError } = await supabaseAdmin
    .from("information_agent_missions")
    .update({
      recipient_email: input.recipientEmail,
      recipient_name: input.recipientName || null,
      reply_to_email: null,
      share_requester_email: false,
      subject: input.subject,
      body_text: input.bodyText,
      failure_reason: null,
    })
    .eq("id", mission.id)
    .eq("user_id", auth.userId)
    .in("status", ["draft", "failed"])
    .select("*")
    .single();
  if (editError) throw editError;

  const { error: subscribeError } = await supabaseAdmin.rpc("subscribe_information_agent_mission", {
    p_user_id: auth.userId,
    p_mission_id: mission.id,
  });
  if (subscribeError) throw subscribeError;
  const subscribedMission = await loadOwnedMission(auth.userId, mission.id);
  const messageHash = approvalFingerprint(subscribedMission);
  const { data: approvalRows, error: approvalError } = await supabaseAdmin.rpc(
    "approve_information_agent_mission_bounded",
    {
      p_user_id: auth.userId,
      p_mission_id: mission.id,
      p_message_sha256: messageHash,
    },
  );
  if (approvalError) {
    if (approvalError.message.includes("INFORMATION_AGENT_MONTHLY_LIMIT")) {
      throw new Error("Trop de demandes : les 3 enquêtes disponibles sur 30 jours sont utilisées.");
    }
    throw new Error(approvalError.message || "Approbation de l'enquête impossible.");
  }
  const approval = approvalRows?.[0];
  if (!approval) throw new Error("Approbation de l'enquête impossible.");
  if (!approval.should_send) return;

  const config = resolveInformationAgentEmailConfig();
  const replyTo = `enquete+${approval.inbound_token}@${config.inboundDomain}`;
  const sendingAt = new Date().toISOString();

  try {
    const renderedEmail = await renderInformationRequestEmail({
      subject: edited.subject,
      bodyText: edited.body_text,
      replyTo,
      caseReference: informationAgentCaseReference(approval.case_id),
      appUrl: config.appUrl,
    });
    const delivery = await sendResendEmail({
      apiKey: config.apiKey,
      idempotencyKey: `immojudis-information-agent-case-${approval.case_id}`,
      fetchImpl,
      message: {
        from: config.from,
        to: edited.recipient_email,
        replyTo,
        subject: edited.subject,
        text: renderedEmail.text,
        html: renderedEmail.html,
      },
    });
    const sentAt = new Date().toISOString();
    const missionMetadata = asObject(edited.metadata);
    const { error: messageError } = await supabaseAdmin.from("information_agent_messages").insert({
      mission_id: mission.id,
      case_id: approval.case_id,
      user_id: auth.userId,
      direction: "outbound",
      message_kind: "initial",
      delivery_status: "sent",
      from_email: config.from,
      to_email: edited.recipient_email,
      subject: edited.subject,
      body_text: edited.body_text,
      provider_message_id: delivery.id,
      sent_at: sentAt,
      metadata: {
        approval_sha256: messageHash,
        email_template_version: INFORMATION_REQUEST_EMAIL_TEMPLATE_VERSION,
        email_content_template_id: missionMetadata.email_content_template_id ?? null,
        email_content_template_revision: missionMetadata.email_content_template_revision ?? null,
      },
    });
    if (messageError) throw messageError;
    await updateMissionOrThrow(mission.id, auth.userId, {
      status: "sent",
      sent_at: sentAt,
      provider_message_id: delivery.id,
      failure_reason: null,
    });
    await updateCaseOrThrow(approval.case_id, {
      status: "sent",
      sent_at: sentAt,
      provider_message_id: delivery.id,
      failure_reason: null,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 1000) : "Envoi impossible.";
    await updateMissionOrThrow(mission.id, auth.userId, {
      status: "failed",
      failure_reason: detail,
      metadata: { ...asObject(edited.metadata), last_send_attempt_at: sendingAt },
    });
    await updateCaseOrThrow(approval.case_id, {
      status: "failed",
      failure_reason: detail,
    });
    throw error;
  }
}

async function recordMissionReply({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: Extract<InformationAgentActionPayload, { action: "record_reply" }>;
}) {
  const mission = await loadOwnedMission(auth.userId, input.missionId);
  if (!(["sent", "replied"] as MissionRow["status"][]).includes(mission.status)) {
    throw new Error("Requête invalide : aucune réponse ne peut être rattachée à cette enquête.");
  }
  const receivedAt = new Date().toISOString();
  const { error } = await supabaseAdmin.from("information_agent_messages").insert({
    mission_id: mission.id,
    case_id: mission.case_id,
    user_id: auth.userId,
    direction: "inbound",
    message_kind: "reply",
    delivery_status: "received",
    from_email: mission.recipient_email,
    to_email: mission.reply_to_email,
    subject: input.subject ?? `Re: ${mission.subject}`.slice(0, 200),
    body_text: input.bodyText,
    received_at: receivedAt,
    metadata: { imported_manually: true, content_trust: "untrusted" },
  });
  if (error) throw error;
  await updateMissionOrThrow(mission.id, auth.userId, {
    status: "replied",
    replied_at: receivedAt,
  });
  if (mission.case_id) {
    await updateCaseOrThrow(mission.case_id, { status: "replied", replied_at: receivedAt });
  }
}

async function cancelMission({
  auth,
  missionId,
}: {
  auth: SupabaseAuthContext;
  missionId: string;
}) {
  const mission = await loadOwnedMission(auth.userId, missionId);
  if (!(["draft", "failed"] as MissionRow["status"][]).includes(mission.status)) {
    throw new Error("Requête invalide : un message déjà envoyé ne peut pas être annulé.");
  }
  await updateMissionOrThrow(mission.id, auth.userId, {
    status: "cancelled",
    completed_at: new Date().toISOString(),
  });
}

async function requireInformationAgentAccess(auth: SupabaseAuthContext) {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "property.informationAgent")) {
    throw new Error("L'enquête dossier est réservée au plan Analyse.");
  }
  return plan;
}

async function loadOwnedMission(userId: string, missionId: string): Promise<MissionRow> {
  const { data, error } = await supabaseAdmin
    .from("information_agent_missions")
    .select("*")
    .eq("id", missionId)
    .eq("user_id", userId)
    .single();
  if (error || !data) throw new Error("Requête invalide : enquête introuvable.");
  return data;
}

async function updateMissionOrThrow(
  missionId: string,
  userId: string,
  values: Database["public"]["Tables"]["information_agent_missions"]["Update"],
) {
  const { error } = await supabaseAdmin
    .from("information_agent_missions")
    .update(values)
    .eq("id", missionId)
    .eq("user_id", userId);
  if (error) throw error;
}

async function readInformationAgentQuota(
  userId: string,
  limit: number | null,
): Promise<InformationAgentQuota> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
  const { count, error } = await supabaseAdmin
    .from("information_agent_missions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("approved_at", since)
    .in("status", ["approved", "sending", "sent", "replied", "completed"]);
  if (error) throw error;
  const used = count ?? 0;
  return {
    limit,
    used,
    remaining: limit == null ? null : Math.max(0, limit - used),
    windowDays: 30,
  };
}

function missionFromRow(row: MissionRow): InformationAgentMission {
  return {
    id: row.id,
    caseId: row.case_id,
    saleId: row.sale_id,
    status: row.status,
    recipientKind: row.recipient_kind,
    recipientName: row.recipient_name,
    recipientEmail: row.recipient_email,
    subject: row.subject,
    bodyText: row.body_text,
    questionKeys: row.question_keys.filter(isQuestionKey),
    missingInformation: row.missing_information,
    failureReason: row.failure_reason,
    approvedAt: row.approved_at,
    sentAt: row.sent_at,
    repliedAt: row.replied_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function saleSnapshot(sale: AuctionSale): Json {
  return {
    id: sale.id,
    title: saleDisplayTitle(sale),
    city: sale.city,
    postal_code: sale.postal_code,
    tribunal: sale.tribunal,
    sale_date: sale.sale_date,
    starting_price_eur: sale.starting_price_eur,
    source_url: sale.source_url,
  };
}

function approvalFingerprint(mission: MissionRow): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        recipientEmail: mission.recipient_email,
        replyToEmail: mission.reply_to_email,
        subject: mission.subject,
        bodyText: mission.body_text,
        emailTemplateVersion: INFORMATION_REQUEST_EMAIL_TEMPLATE_VERSION,
      }),
    )
    .digest("hex");
}

function resolveInformationAgentEmailConfig(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.INFORMATION_AGENT_EMAIL_FROM?.trim() || env.ALERT_EMAIL_FROM?.trim();
  const inboundDomain = env.INFORMATION_AGENT_INBOUND_DOMAIN?.trim().toLowerCase();
  if (!apiKey || !from || !inboundDomain) {
    throw new Error("Configuration d'envoi et de réception de l'agent incomplète.");
  }
  return { apiKey, from, inboundDomain, appUrl: "https://immojudis.com" };
}

export function informationAgentCaseReference(caseId: string): string {
  return `IJ-${caseId.replaceAll("-", "").slice(0, 8).toUpperCase()}`;
}

async function updateCaseOrThrow(
  caseId: string,
  values: Database["public"]["Tables"]["information_agent_cases"]["Update"],
) {
  const { error } = await supabaseAdmin
    .from("information_agent_cases")
    .update(values)
    .eq("id", caseId);
  if (error) throw error;
}

async function listFactsForCases(caseIds: string[]): Promise<InformationAgentFact[]> {
  const uniqueCaseIds = [...new Set(caseIds)];
  if (!uniqueCaseIds.length) return [];
  const { data, error } = await supabaseAdmin
    .from("information_agent_fact_candidates")
    .select("*")
    .in("case_id", uniqueCaseIds)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []).map((fact) => ({
    id: fact.id,
    caseId: fact.case_id,
    factKey: fact.fact_key,
    displayValue: fact.display_value,
    confidence: fact.confidence,
    status: fact.status,
    evidenceExcerpt: fact.evidence_excerpt,
    createdAt: fact.created_at,
    reviewedAt: fact.reviewed_at,
  }));
}

function addGap(gaps: InformationAgentGap[], key: InformationAgentQuestionKey, reason: string) {
  gaps.push({ key, label: INFORMATION_AGENT_QUESTIONS[key].label, reason });
}

function uniqueQuestionKeys(keys: readonly InformationAgentQuestionKey[]) {
  return [...new Set(keys)].slice(0, 8);
}

function meaningfulList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value];
  if (value && typeof value === "object") return Object.values(value).filter(Boolean);
  return [];
}

function extractEmail(value: string | null | undefined): string | undefined {
  const match = value?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  return normalizedEmail(match) ?? undefined;
}

function normalizedEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return z.string().email().safeParse(normalized).success ? normalized : null;
}

function isQuestionKey(value: string): value is InformationAgentQuestionKey {
  return value in INFORMATION_AGENT_QUESTIONS;
}

function asObject(value: Json): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
