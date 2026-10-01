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
import { readSaleFactClaims } from "@/lib/auction-fact-claims";
import { parseDocs } from "@/lib/documents";
import { sendResendEmail } from "@/lib/email-alerts";
import {
  extractInformationAgentFacts,
  persistFactCandidates,
  replyTextForExtraction,
} from "@/lib/information-agent-inbound";
import {
  getFactReliabilitiesFromClaims,
  getKeyFactReliabilities,
  type FactReliabilityMap,
  type FactReliabilityStatus,
  type KeyFact,
} from "@/lib/fact-reliability";
import { formatDate, formatPrice } from "@/lib/format";
import {
  DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  renderInformationAgentEmailContent,
  type InformationAgentEmailTemplateContent,
} from "@/lib/information-agent-email-template";
import { LEGAL_DOCUMENTS } from "@/lib/legal-documents";
import { publishedDay } from "@/lib/listing-evidence";
import { getSale } from "@/lib/property-report/repository";
import { propertyImages } from "@/lib/sale-media";
import { getSaleProcedure } from "@/lib/sale-procedure";
import { saleDisplayTitle } from "@/lib/sale-title";
import { resolveSiteOrigin } from "@/lib/site-url";
import { getSaleSurface } from "@/lib/surface";
import type { AuctionSale } from "@/lib/types";
import { informationAgentContributionUrl } from "@/lib/information-agent-contribution";

type MissionRow = Database["public"]["Tables"]["information_agent_missions"]["Row"];
type CaseRow = Database["public"]["Tables"]["information_agent_cases"]["Row"];
type FactRow = Database["public"]["Tables"]["information_agent_fact_candidates"]["Row"];

export const INFORMATION_AGENT_QUESTIONS = {
  sale_date: {
    label: "Date de vente",
    question:
      "Pouvez-vous confirmer la date, l'heure et le lieu de la vente de ce lot, ainsi que tout report ou changement annoncé ?",
  },
  starting_price_eur: {
    label: "Mise à prix",
    question:
      "Pouvez-vous confirmer la mise à prix applicable à ce lot et nous signaler toute correction publiée ?",
  },
  documents: {
    label: "Pièces du dossier",
    question:
      "Pourriez-vous transmettre le cahier des conditions de vente et les pièces consultables du dossier, en indiquant leur date ou leur version si elle est connue ?",
  },
  photos: {
    label: "Photos complémentaires",
    question:
      "Pouvez-vous préciser la date approximative des photos et nous signaler, pour chaque série, les pièces ou annexes qu’elles montrent ?",
  },
  visit: {
    label: "Visites",
    question:
      "Quelles sont les prochaines dates de visite, les modalités d'inscription et le contact à utiliser pour confirmer sa venue ?",
  },
  occupancy: {
    label: "Occupation",
    question:
      "Le bien est-il actuellement libre, occupé ou loué ? Si le bien est loué, pouvez-vous préciser le loyer connu et signaler toute évolution récente ?",
  },
  surface: {
    label: "Surface",
    question:
      "Pouvez-vous confirmer séparément la surface habitable, la surface Carrez et, le cas échéant, la surface du terrain ?",
  },
  diagnostics: {
    label: "Diagnostics",
    question:
      "Les diagnostics techniques, notamment le DPE, sont-ils disponibles dans une version à jour ? Merci d'indiquer leur date et les classes connues.",
  },
  composition: {
    label: "Composition",
    question:
      "Pouvez-vous confirmer la composition du bien, le nombre de pièces et les éventuelles annexes en distinguant celles incluses dans le lot ?",
  },
  sale_terms: {
    label: "Modalités de vente",
    question:
      "Pouvez-vous confirmer les modalités d'enchère, le montant et la forme de la consignation, les frais annoncés et les délais applicables ?",
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
  /** Higher values are asked first when the admin did not choose questions manually. */
  priority: number;
  /** A gap that can change the safety or feasibility of a bid. */
  blocking: boolean;
};

export type InformationAgentContactRole = "lawyer" | "notary" | "organizer" | "source_contact";

export type InformationAgentContactProvenance = {
  kind: "sale_field" | "source_block" | "source_text";
  field: string;
  sourceName: string | null;
  sourceUrl: string | null;
};

export type InformationAgentContactCandidate = {
  email: string;
  name: string | null;
  role: InformationAgentContactRole;
  recipientKind: Extract<MissionRow["recipient_kind"], "source_lawyer" | "source_contact">;
  confidence: "high" | "medium" | "low";
  score: number;
  provenance: InformationAgentContactProvenance[];
};

type InformationAgentContactRegistryRow =
  Database["public"]["Tables"]["information_agent_contacts"]["Row"];

export type InformationAgentContactRegistryBlock = Pick<
  InformationAgentContactRegistryRow,
  "scope_sale_id" | "opposition_status" | "bounce_status"
>;

const QUESTION_PRIORITY: Record<InformationAgentQuestionKey, { score: number; blocking: boolean }> =
  {
    sale_date: { score: 96, blocking: true },
    starting_price_eur: { score: 92, blocking: true },
    documents: { score: 100, blocking: true },
    sale_terms: { score: 94, blocking: true },
    visit: { score: 88, blocking: true },
    occupancy: { score: 82, blocking: true },
    surface: { score: 72, blocking: false },
    diagnostics: { score: 70, blocking: false },
    composition: { score: 64, blocking: false },
    photos: { score: 48, blocking: false },
  };

const MAX_DEFAULT_QUESTION_KEYS = 4;

export function selectDefaultInformationAgentQuestionKeys(
  gaps: readonly InformationAgentGap[],
): InformationAgentQuestionKey[] {
  if (!gaps.length) return [];
  return [...gaps]
    .sort((left, right) => right.priority - left.priority)
    .map((gap) => gap.key)
    .filter((key, index, keys) => keys.indexOf(key) === index)
    .slice(0, MAX_DEFAULT_QUESTION_KEYS);
}

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
  contactCandidates?: InformationAgentContactCandidate[];
};

