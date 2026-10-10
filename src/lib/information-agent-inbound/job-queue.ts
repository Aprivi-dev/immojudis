import "server-only";
import type { EmailReceivedEvent } from "resend";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { INBOUND_ATTACHMENT_LINK_TTL_MS } from "@/lib/information-agent-inbound/types";
import { jsonObject, mergeJsonObject } from "@/lib/information-agent-inbound/text";
import { InformationAgentInboundLeaseLostError } from "@/lib/information-agent-inbound/lease";
import {
  inboundProcessingState,
  updateInboundMessageMetadata,
  updateInboundProcessingState,
} from "@/lib/information-agent-inbound/processing-state";

export async function markInboundMessageIgnored({
  messageId,
  providerEmailId,
  queuedAt,
  caseStatus,
  leaseId,
}: {
  messageId: string;
  providerEmailId: string;
  queuedAt: string;
  caseStatus: string;
  leaseId?: string;
}) {
  const { data: message, error } = await supabaseAdmin
    .from("information_agent_messages")
    .select("metadata")
    .eq("id", messageId)
    .maybeSingle();
  if (error) throw error;
  if (!message) throw new Error("Message entrant à ignorer introuvable.");
  const previous = inboundProcessingState(message.metadata ?? {});
  await updateInboundProcessingState(
    messageId,
    mergeJsonObject(message.metadata ?? {}, {
      processing_ignored_case_status: caseStatus,
    }),
    {
      status: "ignored",
      attempts: previous?.attempts ?? 0,
      providerEmailId,
      queuedAt: previous?.queuedAt ?? queuedAt,
      reason: "case_closed",
    },
    leaseId,
  );
}

export function replayEventForInboundJob(
  job: Database["public"]["Tables"]["information_agent_inbound_jobs"]["Row"],
  inboundToken: string,
  inboundDomain: string,
): EmailReceivedEvent {
  const address = `enquete+${inboundToken}@${inboundDomain}`;
  return {
    type: "email.received",
    created_at: job.created_at,
    data: {
      email_id: job.provider_email_id,
      created_at: job.created_at,
      from: "",
      to: [address],
      bcc: [],
      cc: [],
      received_for: [address],
      message_id: job.provider_email_id,
      subject: "",
      attachments: [],
    },
  };
}

export async function renewInformationAgentInboundJobLease(
  job: Database["public"]["Tables"]["information_agent_inbound_jobs"]["Row"],
  now: Date,
): Promise<boolean> {
  if (!job.lease_id) return false;
  const timestamp = now.toISOString();
  const { data, error } = await supabaseAdmin
    .from("information_agent_inbound_jobs")
    .update({ locked_at: timestamp, updated_at: timestamp })
    .eq("id", job.id)
    .eq("lease_id", job.lease_id)
    .eq("status", "processing")
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return Boolean(data?.id);
}

export async function settleInformationAgentInboundJob(
  job: Database["public"]["Tables"]["information_agent_inbound_jobs"]["Row"],
  status: "completed" | "review" | "ignored",
): Promise<boolean> {
  if (!job.lease_id) return false;
  if (!(await releaseInboundMessageLease(job))) return false;
  const { data, error } = await supabaseAdmin
    .from("information_agent_inbound_jobs")
    .update({
      status,
      locked_at: null,
      lease_id: null,
      last_error: null,
    })
    .eq("id", job.id)
    .eq("lease_id", job.lease_id)
    .eq("status", "processing")
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return Boolean(data?.id);
}

export async function failInformationAgentInboundJob(
  job: Database["public"]["Tables"]["information_agent_inbound_jobs"]["Row"],
  errorMessage: string,
  now: Date,
): Promise<boolean> {
  if (!job.lease_id) return false;
  if (!(await releaseInboundMessageLease(job))) return false;
  const delayMs = Math.min(10 * 60 * 1000, 30 * 1000 * 2 ** Math.max(0, job.attempts - 1));
  const terminalReview = job.attempts >= 10;
  const { data, error } = await supabaseAdmin
    .from("information_agent_inbound_jobs")
    .update({
      // Ten attempts is the retry budget. Keep the message visible for an
      // operator instead of leaving an unclaimable failed row that looks
      // retryable but can never run again.
      status: terminalReview ? "review" : "failed",
      available_at: new Date(now.getTime() + delayMs).toISOString(),
      locked_at: null,
      lease_id: null,
      last_error: errorMessage,
    })
    .eq("id", job.id)
    .eq("lease_id", job.lease_id)
    .eq("status", "processing")
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return Boolean(data?.id);
}

/**
 * Clear the message-side fence before releasing a job lease. The nested lease
 * condition makes this safe if another worker already reclaimed the job: that
 * worker's lease has replaced the message checkpoint and this update returns
 * no row, so the old worker cannot publish a terminal checkpoint.
 */
async function releaseInboundMessageLease(
  job: Database["public"]["Tables"]["information_agent_inbound_jobs"]["Row"],
): Promise<boolean> {
  if (!job.lease_id) return false;
  const { data: message, error } = await supabaseAdmin
    .from("information_agent_messages")
    .select("metadata")
    .eq("id", job.message_id)
    .maybeSingle();
  if (error) throw error;
  if (!message) return false;
  const currentProcessing = inboundProcessingState(message.metadata ?? {});
  if (currentProcessing?.leaseId !== job.lease_id) return false;
  const nextProcessing = {
    ...jsonObject(jsonObject(message.metadata).inbound_processing),
    lease_id: null,
  } as Record<string, Json>;
  try {
    await updateInboundMessageMetadata(
      job.message_id,
      message.metadata ?? {},
      mergeJsonObject(message.metadata ?? {}, { inbound_processing: nextProcessing }),
      job.lease_id,
    );
  } catch (error) {
    if (error instanceof InformationAgentInboundLeaseLostError) return false;
    throw error;
  }
  return true;
}

export async function enqueueInformationAgentInboundJob({
  messageId,
  caseId,
  providerEmailId,
  receivedAt,
}: {
  messageId: string;
  caseId: string;
  providerEmailId: string;
  receivedAt: string;
}) {
  const expiresAt = new Date(Date.parse(receivedAt) + INBOUND_ATTACHMENT_LINK_TTL_MS);
  if (!Number.isFinite(expiresAt.getTime())) {
    throw new Error("Date de réception email invalide.");
  }
  const { error } = await supabaseAdmin.from("information_agent_inbound_jobs").upsert(
    {
      message_id: messageId,
      case_id: caseId,
      provider_email_id: providerEmailId,
      status: "queued",
      available_at: new Date().toISOString(),
      attachment_link_expires_at: expiresAt.toISOString(),
    },
    { onConflict: "provider_email_id", ignoreDuplicates: true },
  );
  if (error) throw error;
}
