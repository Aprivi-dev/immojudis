import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
  INBOUND_PROCESSING_VERSION,
  type InboundProcessingState,
} from "@/lib/information-agent-inbound/types";
import {
  asOptionalString,
  jsonObject,
  mergeJsonObject,
} from "@/lib/information-agent-inbound/text";
import {
  type InboundLeaseFence,
  InformationAgentInboundLeaseLostError,
} from "@/lib/information-agent-inbound/lease";

export async function updateInboundProcessingState(
  messageId: string,
  currentMetadata: Json,
  patch: {
    status: InboundProcessingState["status"];
    attempts: number;
    providerEmailId: string;
    queuedAt: string;
    startedAt?: string;
    completedAt?: string;
    failedAt?: string;
    attachmentLinkExpiresAt?: string;
    nextAttemptAt?: string;
    lastError?: string;
    reason?: string;
  },
  expectedLeaseId?: string,
): Promise<Json> {
  const previous = inboundProcessingState(currentMetadata);
  if (!expectedLeaseId && previous?.leaseId) {
    throw new InformationAgentInboundLeaseLostError();
  }
  const state: Record<string, Json> = {
    version: previous?.version ?? INBOUND_PROCESSING_VERSION,
    status: patch.status,
    attempts: Math.max(0, Math.min(10, Math.trunc(patch.attempts))),
    provider_email_id: patch.providerEmailId,
    queued_at: previous?.queuedAt ?? patch.queuedAt,
  };
  if (expectedLeaseId) state.lease_id = expectedLeaseId;
  const optionalValues: Array<[string, string | undefined]> = [
    ["started_at", patch.startedAt ?? previous?.startedAt],
    ["completed_at", patch.completedAt],
    ["failed_at", patch.failedAt],
    [
      "attachment_link_expires_at",
      patch.attachmentLinkExpiresAt ?? previous?.attachmentLinkExpiresAt,
    ],
    ["next_attempt_at", patch.nextAttemptAt],
    ["last_error", patch.lastError],
    ["reason", patch.reason],
  ];
  for (const [key, value] of optionalValues) {
    if (value) state[key] = value;
  }
  const nextMetadata = mergeJsonObject(currentMetadata, { inbound_processing: state });
  await updateInboundMessageMetadata(messageId, currentMetadata, nextMetadata, expectedLeaseId);
  return nextMetadata;
}

/**
 * Update an inbound message only while this worker still holds its lease.
 * Queue claims replace the lease in the same database statement as the job
 * claim, so the JSONB lease predicate fences each checkpoint at write time.
 */
export async function updateInboundMessageMetadata(
  messageId: string,
  currentMetadata: Json,
  nextMetadata: Json,
  expectedLeaseId?: string,
): Promise<void> {
  if (!expectedLeaseId && inboundProcessingState(currentMetadata)?.leaseId) {
    throw new InformationAgentInboundLeaseLostError();
  }
  const query = supabaseAdmin
    .from("information_agent_messages")
    .update({ metadata: nextMetadata })
    .eq("id", messageId);
  if (!expectedLeaseId) {
    const { error } = await query;
    if (error) throw error;
    return;
  }

  const { data, error } = await query
    .eq("metadata->inbound_processing->>lease_id", expectedLeaseId)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data?.id) throw new InformationAgentInboundLeaseLostError();
}

export function addInboundLeaseFence(metadata: Json, leaseFence: InboundLeaseFence): Json {
  return mergeJsonObject(metadata, {
    inbound_lease_id: leaseFence.leaseId,
    inbound_message_id: leaseFence.messageId,
  });
}

export function inboundProcessingState(metadata: Json): InboundProcessingState | null {
  const object = jsonObject(metadata);
  const raw = jsonObject(object.inbound_processing);
  const status = raw.status;
  const attempts = raw.attempts;
  const providerEmailId = raw.provider_email_id;
  const queuedAt = raw.queued_at;
  if (
    !isInboundProcessingStatus(status) ||
    typeof attempts !== "number" ||
    !Number.isFinite(attempts) ||
    typeof providerEmailId !== "string" ||
    typeof queuedAt !== "string"
  ) {
    return null;
  }
  return {
    version: typeof raw.version === "string" ? raw.version : INBOUND_PROCESSING_VERSION,
    status,
    attempts,
    providerEmailId,
    queuedAt,
    leaseId: asOptionalString(raw.lease_id),
    startedAt: asOptionalString(raw.started_at),
    completedAt: asOptionalString(raw.completed_at),
    failedAt: asOptionalString(raw.failed_at),
    attachmentLinkExpiresAt: asOptionalString(raw.attachment_link_expires_at),
    nextAttemptAt: asOptionalString(raw.next_attempt_at),
    lastError: asOptionalString(raw.last_error),
    reason: asOptionalString(raw.reason),
  };
}

function isInboundProcessingStatus(
  value: Json | undefined,
): value is InboundProcessingState["status"] {
  return (
    value === "queued" ||
    value === "processing" ||
    value === "completed" ||
    value === "failed" ||
    value === "review" ||
    value === "ignored"
  );
}