export type InformationAgentAdminListResponse = {
  ok: true;
  missions: InformationAgentMission[];
  facts: InformationAgentFact[];
};

export function detectInformationGaps(
  sale: AuctionSale,
  facts: FactReliabilityMap = getKeyFactReliabilities(sale),
): InformationAgentGap[] {
  const gaps: InformationAgentGap[] = [];
  const documents = [...parseDocs(sale.documents_rich), ...parseDocs(sale.documents)];
  const images = propertyImages(sale.media).length;
  const visitDates = Array.isArray(sale.visit_dates) ? sale.visit_dates : [sale.visit_dates];
  const hasDatedVisit = visitDates.some(
    (value) => typeof value === "string" && publishedDay(value) !== null,
  );
  const surface = getSaleSurface(sale);
  const sourceText = informationAgentSourceText(sale);
  const hasDiagnosticDocument = documents.some((document) =>
    /(?:diagnostic|\bdpe\b|performance.nerg)/i.test(
      `${document.name ?? ""} ${document.type ?? ""} ${"document_type" in document ? (document.document_type ?? "") : ""}`,
    ),
  );

  addCriticalFactGap(gaps, "sale_date", facts.sale_date, Boolean(sale.sale_date));
  addCriticalFactGap(
    gaps,
    "starting_price_eur",
    facts.starting_price_eur,
    typeof sale.starting_price_eur === "number" && sale.starting_price_eur > 0,
  );

  if (!documents.length)
    addGap(gaps, "documents", "Aucune pièce consultable n'est rattachée à l'annonce.");
  if (images < 4)
    addGap(
      gaps,
      "photos",
      `${images} photo${images > 1 ? "s" : ""} exploitable${images > 1 ? "s" : ""} seulement.`,
    );
  if (!hasDatedVisit) addGap(gaps, "visit", "Aucune date de visite exploitable n'est publiée.");
  addCriticalFactGap(
    gaps,
    "occupancy_status",
    facts.occupancy_status,
    Boolean(sale.occupancy_status && !/^(?:unknown|inconnu)$/i.test(sale.occupancy_status)),
  );
  addCriticalFactGap(gaps, "surface", facts.surface, surface.value != null && !surface.estimated);
  if (!hasDiagnosticDocument) {
    addGap(
      gaps,
      "diagnostics",
      "Aucune pièce de diagnostic consultable n'est clairement identifiée.",
    );
  }
  if (sale.rooms_count == null && !/\b\d+\s*(?:pi[eè]ces?|chambres?)\b/i.test(sourceText)) {
    addGap(gaps, "composition", "Le nombre de pièces n'est pas confirmé.");
  }
  if (!hasVerifiedSaleTerms(sale)) {
    addGap(
      gaps,
      "sale_terms",
      "Les modalités de vente ne sont pas suffisamment étayées ou complètes.",
    );
  }

  return gaps;
}

