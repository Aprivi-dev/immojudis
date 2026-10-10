import "server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  INBOUND_ATTACHMENT_LINK_TTL_MS,
  INBOUND_PROCESSING_VERSION,
  type InboundMessageRef,
  type InboundProcessingState,
  type InformationAgentInboundResult,
  type Mission,
  OPEN_INFORMATION_AGENT_CASE_STATUSES,
  type SharedCase,
} from "@/lib/information-agent-inbound/types";
import { mergeJsonObject } from "@/lib/information-agent-inbound/text";
import {
  ensureInboundJobLease,
  type InboundJobLeaseGuard,
  type InboundLeaseFence,
} from "@/lib/information-agent-inbound/lease";
import type { InboundSenderAuthentication } from "@/lib/information-agent-inbound/sender-authentication";
import {
  addInboundLeaseFence,
  updateInboundMessageMetadata,
  updateInboundProcessingState,
} from "@/lib/information-agent-inbound/processing-state";

export async function updateInboundReplyCase({
  sharedCase,
  hasReviewableEvidence,
  expectedUpdatedAt,
  leaseFence,
  ...values
}: {
  sharedCase: SharedCase;
  hasReviewableEvidence: boolean;
  expectedUpdatedAt?: string;
  leaseFence?: InboundLeaseFence;
  replied_at: string;
  failure_reason: null;
  metadata: Json;
}): Promise<boolean> {
  const keepReview = hasReviewableEvidence || sharedCase.status === "review";
  const caseUpdatedAt = expectedUpdatedAt ?? sharedCase.updated_at;
  if (keepReview) {
    return updateOpenInformationAgentCase(
      sharedCase.id,
      {
        ...values,
        status: "review",
      },
      caseUpdatedAt,
      leaseFence,
    );
  }

  const repliedValues = {
    ...values,
    status: "replied" as const,
    ...(leaseFence ? { metadata: addInboundLeaseFence(values.metadata, leaseFence) } : {}),
  };
  let repliedQuery = supabaseAdmin
    .from("information_agent_cases")
    .update(repliedValues)
    .eq("id", sharedCase.id)
    .in("status", ["sending", "sent", "replied"]);
  if (caseUpdatedAt) repliedQuery = repliedQuery.eq("updated_at", caseUpdatedAt);
  const { data: repliedCase, error: repliedError } = await repliedQuery.select("id").maybeSingle();
  if (repliedError) throw repliedError;
  if (repliedCase) return true;

  // A concurrent response may have moved the case to review after the
  // snapshot above. Preserve that stronger state and update only its timing
  // metadata; never let this reply downgrade it back to replied.
  const { data: currentCase, error: currentError } = await supabaseAdmin
    .from("information_agent_cases")
    .select("status,updated_at,metadata")
    .eq("id", sharedCase.id)
    .maybeSingle();
  if (currentError) throw currentError;
  if (currentCase?.status !== "review") return false;

  let preserveQuery = supabaseAdmin
    .from("information_agent_cases")
    .update({
      replied_at: values.replied_at,
      ...(leaseFence ? { metadata: addInboundLeaseFence(currentCase.metadata, leaseFence) } : {}),
    })
    .eq("id", sharedCase.id)
    .eq("status", "review");
  if (currentCase.updated_at) {
    preserveQuery = preserveQuery.eq("updated_at", currentCase.updated_at);
  }
  const { data: preservedCase, error: preserveError } = await preserveQuery
    .select("id")
    .maybeSingle();
  if (preserveError) throw preserveError;
  return Boolean(preservedCase);
}

export async function updateOpenInformationAgentCase(
  caseId: string,
  values: Database["public"]["Tables"]["information_agent_cases"]["Update"],
  expectedUpdatedAt?: string,
  leaseFence?: InboundLeaseFence,
): Promise<boolean> {
  const fencedValues = leaseFence
    ? {
        ...values,
        metadata: addInboundLeaseFence(values.metadata ?? {}, leaseFence),
      }
    : values;
  let query = supabaseAdmin
    .from("information_agent_cases")
    .update(fencedValues)
    .eq("id", caseId)
    .in("status", [...OPEN_INFORMATION_AGENT_CASE_STATUSES]);
  if (expectedUpdatedAt) query = query.eq("updated_at", expectedUpdatedAt);
  const { data, error } = await query.select("id");
  if (error) throw error;
  return data?.some((row) => row.id === caseId) ?? false;
}

export async function ignoreIfCaseClosed(
  caseId: string,
  messageId: string,
  expectedLeaseId?: string,
): Promise<string | null> {
  const { data: currentCase, error: caseError } = await supabaseAdmin
    .from("information_agent_cases")
    .select("status")
    .eq("id", caseId)
    .single();
  if (caseError) throw caseError;
  if (["sending", "sent", "replied", "review"].includes(currentCase.status)) return null;

  const { data: message, error: messageError } = await supabaseAdmin
    .from("information_agent_messages")
    .select("metadata")
    .eq("id", messageId)
    .single();
  if (messageError) throw messageError;
  const nextMetadata = mergeJsonObject(message.metadata, {
    processing_ignored_case_status: currentCase.status,
  });
  await updateInboundMessageMetadata(messageId, message.metadata, nextMetadata, expectedLeaseId);
  return currentCase.status;
}

