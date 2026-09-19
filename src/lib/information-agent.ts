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
import { getSale } from "@/lib/property-report/repository";
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

// The admin workflow deliberately does not expose the former end-user consent
// flag. Admins are the sole initiators of these requests and the requester
// email is never shared with the professional contact.
export const informationAgentAdminActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve_and_send"),
    missionId: z.string().uuid(),
    approvalConfirmed: z.literal(true),
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
export type InformationAgentAdminActionPayload = z.output<typeof informationAgentAdminActionSchema>;

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

export type InformationAgentAdminResponse = {
  ok: true;
  mission: InformationAgentMission;
  gaps: InformationAgentGap[];
  facts: InformationAgentFact[];
};

export type InformationAgentAdminListResponse = {
  ok: true;
  missions: InformationAgentMission[];
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

/**
 * Creates a mission for the internal admin enrichment workflow.
 *
 * This intentionally does not resolve plan entitlements, consume a user
 * rate-limit bucket, or create a requester subscription. The admin account is
 * the mission owner for traceability and the canonical case is still created
 * through the existing subscription RPC so inbound webhook routing remains
 * unchanged.
 */
export async function createAdminInformationAgentDraft({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: z.output<typeof informationAgentCreateSchema>;
}): Promise<InformationAgentAdminResponse> {
  requireInformationAgentAdmin(auth);

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

  const { data, error } = await supabaseAdmin
    .from("information_agent_missions")
    .insert({
      user_id: auth.userId,
      sale_id: sale.id,
      recipient_kind: sale.lawyer_name || extractedEmail ? "source_lawyer" : "manual_professional",
      recipient_name: recipientName || null,
      recipient_email: recipientEmail,
      share_requester_email: false,
      subject: draft.subject,
      body_text: draft.bodyText,
      question_keys: questionKeys,
      missing_information: gaps.map((gap) => gap.key),
      sale_snapshot: saleSnapshot(sale),
      privacy_version: LEGAL_DOCUMENTS.privacy.version,
      metadata: {
        draft_source: "admin_deterministic_gap_analysis",
        initiated_by_admin: auth.userId,
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
    facts: await listFactsForCases(subscribedMission.case_id ? [subscribedMission.case_id] : []),
  };
}

export async function listAdminInformationAgentMissions({
  auth,
  saleId,
}: {
  auth: SupabaseAuthContext;
  saleId?: string;
}): Promise<InformationAgentAdminListResponse> {
  requireInformationAgentAdmin(auth);
  let query = supabaseAdmin
    .from("information_agent_missions")
    .select("*")
    .eq("user_id", auth.userId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (saleId) query = query.eq("sale_id", saleId);

  const { data, error } = await query;
  if (error) throw error;
  const rows = data ?? [];
  return {
    ok: true,
    missions: rows.map(missionFromRow),
    facts: await listFactsForCases(
      rows.flatMap((mission) => (mission.case_id ? [mission.case_id] : [])),
    ),
  };
}

export async function runAdminInformationAgentAction({
  auth,
  input,
  fetchImpl = fetch,
}: {
  auth: SupabaseAuthContext;
  input: InformationAgentAdminActionPayload;
  fetchImpl?: typeof fetch;
}): Promise<InformationAgentAdminListResponse> {
  requireInformationAgentAdmin(auth);

  if (input.action === "approve_and_send") {
    await approveAndSendMission({ adminId: auth.userId, input, fetchImpl });
  } else if (input.action === "record_reply") {
    await recordMissionReply({ adminId: auth.userId, input });
  } else {
    await cancelMission({ adminId: auth.userId, missionId: input.missionId });
  }

  const mission = await loadOwnedMission(auth.userId, input.missionId);
  return {
    ok: true,
    missions: [missionFromRow(mission)],
    facts: await listFactsForCases(mission.case_id ? [mission.case_id] : []),
  };
}

async function approveAndSendMission({
  adminId,
  input,
  fetchImpl,
}: {
  adminId: string;
  input: Extract<InformationAgentAdminActionPayload, { action: "approve_and_send" }>;
  fetchImpl: typeof fetch;
}) {
  const mission = await loadOwnedMission(adminId, input.missionId);
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
    .eq("user_id", mission.user_id)
    .in("status", ["draft", "failed"])
    .select("*")
    .single();
  if (editError) throw editError;

  const { error: subscribeError } = await supabaseAdmin.rpc("subscribe_information_agent_mission", {
    p_user_id: mission.user_id,
    p_mission_id: mission.id,
  });
  if (subscribeError) throw subscribeError;
  const subscribedMission = await loadOwnedMission(adminId, mission.id);
  const messageHash = approvalFingerprint(subscribedMission);
  const approval = await approveInformationAgentMissionForAdmin(subscribedMission, messageHash);
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
      user_id: mission.user_id,
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
    await updateMissionOrThrow(mission.id, mission.user_id, {
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
    await updateMissionOrThrow(mission.id, mission.user_id, {
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
  adminId,
  input,
}: {
  adminId: string;
  input: Extract<InformationAgentAdminActionPayload, { action: "record_reply" }>;
}) {
  const mission = await loadOwnedMission(adminId, input.missionId);
  if (!(["sent", "replied"] as MissionRow["status"][]).includes(mission.status)) {
    throw new Error("Requête invalide : aucune réponse ne peut être rattachée à cette enquête.");
  }
  const receivedAt = new Date().toISOString();
  const { error } = await supabaseAdmin.from("information_agent_messages").insert({
    mission_id: mission.id,
    case_id: mission.case_id,
    user_id: mission.user_id,
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
  await updateMissionOrThrow(mission.id, mission.user_id, {
    status: "replied",
    replied_at: receivedAt,
  });
  if (mission.case_id) {
    await updateCaseOrThrow(mission.case_id, { status: "replied", replied_at: receivedAt });
  }
}

async function cancelMission({ adminId, missionId }: { adminId: string; missionId: string }) {
  const mission = await loadOwnedMission(adminId, missionId);
  if (!(["draft", "failed"] as MissionRow["status"][]).includes(mission.status)) {
    throw new Error("Requête invalide : un message déjà envoyé ne peut pas être annulé.");
  }
  await updateMissionOrThrow(mission.id, mission.user_id, {
    status: "cancelled",
    completed_at: new Date().toISOString(),
  });
}

function requireInformationAgentAdmin(auth: SupabaseAuthContext): void {
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");
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

type InformationAgentApproval = {
  case_id: string;
  should_send: boolean;
  inbound_token: string;
};

/**
 * Approves an admin mission without calling the user quota RPC. The existing
 * case/subscriber model is retained so inbound Resend replies continue to be
 * routed and reviewed exactly as before.
 */
async function approveInformationAgentMissionForAdmin(
  mission: MissionRow,
  messageHash: string,
): Promise<InformationAgentApproval> {
  const { data, error } = await supabaseAdmin.rpc("approve_information_agent_mission_admin", {
    p_admin_id: mission.user_id,
    p_mission_id: mission.id,
    p_message_sha256: messageHash,
  });
  if (error) throw new Error(error.message || "Approbation admin impossible.");
  const approval = data?.[0];
  if (!approval) throw new Error("Approbation admin impossible.");
  return approval;
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