export function buildInformationRequestDraft({
  sale,
  recipientName,
  questionKeys,
  facts,
  template = DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
}: {
  sale: AuctionSale;
  recipientName?: string | null;
  questionKeys: readonly InformationAgentQuestionKey[];
  facts?: FactReliabilityMap;
  template?: InformationAgentEmailTemplateContent;
}): { subject: string; bodyText: string } {
  const title = saleDisplayTitle(sale, "Vente immobilière");
  const location = [sale.postal_code, sale.city].filter(Boolean).join(" ");
  const hearing = formatDate(sale.sale_date);
  const hearingStatus = facts?.sale_date.status;
  const priceStatus = facts?.starting_price_eur.status;
  const reference = [title, location, sale.tribunal].filter(Boolean).join(" — ");
  const trimmedRecipientName = recipientName?.replace(/\s+/g, " ").trim();
  return renderInformationAgentEmailContent({
    template,
    values: {
      recipient_name: trimmedRecipientName || "Madame, Monsieur",
      salutation: trimmedRecipientName ? `Bonjour ${trimmedRecipientName},` : "Madame, Monsieur,",
      sale_title: title,
      sale_subject_title: shortenSubjectTitle(title),
      sale_reference: reference || title,
      location: location || "Localisation non précisée",
      tribunal: sale.tribunal || "Tribunal non précisé",
      hearing_date:
        hearingStatus === "conflict"
          ? "Date à confirmer"
          : hearing !== "Date à confirmer" && hearingStatus && hearingStatus !== "observed"
            ? `${hearing} (à confirmer)`
            : hearing,
      hearing_line:
        hearing === "Date à confirmer" || hearingStatus === "conflict"
          ? ""
          : hearingStatus && hearingStatus !== "observed"
            ? `Audience annoncée, à confirmer : ${hearing}`
            : `Audience annoncée : ${hearing}`,
      starting_price:
        priceStatus === "conflict" ||
        sale.starting_price_eur == null ||
        sale.starting_price_eur <= 0
          ? "Mise à prix à confirmer"
          : priceStatus && priceStatus !== "observed"
            ? `${formatPrice(sale.starting_price_eur)} (à confirmer)`
            : formatPrice(sale.starting_price_eur),
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
  const claimRead = await readSaleFactClaims(sale.id);
  const facts = getFactReliabilitiesFromClaims(sale, claimRead.claims);
  const gaps = detectInformationGaps(sale, facts);
  const defaultQuestions = selectDefaultInformationAgentQuestionKeys(gaps);
  const questionKeys = uniqueQuestionKeys(input.questionKeys ?? defaultQuestions);
  if (!questionKeys.length) {
    throw new Error(
      "Aucune lacune n'est identifiée pour cette annonce. Choisissez explicitement une question si une vérification reste nécessaire.",
    );
  }
  const contactCandidates = discoverInformationAgentContacts(sale);
  await persistInformationAgentContactObservations({
    saleId: sale.id,
    candidates: contactCandidates,
  });
  const selectedContact = selectInformationAgentContact(contactCandidates);
  const explicitRecipientEmail = normalizedEmail(input.recipientEmail);
  const recipientEmail = explicitRecipientEmail ?? selectedContact?.email;
  if (!recipientEmail) {
    throw new Error(
      contactCandidates.length > 1
        ? "Requête invalide : plusieurs contacts sont possibles. Choisissez explicitement l'adresse email du professionnel à contacter."
        : "Requête invalide : renseignez l'adresse email du professionnel à contacter.",
    );
  }
  await assertInformationAgentContactAllowed({ saleId: sale.id, email: recipientEmail });
  const selectedByEmail = contactCandidates.find((candidate) => candidate.email === recipientEmail);
  const recipientName = input.recipientName ?? selectedByEmail?.name ?? sale.lawyer_name;
  const draft = buildInformationRequestDraft({
    sale,
    recipientName,
    questionKeys,
    facts,
    template: emailTemplate.content,
  });

  const { data, error } = await supabaseAdmin
    .from("information_agent_missions")
    .insert({
      user_id: auth.userId,
      sale_id: sale.id,
      recipient_kind:
        selectedByEmail?.recipientKind ??
        (explicitRecipientEmail ? "manual_professional" : "source_contact"),
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
        draft_source: "admin_source_first_gap_analysis",
        fact_claims_checked: claimRead.claimsBacked,
        fact_claim_count: claimRead.claims.length,
        contact_discovery: {
          method: explicitRecipientEmail
            ? "admin_override"
            : selectedByEmail
              ? "source_data"
              : "manual_required",
          selected_email: selectedByEmail?.email ?? explicitRecipientEmail ?? null,
          candidates: contactCandidates.slice(0, 8).map(contactCandidateSnapshot),
        },
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
    contactCandidates,
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
  await assertInformationAgentContactAllowed({
    saleId: mission.sale_id,
    email: input.recipientEmail,
  });
  assertInformationAgentOutboundEnabled();
  assertInformationAgentCanaryRecipient(input.recipientEmail);

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
  const contributionUrl = informationAgentContributionUrl(subscribedMission);
  const messageHash = approvalFingerprint(subscribedMission);
  const approval = await approveInformationAgentMissionForAdmin(subscribedMission, messageHash);
  if (!approval) throw new Error("Approbation de l'enquête impossible.");
  if (!approval.should_send) return;

  const config = resolveInformationAgentEmailConfig();
  const replyTo = `enquete+${approval.inbound_token}@${config.inboundDomain}`;
  const sendingAt = new Date().toISOString();

  try {
    await assertInformationAgentContactAllowed({
      saleId: subscribedMission.sale_id,
      email: edited.recipient_email,
    });
    const renderedEmail = await renderInformationRequestEmail({
      subject: edited.subject,
      bodyText: edited.body_text,
      replyTo,
      caseReference: informationAgentCaseReference(approval.case_id),
      appUrl: config.appUrl,
      contributionUrl,
    });
    await assertInformationAgentContactAllowed({
      saleId: subscribedMission.sale_id,
      email: edited.recipient_email,
    });
    assertInformationAgentCanaryRecipient(edited.recipient_email);
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

export function assertInformationAgentOutboundEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (env.INFORMATION_AGENT_OUTBOUND_ENABLED !== "true") {
    throw new Error("Envoi de l’agent désactivé pendant la phase de validation.");
  }
}

/** Keep the first provider canary restricted to Resend's own delivery test address. */
export function assertInformationAgentCanaryRecipient(
  email: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.INFORMATION_AGENT_OUTBOUND_CANARY_ONLY === "false") return;
  if (email.trim().toLowerCase() !== "delivered@resend.dev") {
    throw new Error("Envoi limité à l'adresse de test du fournisseur pendant l'essai canari.");
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
  const sharedCase = await loadManualReplyCase(mission);
  const bodyText = input.bodyText.trim();
  const subject = (input.subject ?? `Re: ${mission.subject}`).slice(0, 200);
  const replyHash = createHash("sha256")
    .update(
      JSON.stringify({
        missionId: mission.id,
        caseId: sharedCase.id,
        subject,
        bodyText,
      }),
    )
    .digest("hex");
  const providerMessageId = `manual:${mission.id}:${replyHash}`;
  const receivedAt = new Date().toISOString();
  const message = await insertOrLoadManualReplyMessage({
    mission,
    sharedCase,
    providerMessageId,
    subject,
    bodyText,
    receivedAt,
  });
  const replyReceivedAt = message.received_at ?? receivedAt;

  const extractedFacts = extractInformationAgentFacts(replyTextForExtraction(bodyText));
  await persistFactCandidates({
    sharedCase,
    messageId: message.id,
    facts: extractedFacts,
    assets: [],
  });

  const caseUpdated = await updateManualReplyCase({
    sharedCase,
    hasReviewableEvidence: extractedFacts.length > 0,
    repliedAt: replyReceivedAt,
  });
  if (!caseUpdated) {
    throw new Error("Requête invalide : le dossier de cette enquête est déjà fermé.");
  }

  const updatedAt = new Date().toISOString();
  const { error: missionUpdateError } = await supabaseAdmin
    .from("information_agent_missions")
    .update({ status: "replied", replied_at: replyReceivedAt, updated_at: updatedAt })
    .eq("case_id", sharedCase.id)
    .in("status", ["sent", "subscribed", "replied"]);
  if (missionUpdateError) throw missionUpdateError;
}

const OPEN_INFORMATION_AGENT_CASE_STATUSES = ["sending", "sent", "replied", "review"] as const;

async function loadManualReplyCase(mission: MissionRow): Promise<CaseRow> {
  if (!mission.case_id || !mission.sale_id) {
    throw new Error("Requête invalide : l'enquête n'est pas rattachée à une vente.");
  }
  const { data: sharedCase, error } = await supabaseAdmin
    .from("information_agent_cases")
    .select("*")
    .eq("id", mission.case_id)
    .eq("sale_id", mission.sale_id)
    .maybeSingle();
  if (error) throw error;
  if (!sharedCase) {
    throw new Error("Requête invalide : dossier de vente introuvable ou incohérent.");
  }
  const { data: subscriber, error: subscriberError } = await supabaseAdmin
    .from("information_agent_case_subscribers")
    .select("case_id")
    .eq("case_id", sharedCase.id)
    .eq("user_id", mission.user_id)
    .maybeSingle();
  if (subscriberError) throw subscriberError;
  if (!subscriber) {
    throw new Error("Requête invalide : la mission n'est pas rattachée à ce dossier.");
  }
  if (!OPEN_INFORMATION_AGENT_CASE_STATUSES.some((status) => status === sharedCase.status)) {
    throw new Error("Requête invalide : le dossier de cette enquête est déjà fermé.");
  }
  return sharedCase;
}

async function updateManualReplyCase({
  sharedCase,
  hasReviewableEvidence,
  repliedAt,
}: {
  sharedCase: CaseRow;
  hasReviewableEvidence: boolean;
  repliedAt: string;
}): Promise<boolean> {
  const values = { replied_at: repliedAt, failure_reason: null } as const;
  const keepReview = hasReviewableEvidence || sharedCase.status === "review";
  if (keepReview) {
    const { data, error } = await supabaseAdmin
      .from("information_agent_cases")
      .update({ ...values, status: "review" })
      .eq("id", sharedCase.id)
      .eq("sale_id", sharedCase.sale_id)
      .in("status", ["sending", "sent", "replied", "review"])
      .select("id")
      .maybeSingle();
    if (error) throw error;
    return Boolean(data);
  }

  const { data: repliedCase, error: repliedError } = await supabaseAdmin
    .from("information_agent_cases")
    .update({ ...values, status: "replied" })
    .eq("id", sharedCase.id)
    .eq("sale_id", sharedCase.sale_id)
    .in("status", ["sending", "sent", "replied"])
    .select("id")
    .maybeSingle();
  if (repliedError) throw repliedError;
  if (repliedCase) return true;

  // Another reply may have moved the case to review after the snapshot above.
  // Preserve that stronger state instead of downgrading it to replied.
  const { data: currentCase, error: currentError } = await supabaseAdmin
    .from("information_agent_cases")
    .select("status")
    .eq("id", sharedCase.id)
    .maybeSingle();
  if (currentError) throw currentError;
  if (currentCase?.status !== "review") return false;

  const { data: preservedCase, error: preserveError } = await supabaseAdmin
    .from("information_agent_cases")
    .update({ replied_at: repliedAt })
    .eq("id", sharedCase.id)
    .eq("sale_id", sharedCase.sale_id)
    .eq("status", "review")
    .select("id")
    .maybeSingle();
  if (preserveError) throw preserveError;
  return Boolean(preservedCase);
}

async function insertOrLoadManualReplyMessage({
  mission,
  sharedCase,
  providerMessageId,
  subject,
  bodyText,
  receivedAt,
}: {
  mission: MissionRow;
  sharedCase: CaseRow;
  providerMessageId: string;
  subject: string;
  bodyText: string;
  receivedAt: string;
}): Promise<Database["public"]["Tables"]["information_agent_messages"]["Row"]> {
  const { data: existing, error: lookupError } = await supabaseAdmin
    .from("information_agent_messages")
    .select("*")
    .eq("provider_message_id", providerMessageId)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) {
    assertSameManualReply(existing, mission, sharedCase, subject, bodyText);
    return existing;
  }

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("information_agent_messages")
    .insert({
      mission_id: mission.id,
      case_id: sharedCase.id,
      user_id: mission.user_id,
      direction: "inbound",
      message_kind: "reply",
      delivery_status: "received",
      from_email: mission.recipient_email,
      to_email: mission.reply_to_email,
      subject,
      body_text: bodyText,
      provider_message_id: providerMessageId,
      received_at: receivedAt,
      metadata: {
        imported_manually: true,
        content_trust: "untrusted",
        channel: "admin_manual_reply",
        manual_reply_provider_id: providerMessageId,
      },
    })
    .select("*")
    .single();
  if (!insertError && inserted) return inserted;
  if (!insertError) throw new Error("Réponse manuelle impossible à enregistrer.");

  // A double click or concurrent admin request can win the unique provider
  // id between the lookup and insert. Reuse it only after rechecking every
  // dossier identity field; never merge two replies silently.
  if (insertError.code !== "23505") throw insertError;
  const { data: concurrent, error: concurrentError } = await supabaseAdmin
    .from("information_agent_messages")
    .select("*")
    .eq("provider_message_id", providerMessageId)
    .maybeSingle();
  if (concurrentError || !concurrent) throw insertError;
  assertSameManualReply(concurrent, mission, sharedCase, subject, bodyText);
  return concurrent;
}

function assertSameManualReply(
  message: Database["public"]["Tables"]["information_agent_messages"]["Row"],
  mission: MissionRow,
  sharedCase: CaseRow,
  subject: string,
  bodyText: string,
): void {
  if (
    message.mission_id !== mission.id ||
    message.case_id !== sharedCase.id ||
    message.user_id !== mission.user_id ||
    message.direction !== "inbound" ||
    message.message_kind !== "reply" ||
    message.delivery_status !== "received" ||
    message.subject !== subject ||
    message.body_text !== bodyText
  ) {
    throw new Error(
      "Requête invalide : cette réponse manuelle est déjà rattachée à un autre dossier.",
    );
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
  return { apiKey, from, inboundDomain, appUrl: informationAgentAppOrigin(env) };
}

/**
 * Keep links in supervised emails on the environment that initiated the send.
 * The production origin remains the safe fallback for legacy deployments that
 * have not declared SITE_URL yet.
 */
export function informationAgentAppOrigin(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return resolveSiteOrigin(env, "https://immojudis.com") ?? "https://immojudis.com";
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

function addGap(
  gaps: InformationAgentGap[],
  key: InformationAgentQuestionKey,
  reason: string,
  priority = QUESTION_PRIORITY[key].score,
) {
  gaps.push({
    key,
    label: INFORMATION_AGENT_QUESTIONS[key].label,
    reason,
    priority,
    blocking: QUESTION_PRIORITY[key].blocking,
  });
}

function uniqueQuestionKeys(keys: readonly InformationAgentQuestionKey[]) {
  return [...new Set(keys)].slice(0, 8);
}

function shortenSubjectTitle(title: string): string {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (normalized.length <= 70) return normalized;
  const prefix = normalized.slice(0, 69);
  const lastSpace = prefix.lastIndexOf(" ");
  return `${(lastSpace >= 40 ? prefix.slice(0, lastSpace) : prefix).trimEnd()}…`;
}

const QUESTION_FOR_FACT: Record<KeyFact, InformationAgentQuestionKey> = {
  sale_date: "sale_date",
  starting_price_eur: "starting_price_eur",
  surface: "surface",
  occupancy_status: "occupancy",
};

function addCriticalFactGap(
  gaps: InformationAgentGap[],
  field: KeyFact,
  fact: FactReliabilityMap[KeyFact],
  hasValue: boolean,
) {
  if (fact.status === "observed") return;
  const key = QUESTION_FOR_FACT[field];
  const reason =
    fact.status === "conflict"
      ? `${fact.label} : les sources se contredisent et doivent être départagées.`
      : !hasValue
        ? `${fact.label} n'est pas renseignée pour ce lot.`
        : fact.status === "inferred"
          ? `${fact.label} repose sur une estimation à confirmer.`
          : `${fact.label} est présente mais ne dispose pas encore d'une preuve validée.`;
  const adjustment: Record<Exclude<FactReliabilityStatus, "observed">, number> = {
    conflict: 40,
    inferred: 5,
    to_confirm: hasValue ? -25 : 10,
  };
  addGap(gaps, key, reason, QUESTION_PRIORITY[key].score + adjustment[fact.status]);
}

function hasVerifiedSaleTerms(sale: AuctionSale): boolean {
  const procedure = getSaleProcedure(sale).procedure;
  if (!procedure) return false;
  if (!["verified", "cross_checked"].includes(procedure.verification.status)) return false;
  if (!procedure.verification.case_sources.length) return false;
  const rules = procedure.rules;
  const hasBidMethod = Boolean(rules.bid_method.trim());
  const hasGuarantee =
    rules.guarantee.amount_eur != null ||
    rules.guarantee.rate_pct != null ||
    rules.guarantee.minimum_eur != null;
  const hasDeadline = rules.payment_deadline_days != null || rules.overbid.window_days != null;
  return hasBidMethod && hasGuarantee && hasDeadline;
}

/**
 * Finds contacts already present in the collected listing payload.
 *
 * This is deliberately source-data-only: it never performs a network lookup
 * and it keeps enough provenance for an admin to understand why a contact was
 * suggested before approving a request.
 */
export function discoverInformationAgentContacts(
  sale: AuctionSale,
): InformationAgentContactCandidate[] {
  const sourceName = cleanContactValue(sale.source_name ?? sale.primary_source);
  const sourceUrl = firstSourceUrl(sale);
  const observations: ContactObservation[] = [];

  addContactObservation(observations, {
    value: sale.lawyer_contact,
    kind: "sale_field",
    field: "lawyer_contact",
    sourceName,
    sourceUrl,
    name: cleanContactValue(sale.lawyer_name),
    score: 100,
  });

  collectSourceBlockContacts(
    observations,
    sale.source_blocks,
    "source_blocks",
    sourceName,
    sourceUrl,
  );
  collectSourceBlockContacts(
    observations,
    sale.source_blocks_by_source,
    "source_blocks_by_source",
    sourceName,
    sourceUrl,
  );

  addContactObservation(observations, {
    value: sale.source_description,
    kind: "source_text",
    field: "source_description",
    sourceName,
    sourceUrl,
    score: 42,
  });
  if (sale.description !== sale.source_description) {
    addContactObservation(observations, {
      value: sale.description,
      kind: "source_text",
      field: "description",
      sourceName,
      sourceUrl,
      score: 35,
    });
  }

  const byEmail = new Map<string, InformationAgentContactCandidate>();
  for (const observation of observations) {
    for (const email of extractEmails(observation.value)) {
      const role = inferContactRole(`${observation.field} ${observation.value}`);
      const score = observation.score + (role === "source_contact" ? 0 : 4);
      const provenance: InformationAgentContactProvenance = {
        kind: observation.kind,
        field: observation.field,
        sourceName: observation.sourceName,
        sourceUrl: observation.sourceUrl,
      };
      const current = byEmail.get(email);
      if (!current) {
        byEmail.set(email, {
          email,
          name: observation.name ?? null,
          role,
          recipientKind: role === "lawyer" ? "source_lawyer" : "source_contact",
          confidence: confidenceForContactScore(score),
          score,
          provenance: [provenance],
        });
        continue;
      }
      if (!current.provenance.some((item) => sameContactProvenance(item, provenance))) {
        current.provenance.push(provenance);
      }
      if (score > current.score) {
        current.score = score;
        current.confidence = confidenceForContactScore(score);
        current.role = role;
        current.recipientKind = role === "lawyer" ? "source_lawyer" : "source_contact";
      }
      if (!current.name && observation.name) current.name = observation.name;
    }
  }

  return [...byEmail.values()].sort(
    (left, right) => right.score - left.score || left.email.localeCompare(right.email),
  );
}

/**
 * Auto-selection is intentionally conservative. A tie between equally
 * plausible contacts must be resolved by an admin in the draft form.
 */
export function selectInformationAgentContact(
  candidates: readonly InformationAgentContactCandidate[],
): InformationAgentContactCandidate | null {
  const [first, second] = [...candidates].sort(
    (left, right) => right.score - left.score || left.email.localeCompare(right.email),
  );
  if (!first || first.confidence === "low") return null;
  if (second && first.score - second.score < 12) return null;
  return first;
}

/**
 * Returns whether a registry row blocks contact for the requested sale.
 * Global rows (scope_sale_id null) apply to every sale; sale-scoped rows keep
 * their original scope even after sale_id is nulled by retention. Unknown or
 * merely unverified rows remain contactable so the supervised workflow can
 * ask an admin to decide.
 */
export function isInformationAgentContactBlocked(
  row: InformationAgentContactRegistryBlock,
  saleId?: string | null,
): boolean {
  const appliesToSale = row.scope_sale_id === null || row.scope_sale_id === (saleId ?? null);
  return (
    appliesToSale && (row.opposition_status === "opposed" || row.bounce_status === "permanent")
  );
}

/**
 * Reads only the two registry scopes that can apply to this sale. Keeping the
 * scope predicates in PostgREST means a large number of unrelated sales can
 * never consume the response limit before a global opposition is returned.
 * A database error is intentionally propagated so an unavailable control
 * plane cannot turn into an implicit permission to contact someone.
 */
export async function loadInformationAgentContactRegistry(
  email: string,
  saleId?: string | null,
): Promise<InformationAgentContactRegistryBlock[]> {
  const normalized = normalizedEmail(email);
  if (!normalized) throw new Error("Adresse email du contact invalide.");

  const selectRegistryRows = () =>
    supabaseAdmin
      .from("information_agent_contacts")
      .select("scope_sale_id, opposition_status, bounce_status")
      .eq("normalized_email", normalized);

  const queries = [selectRegistryRows().is("scope_sale_id", null)];
  if (saleId !== null && saleId !== undefined) {
    queries.push(selectRegistryRows().eq("scope_sale_id", saleId));
  }

  const results = await Promise.all(queries);
  const rows: InformationAgentContactRegistryBlock[] = [];
  for (const { data, error } of results) {
    if (error) throw error;
    if (!data) throw new Error("Registre des contacts indisponible.");
    rows.push(...data);
  }
  return rows;
}

/**
 * Stores source observations without changing a row that is already in the
 * registry. In particular, a later scrape must never clear an opposition,
 * bounce, or verification decision made by an operator.
 */
export async function persistInformationAgentContactObservations({
  saleId,
  candidates,
}: {
  saleId: string;
  candidates: readonly InformationAgentContactCandidate[];
}): Promise<void> {
  const byEmail = new Map<string, InformationAgentContactCandidate>();
  for (const candidate of candidates) {
    const email = normalizedEmail(candidate.email);
    if (email && !byEmail.has(email)) byEmail.set(email, { ...candidate, email });
  }
  const observedAt = new Date().toISOString();
  const rows = [...byEmail.values()].map((candidate) => ({
    sale_id: saleId,
    scope_sale_id: saleId,
    email: candidate.email,
    display_name: candidate.name,
    role: candidate.role,
    provenance: candidate.provenance.map((item) => ({
      kind: item.kind,
      field: item.field,
      source_name: item.sourceName,
      source_url: item.sourceUrl,
    })),
    verification_status: "source_observed" as const,
    opposition_status: "unknown" as const,
    bounce_status: "none" as const,
    source_name: candidate.provenance.find((item) => item.sourceName)?.sourceName ?? null,
    source_url: candidate.provenance.find((item) => item.sourceUrl)?.sourceUrl ?? null,
    metadata: {
      observation_channel: "information_agent_draft",
      confidence: candidate.confidence,
      score: candidate.score,
    },
    last_seen_at: observedAt,
  }));
  if (!rows.length) return;
  const { error } = await supabaseAdmin.from("information_agent_contacts").upsert(rows, {
    onConflict: "scope_sale_id,normalized_email",
    ignoreDuplicates: true,
  });
  if (error) throw error;
}

/**
 * Guard used both when a draft chooses a recipient and immediately before
 * approval. It covers the race where a contact opts out or permanently
 * bounces after a draft was created.
 */
export async function assertInformationAgentContactAllowed({
  email,
  saleId,
}: {
  email: string;
  saleId?: string | null;
}): Promise<void> {
  const rows = await loadInformationAgentContactRegistry(email, saleId);
  if (rows.some((row) => isInformationAgentContactBlocked(row, saleId))) {
    throw new Error(
      "Le contact est explicitement opposé ou en rebond permanent ; aucune sollicitation n'est autorisée.",
    );
  }
}

type ContactObservation = {
  value: unknown;
  kind: InformationAgentContactProvenance["kind"];
  field: string;
  sourceName: string | null;
  sourceUrl: string | null;
  name?: string | null;
  score: number;
};

function collectSourceBlockContacts(
  observations: ContactObservation[],
  value: unknown,
  rootField: string,
  sourceName: string | null,
  sourceUrl: string | null,
) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectSourceBlockContacts(
        observations,
        item,
        `${rootField}[${index}]`,
        sourceName,
        sourceUrl,
      ),
    );
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const field = `${rootField}.${key}`;
    const childSourceName = rootField === "source_blocks_by_source" ? key : sourceName;
    if (typeof child === "string") {
      addContactObservation(observations, {
        value: child,
        kind: "source_block",
        field,
        sourceName: childSourceName,
        sourceUrl,
        name: inferNameFromSourceBlock(child, field),
        score: contactScoreForField(field),
      });
      continue;
    }
    collectSourceBlockContacts(observations, child, field, childSourceName, sourceUrl);
  }
}

function addContactObservation(
  observations: ContactObservation[],
  observation: ContactObservation,
) {
  if (typeof observation.value !== "string" || !observation.value.trim()) return;
  if (!extractEmails(observation.value).length) return;
  observations.push(observation);
}

function extractEmails(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [
    ...new Set(
      (value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [])
        .map(normalizedEmail)
        .filter((email): email is string => Boolean(email)),
    ),
  ];
}

function inferContactRole(value: string): InformationAgentContactRole {
  const normalized = stripDiacritics(value).toLowerCase();
  if (/avocat|lawyer|cabinet/.test(normalized)) return "lawyer";
  if (/notair|notary|etude/.test(normalized)) return "notary";
  if (/organisat|organizer|commissaire|vendeur/.test(normalized)) return "organizer";
  return "source_contact";
}

function inferNameFromSourceBlock(value: string, field: string): string | null {
  if (!/(?:nom|name|avocat|notaire|notary|organisateur|organizer)/i.test(field)) return null;
  const withoutEmail = value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, " ");
  const candidate = withoutEmail
    .replace(/[|,:;()[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return candidate.length >= 2 && candidate.length <= 180 ? candidate : null;
}

function contactScoreForField(field: string): number {
  const normalized = stripDiacritics(field).toLowerCase();
  if (/contact_avocat|lawyer_contact/.test(normalized)) return 96;
  if (/notair|notary/.test(normalized)) return 92;
  if (/organisat|organizer|commissaire/.test(normalized)) return 88;
  if (/(?:contact|email|mail)/.test(normalized)) return 76;
  return 52;
}

function confidenceForContactScore(score: number): InformationAgentContactCandidate["confidence"] {
  return score >= 90 ? "high" : score >= 70 ? "medium" : "low";
}

function sameContactProvenance(
  left: InformationAgentContactProvenance,
  right: InformationAgentContactProvenance,
): boolean {
  return (
    left.kind === right.kind &&
    left.field === right.field &&
    left.sourceName === right.sourceName &&
    left.sourceUrl === right.sourceUrl
  );
}

function contactCandidateSnapshot(candidate: InformationAgentContactCandidate): Json {
  return {
    email: candidate.email,
    name: candidate.name,
    role: candidate.role,
    recipient_kind: candidate.recipientKind,
    confidence: candidate.confidence,
    score: candidate.score,
    provenance: candidate.provenance.map((item) => ({
      kind: item.kind,
      field: item.field,
      source_name: item.sourceName,
      source_url: item.sourceUrl,
    })),
  };
}

function informationAgentSourceText(sale: AuctionSale): string {
  const values = [sale.title, sale.source_description, sale.description];
  values.push(JSON.stringify(sale.source_blocks ?? {}));
  values.push(JSON.stringify(sale.source_blocks_by_source ?? {}));
  return values.filter((value): value is string => typeof value === "string").join("\n");
}

function firstSourceUrl(sale: AuctionSale): string | null {
  const values: unknown[] = [sale.source_url, sale.source_urls];
  for (const value of values) {
    const candidate = firstUrl(value);
    if (candidate) return candidate;
  }
  return null;
}

function firstUrl(value: unknown): string | null {
  if (typeof value === "string") return safeSourceUrl(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = firstUrl(item);
      if (candidate) return candidate;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      const candidate = firstUrl(child);
      if (candidate) return candidate;
    }
  }
  return null;
}

function safeSourceUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return null;
  }
}

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function normalizedEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return z.string().email().safeParse(normalized).success ? normalized : null;
}

function cleanContactValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isQuestionKey(value: string): value is InformationAgentQuestionKey {
  return value in INFORMATION_AGENT_QUESTIONS;
}

function asObject(value: Json): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