async function recordInboundContactOptOut(email: string, opposedAt: string): Promise<void> {
  const { error } = await supabaseAdmin.from("information_agent_contacts").upsert(
    {
      sale_id: null,
      scope_sale_id: null,
      email,
      opposition_status: "opposed",
      opposed_at: opposedAt,
    },
    { onConflict: "scope_sale_id,normalized_email" },
  );
  if (error) throw error;
}

export async function finalizeInboundContactOptOut({
  sharedCase,
  messageId,
  providerEmailId,
  receivedAt,
  senderEmail,
  inboundMetadata,
  processing,
  leaseFence,
  leaseId,
  assertJobLease,
}: {
  sharedCase: SharedCase;
  messageId: string;
  providerEmailId: string;
  receivedAt: string;
  senderEmail: string;
  inboundMetadata: Json;
  processing: InboundProcessingState | null;
  leaseFence?: InboundLeaseFence;
  leaseId?: string;
  assertJobLease?: InboundJobLeaseGuard;
}): Promise<InformationAgentInboundResult> {
  await ensureInboundJobLease(assertJobLease);
  await recordInboundContactOptOut(senderEmail, receivedAt);
  const caseUpdated = await updateOpenInformationAgentCase(
    sharedCase.id,
    {
      status: "review",
      replied_at: receivedAt,
      metadata: mergeJsonObject(sharedCase.metadata, {
        last_inbound_email_id: providerEmailId,
        last_inbound_contact_opposed: true,
        last_inbound_contact_opposed_at: receivedAt,
      }),
    },
    sharedCase.updated_at,
    leaseFence,
  );
  await updateInboundProcessingState(
    messageId,
    inboundMetadata,
    {
      status: "review",
      attempts: processing?.attempts ?? 0,
      providerEmailId,
      queuedAt: processing?.queuedAt ?? receivedAt,
      reason: caseUpdated ? "contact_opposed" : "case_closed_during_processing",
    },
    leaseId,
  );
  return {
    accepted: true,
    caseId: sharedCase.id,
    messageId,
    factCount: 0,
    attachmentCount: 0,
    processingStatus: "review",
  };
}

export async function loadInitiatorMission(sharedCase: SharedCase): Promise<Mission> {
  let query = supabaseAdmin.from("information_agent_missions").select("*");
  query = sharedCase.initiator_mission_id
    ? query.eq("id", sharedCase.initiator_mission_id)
    : query.eq("case_id", sharedCase.id).order("created_at", { ascending: true }).limit(1);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Mission initiatrice du dossier introuvable.");
  return data;
}

export async function insertOrLoadInboundMessage({
  sharedCase,
  mission,
  providerMessageId,
  from,
  to,
  subject,
  bodyText,
  receivedAt,
  senderMatches,
  senderAuthentication,
  providerMessageIdHeader,
  receivedFor,
}: {
  sharedCase: SharedCase;
  mission: Mission;
  providerMessageId: string;
  from: string;
  to: string;
  subject: string;
  bodyText: string;
  receivedAt: string;
  senderMatches: boolean;
  senderAuthentication: InboundSenderAuthentication;
  providerMessageIdHeader?: string;
  receivedFor: string[];
}): Promise<InboundMessageRef> {
  const id = randomUUID();
  const queuedAt = new Date().toISOString();
  const metadata: Json = {
    imported_manually: false,
    content_trust: "untrusted",
    sender_matches_recipient: senderMatches,
    sender_authentication: senderAuthentication,
    ...(providerMessageIdHeader ? { rfc_message_id: providerMessageIdHeader } : {}),
    ...(receivedFor.length ? { received_for: receivedFor.slice(0, 20) } : {}),
    inbound_processing: {
      version: INBOUND_PROCESSING_VERSION,
      status: "queued",
      attempts: 0,
      provider_email_id: providerMessageId,
      queued_at: queuedAt,
      attachment_link_expires_at: new Date(
        Date.parse(receivedAt) + INBOUND_ATTACHMENT_LINK_TTL_MS,
      ).toISOString(),
    },
  };
  const { error } = await supabaseAdmin.from("information_agent_messages").insert({
    id,
    case_id: sharedCase.id,
    mission_id: mission.id,
    user_id: mission.user_id,
    direction: "inbound",
    message_kind: "reply",
    delivery_status: "received",
    from_email: from,
    to_email: to,
    subject: subject.slice(0, 200),
    body_text: bodyText,
    provider_message_id: providerMessageId,
    received_at: receivedAt,
    metadata,
  });
  if (!error) return { id, duplicate: false, metadata };

  const { data: existing, error: existingError } = await supabaseAdmin
    .from("information_agent_messages")
    .select("id,case_id,metadata")
    .eq("provider_message_id", providerMessageId)
    .maybeSingle();
  if (existingError || !existing) throw error;
  if (existing.case_id !== sharedCase.id) {
    throw new Error("Message entrant déjà rattaché à un autre dossier.");
  }
  // A replay must not write a stale metadata snapshot over a worker's newer
  // processing checkpoint. Authentication was recorded on the first receipt;
  // the current provider result is checked during every active replay.
  return { id: existing.id, duplicate: true, metadata: existing.metadata ?? {} };
}
