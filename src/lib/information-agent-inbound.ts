import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { Resend, type AttachmentData, type EmailReceivedEvent } from "resend";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { z } from "zod";
import {
  INBOUND_ATTACHMENT_LINK_TTL_MS,
  INBOUND_PROCESSING_VERSION,
  type InboundMessageRef,
  type InboundProcessingState,
  type InformationAgentInboundResult,
  type Mission,
  OPEN_INFORMATION_AGENT_CASE_STATUSES,
  optionalText,
  type SharedCase,
} from "@/lib/information-agent-inbound/types";
import {
  boundedInboundError,
  cleanInboundBody,
  jsonObject,
  mergeJsonObject,
  normalizeEmail,
  replyTextForExtraction,
  requiredHeader,
  safeFilename,
  stringArray,
} from "@/lib/information-agent-inbound/text";
import {
  ensureInboundJobLease,
  type InboundJobLeaseGuard,
  type InboundLeaseFence,
  InformationAgentInboundLeaseLostError,
} from "@/lib/information-agent-inbound/lease";
import {
  inboundReviewReason,
  type InboundSenderAuthentication,
  normalizeInboundSenderAuthentication,
} from "@/lib/information-agent-inbound/sender-authentication";
import {
  classifyInformationAgentReplyIntent,
  collectInboundTokens,
  detectInformationAgentContactOptOut,
  findInboundToken,
} from "@/lib/information-agent-inbound/reply-intent";
import {
  addInboundLeaseFence,
  inboundProcessingState,
  updateInboundMessageMetadata,
  updateInboundProcessingState,
} from "@/lib/information-agent-inbound/processing-state";
import {
  conflictsWithSale,
  type ExtractedInformationAgentFact,
  extractInformationAgentFacts,
} from "@/lib/information-agent-inbound/fact-extraction";

export { extractInformationAgentFacts } from "@/lib/information-agent-inbound/fact-extraction";
export type { ExtractedInformationAgentFact } from "@/lib/information-agent-inbound/fact-extraction";

export {
  findInboundToken,
  detectInformationAgentContactOptOut,
  classifyInformationAgentReplyIntent,
} from "@/lib/information-agent-inbound/reply-intent";
export type { InformationAgentReplyIntent } from "@/lib/information-agent-inbound/reply-intent";

export {
  replyTextForExtraction,
  htmlToPlainText,
  normalizeEmail,
} from "@/lib/information-agent-inbound/text";

export type { InformationAgentInboundResult } from "@/lib/information-agent-inbound/types";

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024;
const MAX_LISTED_ATTACHMENTS = 500;
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "text/plain",
]);
const ATTACHMENT_MIME_ALIASES: Record<string, string> = {
  "application/acrobat": "application/pdf",
  "application/octet-stream": "",
  "application/pdf": "application/pdf",
  "application/x-pdf": "application/pdf",
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "text/csv": "text/plain",
  "text/markdown": "text/plain",
};
const ATTACHMENT_EXTENSION_MIME_TYPES: Record<string, string> = {
  ".csv": "text/plain",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".md": "text/plain",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain",
  ".webp": "image/webp",
};

/**
 * Provider fields the Resend SDK types do not (reliably) expose. Every field is
 * read leniently: a missing or malformed value degrades to an empty one exactly
 * as the previous ad-hoc casts did, and never rejects the whole delivery.
 */
const receivedEmailExtrasSchema = z.object({
  to: z.unknown().transform((value) => stringArray(value)),
  received_for: z.unknown().transform((value) => stringArray(value)),
  authentication: z.unknown(),
  message_id: optionalText,
});

const providerMessageIdSchema = z.object({ message_id: optionalText });

const inboundAttachmentSchema = z.object({
  id: optionalText,
  filename: optionalText,
  content_type: optionalText,
  size: z
    .unknown()
    .transform((value) =>
      typeof value === "number" && Number.isSafeInteger(value) ? value : null,
    ),
  download_url: optionalText,
  content_disposition: optionalText,
  content_id: optionalText,
});

type ReceivedEmailExtras = z.infer<typeof receivedEmailExtrasSchema>;
type InboundAttachmentFields = z.infer<typeof inboundAttachmentSchema>;

function parseReceivedEmailExtras(received: unknown): ReceivedEmailExtras {
  const parsed = receivedEmailExtrasSchema.safeParse(received);
  return parsed.success
    ? parsed.data
    : { to: [], received_for: [], authentication: undefined, message_id: null };
}

function parseProviderMessageId(data: unknown): string | null {
  const parsed = providerMessageIdSchema.safeParse(data);
  return parsed.success ? parsed.data.message_id : null;
}

function parseInboundAttachment(attachment: unknown): InboundAttachmentFields {
  const parsed = inboundAttachmentSchema.safeParse(attachment);
  return parsed.success
    ? parsed.data
    : {
        id: null,
        filename: null,
        content_type: null,
        size: null,
        download_url: null,
        content_disposition: null,
        content_id: null,
      };
}

export class InvalidInformationAgentWebhookSignatureError extends Error {
  constructor() {
    super("Signature webhook invalide.");
    this.name = "InvalidInformationAgentWebhookSignatureError";
  }
}

export class InformationAgentWebhookPayloadTooLargeError extends Error {
  constructor() {
    super("Corps du webhook trop volumineux.");
    this.name = "InformationAgentWebhookPayloadTooLargeError";
  }
}

type StoredInboundEvidenceAsset = {
  id: string;
  filename: string;
  mimeType: string;
  storagePath: string;
  size: number;
};

export async function processInformationAgentInboundWebhook({
  request,
  env = process.env,
  fetchImpl = fetch,
  deferProcessing = false,
}: {
  request: Request;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Persist the verified receipt and let the cron worker process attachments. */
  deferProcessing?: boolean;
}): Promise<InformationAgentInboundResult> {
  const apiKey = env.RESEND_API_KEY?.trim();
  const webhookSecret = env.RESEND_WEBHOOK_SECRET?.trim();
  const inboundDomain = env.INFORMATION_AGENT_INBOUND_DOMAIN?.trim().toLowerCase();
  if (!apiKey || !webhookSecret || !inboundDomain) {
    throw new Error("Configuration de réception de l’agent incomplète.");
  }

  const rawPayload = await readBoundedWebhookBody(request);
  const resend = new Resend(apiKey);
  let event: ReturnType<typeof resend.webhooks.verify>;
  try {
    event = resend.webhooks.verify({
      payload: rawPayload,
      headers: {
        id: requiredHeader(request, "svix-id"),
        timestamp: requiredHeader(request, "svix-timestamp"),
        signature: requiredHeader(request, "svix-signature"),
      },
      webhookSecret,
    });
  } catch {
    throw new InvalidInformationAgentWebhookSignatureError();
  }
  if (event.type !== "email.received") return { accepted: true, ignored: true };

  return ingestReceivedEmail({
    event,
    resend,
    inboundDomain,
    fetchImpl,
    deferProcessing,
  });
}

async function ingestReceivedEmail({
  event,
  resend,
  inboundDomain,
  fetchImpl,
  assertJobLease,
  leaseId,
  deferProcessing = false,
}: {
  event: EmailReceivedEvent;
  resend: Resend;
  inboundDomain: string;
  fetchImpl: typeof fetch;
  assertJobLease?: InboundJobLeaseGuard;
  leaseId?: string;
  deferProcessing?: boolean;
}): Promise<InformationAgentInboundResult> {
  const token = findInboundToken([...event.data.to, ...event.data.received_for], inboundDomain);
  if (!token) return { accepted: true, ignored: true };

  const { data: sharedCase, error: caseError } = await supabaseAdmin
    .from("information_agent_cases")
    .select("*")
    .eq("inbound_token", token)
    .maybeSingle();
  if (caseError) throw caseError;
  if (!sharedCase) return { accepted: true, ignored: true };
  if (!["sending", "sent", "replied", "review"].includes(sharedCase.status)) {
    return { accepted: true, ignored: true };
  }

  const mission = await loadInitiatorMission(sharedCase);
  const { data: received, error: receiveError } = await resend.emails.receiving.get(
    event.data.email_id,
    { html_format: "cid" },
  );
  if (receiveError || !received) {
    throw new Error(receiveError?.message || "Email entrant Resend introuvable.");
  }
  const receivedExtras = parseReceivedEmailExtras(received);
  const receivedTo = receivedExtras.to;
  const receivedFor = receivedExtras.received_for;
  const receivedTokens = collectInboundTokens([...receivedTo, ...receivedFor], inboundDomain);
  if (receivedTokens.length > 1 || (receivedTokens.length === 1 && receivedTokens[0] !== token)) {
    return { accepted: true, ignored: true };
  }

  const bodyText = cleanInboundBody(received.text, received.html);
  const receivedAt = received.created_at || event.created_at;
  const senderEmail = normalizeEmail(received.from);
  const expectedRecipientEmail = normalizeEmail(sharedCase.normalized_recipient_email);
  const senderMatches = Boolean(
    senderEmail && expectedRecipientEmail && senderEmail === expectedRecipientEmail,
  );
  const senderAuthentication = normalizeInboundSenderAuthentication(receivedExtras.authentication);
  await ensureInboundJobLease(assertJobLease);
  const inboundMessage = await insertOrLoadInboundMessage({
    sharedCase,
    mission,
    providerMessageId: event.data.email_id,
    from: received.from,
    to: receivedTo.join(", "),
    subject: received.subject || `Re: ${sharedCase.subject}`,
    bodyText,
    receivedAt,
    senderMatches,
    senderAuthentication,
    providerMessageIdHeader:
      receivedExtras.message_id ?? parseProviderMessageId(event.data) ?? undefined,
    receivedFor,
  });
  const messageId = inboundMessage.id;
  const leaseFence = leaseId ? { leaseId, messageId } : undefined;
  // A worker may fetch a more complete provider result than the initial
  // receipt. Carry it into the next processing-state write without issuing a
  // separate stale-snapshot update for a duplicate delivery.
  let inboundMetadata = inboundMessage.duplicate
    ? mergeJsonObject(inboundMessage.metadata, {
        sender_matches_recipient: senderMatches,
        sender_authentication: senderAuthentication,
      })
    : inboundMessage.metadata;
  if (inboundMessage.duplicate && leaseId) {
    await updateInboundMessageMetadata(
      messageId,
      inboundMessage.metadata,
      inboundMetadata,
      leaseId,
    );
  }
  const existingProcessing = inboundProcessingState(inboundMetadata);
  const terminalStatus =
    existingProcessing?.status === "completed" ||
    existingProcessing?.status === "review" ||
    existingProcessing?.status === "ignored"
      ? existingProcessing.status
      : null;
  if (inboundMessage.duplicate && terminalStatus) {
    return {
      accepted: true,
      duplicate: true,
      caseId: sharedCase.id,
      messageId,
      processingStatus: terminalStatus,
    };
  }
  if (inboundMessage.duplicate && existingProcessing?.leaseId && !assertJobLease) {
    // A webhook replay must not bypass the queue worker's fenced checkpoint.
    // The durable job owns the active lease and will publish the next state.
    return {
      accepted: true,
      duplicate: true,
      caseId: sharedCase.id,
      messageId,
      processingStatus: "queued",
    };
  }

  const reviewReason = inboundReviewReason({
    senderMatches,
    senderAuthentication,
  });
  const contactOptOut = Boolean(
    senderEmail &&
    senderMatches &&
    senderAuthentication.status === "pass" &&
    detectInformationAgentContactOptOut(bodyText),
  );

  if (deferProcessing) {
    const initialClosedStatus = await ignoreIfCaseClosed(sharedCase.id, messageId, leaseId);
    if (initialClosedStatus) {
      inboundMetadata = mergeJsonObject(inboundMetadata, {
        processing_ignored_case_status: initialClosedStatus,
      });
      await updateInboundProcessingState(
        messageId,
        inboundMetadata,
        {
          status: "ignored",
          attempts: existingProcessing?.attempts ?? 0,
          providerEmailId: event.data.email_id,
          queuedAt: existingProcessing?.queuedAt ?? receivedAt,
          reason: "case_closed",
        },
        leaseId,
      );
      return {
        accepted: true,
        caseId: sharedCase.id,
        messageId,
        factCount: 0,
        attachmentCount: 0,
        processingStatus: "ignored",
      };
    }

    if (contactOptOut && senderEmail) {
      return finalizeInboundContactOptOut({
        sharedCase,
        messageId,
        providerEmailId: event.data.email_id,
        receivedAt,
        senderEmail,
        inboundMetadata,
        processing: existingProcessing,
        leaseFence,
        leaseId,
        assertJobLease,
      });
    }

    // The case address is a routing key, not proof that the sender or the
    // provider's authentication result is safe for automatic extraction.
    if (reviewReason) {
      await ensureInboundJobLease(assertJobLease);
      const caseUpdated = await updateOpenInformationAgentCase(
        sharedCase.id,
        {
          status: "review",
          replied_at: receivedAt,
          metadata: mergeJsonObject(sharedCase.metadata, {
            last_inbound_email_id: event.data.email_id,
            last_inbound_sender_matches_recipient: senderMatches,
            last_inbound_sender_authentication_status: senderAuthentication.status,
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
          attempts: existingProcessing?.attempts ?? 0,
          providerEmailId: event.data.email_id,
          queuedAt: existingProcessing?.queuedAt ?? receivedAt,
          reason: caseUpdated ? reviewReason : "case_closed_during_processing",
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

    if (!inboundMessage.duplicate) {
      await updateInboundProcessingState(
        messageId,
        inboundMetadata,
        {
          status: "queued",
          attempts: existingProcessing?.attempts ?? 0,
          providerEmailId: event.data.email_id,
          queuedAt: existingProcessing?.queuedAt ?? receivedAt,
          attachmentLinkExpiresAt: new Date(
            Date.parse(receivedAt) + INBOUND_ATTACHMENT_LINK_TTL_MS,
          ).toISOString(),
        },
        leaseId,
      );
    }
    await enqueueInformationAgentInboundJob({
      messageId,
      caseId: sharedCase.id,
      providerEmailId: event.data.email_id,
      receivedAt,
    });
    return {
      accepted: true,
      caseId: sharedCase.id,
      messageId,
      factCount: 0,
      attachmentCount: 0,
      processingStatus: "queued",
    };
  }

  await ensureInboundJobLease(assertJobLease);
  inboundMetadata = await updateInboundProcessingState(
    messageId,
    inboundMetadata,
    {
      status: "processing",
      attempts: (existingProcessing?.attempts ?? 0) + 1,
      providerEmailId: event.data.email_id,
      queuedAt: existingProcessing?.queuedAt ?? receivedAt,
      startedAt: new Date().toISOString(),
      attachmentLinkExpiresAt: new Date(
        Date.parse(receivedAt) + INBOUND_ATTACHMENT_LINK_TTL_MS,
      ).toISOString(),
    },
    leaseId,
  );
  await ensureInboundJobLease(assertJobLease);
  const initialClosedStatus = await ignoreIfCaseClosed(sharedCase.id, messageId, leaseId);
  if (initialClosedStatus) {
    inboundMetadata = mergeJsonObject(inboundMetadata, {
      processing_ignored_case_status: initialClosedStatus,
    });
    await ensureInboundJobLease(assertJobLease);
    await updateInboundProcessingState(
      messageId,
      inboundMetadata,
      {
        status: "ignored",
        attempts: inboundProcessingState(inboundMetadata)?.attempts ?? 1,
        providerEmailId: event.data.email_id,
        queuedAt: existingProcessing?.queuedAt ?? receivedAt,
        reason: "case_closed",
      },
      leaseId,
    );
    return {
      accepted: true,
      caseId: sharedCase.id,
      messageId,
      factCount: 0,
      attachmentCount: 0,
      processingStatus: "ignored",
    };
  }

  if (contactOptOut && senderEmail) {
    return finalizeInboundContactOptOut({
      sharedCase,
      messageId,
      providerEmailId: event.data.email_id,
      receivedAt,
      senderEmail,
      inboundMetadata,
      processing: inboundProcessingState(inboundMetadata),
      leaseFence,
      leaseId,
      assertJobLease,
    });
  }

  // The case address is a routing key, not proof that the sender or the
  // provider's authentication result is safe for automatic extraction.
  if (reviewReason) {
    await ensureInboundJobLease(assertJobLease);
    const caseUpdated = await updateOpenInformationAgentCase(
      sharedCase.id,
      {
        status: "review",
        replied_at: receivedAt,
        metadata: mergeJsonObject(sharedCase.metadata, {
          last_inbound_email_id: event.data.email_id,
          last_inbound_sender_matches_recipient: senderMatches,
          last_inbound_sender_authentication_status: senderAuthentication.status,
        }),
      },
      sharedCase.updated_at,
      leaseFence,
    );
    if (!caseUpdated) {
      await updateInboundProcessingState(
        messageId,
        inboundMetadata,
        {
          status: "review",
          attempts: inboundProcessingState(inboundMetadata)?.attempts ?? 1,
          providerEmailId: event.data.email_id,
          queuedAt: existingProcessing?.queuedAt ?? receivedAt,
          reason: "case_closed_during_processing",
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
    await updateInboundProcessingState(
      messageId,
      inboundMetadata,
      {
        status: "review",
        attempts: inboundProcessingState(inboundMetadata)?.attempts ?? 1,
        providerEmailId: event.data.email_id,
        queuedAt: existingProcessing?.queuedAt ?? receivedAt,
        reason: reviewReason,
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

  try {
    let bodyEvidence: StoredInboundEvidenceAsset | null = null;
    await ensureInboundJobLease(assertJobLease);
    const { attachments, truncated } = await fetchInboundAttachments(resend, event.data.email_id);
    const { stored: storedAssets, rejected } = await storeInboundAttachments({
      attachments,
      sharedCase,
      messageId,
      fetchImpl,
      assertJobLease,
      leaseId,
    });
    await ensureInboundJobLease(assertJobLease);
    if (truncated)
      rejected.push({
        filename: "Lot de pièces jointes",
        reason: "Plus de 500 pièces jointes : traitement partiel, contrôle manuel requis",
      });
    if (rejected.length) {
      const previousInboundMetadata = inboundMetadata;
      inboundMetadata = mergeJsonObject(inboundMetadata, {
        imported_manually: false,
        content_trust: "untrusted",
        sender_matches_recipient: senderMatches,
        rejected_attachment_count: rejected.length,
        rejected_attachments: rejected.slice(0, 50),
      });
      await updateInboundMessageMetadata(
        messageId,
        previousInboundMetadata,
        inboundMetadata,
        leaseId,
      );
    }
    await ensureInboundJobLease(assertJobLease);
    const closedStatus = await ignoreIfCaseClosed(sharedCase.id, messageId, leaseId);
    if (closedStatus) {
      inboundMetadata = mergeJsonObject(inboundMetadata, {
        processing_ignored_case_status: closedStatus,
      });
      await ensureInboundJobLease(assertJobLease);
      await updateInboundProcessingState(
        messageId,
        inboundMetadata,
        {
          status: "ignored",
          attempts: inboundProcessingState(inboundMetadata)?.attempts ?? 1,
          providerEmailId: event.data.email_id,
          queuedAt: existingProcessing?.queuedAt ?? receivedAt,
          reason: "case_closed",
        },
        leaseId,
      );
      return {
        accepted: true,
        caseId: sharedCase.id,
        messageId,
        factCount: 0,
        attachmentCount: 0,
        processingStatus: "ignored",
      };
    }
    const extractedFacts = extractInformationAgentFacts(replyTextForExtraction(bodyText));
    await ensureInboundJobLease(assertJobLease);
    await persistFactCandidates({
      sharedCase,
      messageId,
      facts: extractedFacts,
      assets: storedAssets,
      assertJobLease,
      leaseId,
    });
    // Create the body asset only after deterministic candidates are durable.
    // The storage trigger can start the semantic worker immediately; writing
    // the candidates first lets the worker skip any facts already extracted
    // from the same reply.
    await ensureInboundJobLease(assertJobLease);
    bodyEvidence = await persistInboundBodyEvidence({
      bodyText,
      sharedCase,
      messageId,
      providerEmailId: event.data.email_id,
      assertJobLease,
      leaseId,
    });

    const now = new Date().toISOString();
    const hasEvidence = Boolean(
      bodyEvidence || extractedFacts.length || storedAssets.length || rejected.length,
    );
    // P4-12: a reply that is neither a recognised opposition nor a recognised agreement/answer
    // is never closed automatically: a human reads it.
    const replyIntent = classifyInformationAgentReplyIntent(bodyText, { hasEvidence });
    const hasReviewableEvidence = hasEvidence || replyIntent === "ambiguous";
    await ensureInboundJobLease(assertJobLease);
    const caseUpdated = await updateInboundReplyCase({
      sharedCase,
      hasReviewableEvidence,
      replied_at: receivedAt,
      failure_reason: null,
      metadata: mergeJsonObject(sharedCase.metadata, {
        last_inbound_email_id: event.data.email_id,
        last_inbound_sender_matches_recipient: senderMatches,
        last_inbound_sender_authentication_status: senderAuthentication.status,
        last_inbound_reply_intent: replyIntent,
      }),
      expectedUpdatedAt: sharedCase.updated_at,
      leaseFence,
    });
    if (!caseUpdated) {
      await updateInboundProcessingState(
        messageId,
        inboundMetadata,
        {
          status: "review",
          attempts: inboundProcessingState(inboundMetadata)?.attempts ?? 1,
          providerEmailId: event.data.email_id,
          queuedAt: existingProcessing?.queuedAt ?? receivedAt,
          reason: "case_closed_during_processing",
        },
        leaseId,
      );
      return {
        accepted: true,
        caseId: sharedCase.id,
        messageId,
        factCount: extractedFacts.length + storedAssets.length,
        attachmentCount: storedAssets.length,
        processingStatus: "review",
      };
    }

    await ensureInboundJobLease(assertJobLease);
    const missionUpdateQuery = supabaseAdmin
      .from("information_agent_missions")
      .update({
        status: "replied",
        replied_at: receivedAt,
        updated_at: now,
        ...(leaseFence ? { metadata: addInboundLeaseFence(mission.metadata, leaseFence) } : {}),
      })
      .eq("case_id", sharedCase.id)
      .in("status", ["sent", "subscribed", "replied"]);
    if (leaseId && mission.updated_at) {
      const { data: updatedMission, error: updateMissionsError } = await missionUpdateQuery
        .eq("updated_at", mission.updated_at)
        .select("id")
        .maybeSingle();
      if (updateMissionsError) throw updateMissionsError;
      if (!updatedMission?.id) throw new InformationAgentInboundLeaseLostError();
    } else {
      const { error: updateMissionsError } = await missionUpdateQuery;
      if (updateMissionsError) throw updateMissionsError;
    }

    const processingStatus = hasReviewableEvidence ? "review" : "completed";
    await ensureInboundJobLease(assertJobLease);
    await updateInboundProcessingState(
      messageId,
      inboundMetadata,
      {
        status: processingStatus,
        attempts: inboundProcessingState(inboundMetadata)?.attempts ?? 1,
        providerEmailId: event.data.email_id,
        queuedAt: existingProcessing?.queuedAt ?? receivedAt,
        completedAt: now,
        reason:
          processingStatus === "review"
            ? replyIntent === "ambiguous"
              ? "ambiguous_reply_review"
              : "candidate_or_attachment_review"
            : undefined,
      },
      leaseId,
    );

    return {
      accepted: true,
      caseId: sharedCase.id,
      messageId,
      factCount: extractedFacts.length + storedAssets.length,
      attachmentCount: storedAssets.length,
      processingStatus,
    };
  } catch (error) {
    if (error instanceof InformationAgentInboundLeaseLostError) throw error;
    const currentProcessing = inboundProcessingState(inboundMetadata);
    await updateInboundProcessingState(
      messageId,
      inboundMetadata,
      {
        status: "failed",
        attempts: currentProcessing?.attempts ?? 1,
        providerEmailId: event.data.email_id,
        queuedAt: currentProcessing?.queuedAt ?? receivedAt,
        failedAt: new Date().toISOString(),
        nextAttemptAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        lastError: boundedInboundError(error),
      },
      leaseId,
    );
    throw error;
  }
}

type InformationAgentInboundQueueOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: Date;
  limit?: number;
};

/**
 * Replays durable inbound receipts with a fresh Resend attachment listing.
 * The webhook intentionally does not follow links from the email body; only
 * provider attachment URLs returned by Resend are downloaded here.
 */
export async function runInformationAgentInboundQueue({
  env = process.env,
  fetchImpl = fetch,
  now = new Date(),
  limit = 5,
}: InformationAgentInboundQueueOptions = {}): Promise<Record<string, unknown>> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new Error("La file entrante doit être traitée par lots de 1 à 10 messages.");
  }
  const apiKey = env.RESEND_API_KEY?.trim();
  const inboundDomain = env.INFORMATION_AGENT_INBOUND_DOMAIN?.trim().toLowerCase();
  if (!apiKey || !inboundDomain) {
    throw new Error("Configuration de reprise de l’agent incomplète.");
  }

  const { data: jobs, error: claimError } = await supabaseAdmin.rpc(
    "claim_information_agent_inbound_jobs",
    { p_limit: limit, p_now: now.toISOString() },
  );
  if (claimError) throw claimError;

  const resend = new Resend(apiKey);
  let completed = 0;
  let reviewed = 0;
  let ignored = 0;
  let failed = 0;
  let expiredLinkRisk = 0;
  let staleLease = 0;
  const errors: string[] = [];

  for (const job of jobs ?? []) {
    if (
      Date.parse(job.attachment_link_expires_at) - now.getTime() <=
      INBOUND_ATTACHMENT_LINK_TTL_MS / 5
    ) {
      expiredLinkRisk++;
    }
    try {
      const assertJobLease = () => renewInformationAgentInboundJobLease(job, new Date());
      if (!(await assertJobLease())) {
        staleLease++;
        continue;
      }
      const { data: sharedCase, error: caseError } = await supabaseAdmin
        .from("information_agent_cases")
        .select("*")
        .eq("id", job.case_id)
        .maybeSingle();
      if (caseError) throw caseError;
      if (!sharedCase) throw new Error("Dossier de réception introuvable.");

      // A case can be closed after the verified receipt is queued. Keep the
      // message checkpoint in sync with the durable job before retiring it so
      // the admin view never shows a permanently queued reply.
      if (!["sending", "sent", "replied", "review"].includes(sharedCase.status)) {
        if (!(await assertJobLease())) {
          staleLease++;
          continue;
        }
        await markInboundMessageIgnored({
          messageId: job.message_id,
          providerEmailId: job.provider_email_id,
          queuedAt: job.created_at,
          caseStatus: sharedCase.status,
          leaseId: job.lease_id ?? undefined,
        });
        if (!(await settleInformationAgentInboundJob(job, "ignored"))) {
          staleLease++;
          continue;
        }
        ignored++;
        continue;
      }

      const result = await ingestReceivedEmail({
        event: replayEventForInboundJob(job, sharedCase.inbound_token, inboundDomain),
        resend,
        inboundDomain,
        fetchImpl,
        assertJobLease,
        leaseId: job.lease_id ?? undefined,
      });
      const status: "completed" | "review" | "ignored" =
        result.processingStatus === "completed" || result.processingStatus === "review"
          ? result.processingStatus
          : result.processingStatus === "ignored" || result.ignored
            ? "ignored"
            : "review";
      if (!(await settleInformationAgentInboundJob(job, status))) {
        staleLease++;
        continue;
      }
      if (status === "completed") completed++;
      else if (status === "review") reviewed++;
      else if (status === "ignored") ignored++;
      else {
        failed++;
        errors.push(`Message ${job.provider_email_id}: statut inattendu ${status}`);
      }
    } catch (error) {
      const message = boundedInboundError(error);
      errors.push(`Message ${job.provider_email_id}: ${message}`);
      try {
        if (!(await failInformationAgentInboundJob(job, message, now))) {
          staleLease++;
          errors.pop();
          continue;
        }
        failed++;
      } catch (settleError) {
        failed++;
        errors.push(`File ${job.provider_email_id}: ${boundedInboundError(settleError)}`);
      }
    }
  }

  return {
    claimed: jobs?.length ?? 0,
    completed,
    reviewed,
    ignored,
    failed,
    staleLease,
    expiredLinkRisk,
    errors,
  };
}

async function markInboundMessageIgnored({
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

function replayEventForInboundJob(
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

async function renewInformationAgentInboundJobLease(
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

async function settleInformationAgentInboundJob(
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

async function failInformationAgentInboundJob(
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

async function updateInboundReplyCase({
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

async function updateOpenInformationAgentCase(
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

async function ignoreIfCaseClosed(
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

async function finalizeInboundContactOptOut({
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

async function loadInitiatorMission(sharedCase: SharedCase): Promise<Mission> {
  let query = supabaseAdmin.from("information_agent_missions").select("*");
  query = sharedCase.initiator_mission_id
    ? query.eq("id", sharedCase.initiator_mission_id)
    : query.eq("case_id", sharedCase.id).order("created_at", { ascending: true }).limit(1);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Mission initiatrice du dossier introuvable.");
  return data;
}

async function insertOrLoadInboundMessage({
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

async function enqueueInformationAgentInboundJob({
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

export async function fetchInboundAttachments(resend: Resend, emailId: string) {
  const attachments: AttachmentData[] = [];
  let after: string | undefined;
  while (attachments.length < MAX_LISTED_ATTACHMENTS) {
    const { data, error } = await resend.emails.receiving.attachments.list({
      emailId,
      limit: 100,
      after,
    });
    if (error) throw new Error(error.message || "Pièces jointes Resend indisponibles.");
    const page = data?.data ?? [];
    attachments.push(...page);
    if (!data?.has_more) return { attachments, truncated: false };
    const next = page.at(-1)?.id;
    if (!next || next === after) throw new Error("Pagination des pièces jointes Resend invalide.");
    after = next;
  }
  return { attachments: attachments.slice(0, MAX_LISTED_ATTACHMENTS), truncated: true };
}

export async function readBoundedAttachment(
  response: Response,
  limit: number,
): Promise<Uint8Array | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) return null;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function persistInboundBodyEvidence({
  bodyText,
  sharedCase,
  messageId,
  providerEmailId,
  assertJobLease,
  leaseId,
}: {
  bodyText: string;
  sharedCase: SharedCase;
  messageId: string;
  providerEmailId: string;
  assertJobLease?: InboundJobLeaseGuard;
  leaseId?: string;
}): Promise<StoredInboundEvidenceAsset | null> {
  const bodyForEvidence = replyTextForExtraction(bodyText).trim();
  if (!bodyForEvidence || bodyForEvidence === "Réponse reçue sans corps de texte.") return null;
  await ensureInboundJobLease(assertJobLease);

  const bytes = new TextEncoder().encode(bodyForEvidence);
  if (!bytes.length || bytes.length > MAX_TOTAL_ATTACHMENT_BYTES) return null;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const providerAttachmentId = `email-body:${messageId}`;
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("information_agent_evidence_assets")
    .select("id,original_filename,mime_type,storage_path,size_bytes,sha256")
    .eq("message_id", messageId)
    .eq("provider_attachment_id", providerAttachmentId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) {
    if (existing.sha256 !== sha256) {
      throw new Error("Asset du corps entrant déjà enregistré avec un contenu différent.");
    }
    return {
      id: existing.id,
      filename: existing.original_filename,
      mimeType: existing.mime_type,
      storagePath: existing.storage_path,
      size: Number(existing.size_bytes),
    };
  }

  const storagePath = `${sharedCase.id}/${messageId}/body/${sha256}-email-body.txt`;
  const { error: uploadError } = await supabaseAdmin.storage
    .from("information-agent-evidence")
    .upload(storagePath, bytes, {
      contentType: "text/plain",
      upsert: false,
    });
  if (uploadError && !/already exists|duplicate/i.test(uploadError.message)) throw uploadError;

  await ensureInboundJobLease(assertJobLease);
  const { data: asset, error: assetError } = await supabaseAdmin
    .from("information_agent_evidence_assets")
    .insert({
      case_id: sharedCase.id,
      message_id: messageId,
      sale_id: sharedCase.sale_id,
      provider_attachment_id: providerAttachmentId,
      storage_bucket: "information-agent-evidence",
      storage_path: storagePath,
      original_filename: "email-body.txt",
      mime_type: "text/plain",
      size_bytes: bytes.length,
      sha256,
      metadata: {
        evidence_kind: "email_body",
        content_trust: "untrusted_external_evidence",
        prompt_instructions_ignored: true,
        provider_email_id: providerEmailId,
        ...(leaseId ? { inbound_lease_id: leaseId, inbound_message_id: messageId } : {}),
      },
    })
    .select("id,original_filename,mime_type,storage_path,size_bytes")
    .single();
  if (assetError) {
    const { data: concurrentAsset, error: concurrentError } = await supabaseAdmin
      .from("information_agent_evidence_assets")
      .select("id,original_filename,mime_type,storage_path,size_bytes,sha256")
      .eq("message_id", messageId)
      .eq("provider_attachment_id", providerAttachmentId)
      .maybeSingle();
    if (concurrentError || !concurrentAsset) {
      throw assetError;
    }
    if (concurrentAsset.sha256 !== sha256) {
      throw new Error("Asset concurrent du corps entrant avec un contenu différent.");
    }
    return {
      id: concurrentAsset.id,
      filename: concurrentAsset.original_filename,
      mimeType: concurrentAsset.mime_type,
      storagePath: concurrentAsset.storage_path,
      size: Number(concurrentAsset.size_bytes),
    };
  }
  return {
    id: asset.id,
    filename: asset.original_filename,
    mimeType: asset.mime_type,
    storagePath: asset.storage_path,
    size: Number(asset.size_bytes),
  };
}

async function storeInboundAttachments({
  attachments,
  sharedCase,
  messageId,
  fetchImpl,
  assertJobLease,
  leaseId,
}: {
  attachments: AttachmentData[];
  sharedCase: SharedCase;
  messageId: string;
  fetchImpl: typeof fetch;
  assertJobLease?: InboundJobLeaseGuard;
  leaseId?: string;
}) {
  const stored: StoredInboundEvidenceAsset[] = [];
  const rejected: Array<{ filename: string; reason: string }> = [];
  let totalBytes = 0;

  for (const attachment of attachments) {
    await ensureInboundJobLease(assertJobLease);
    const fields = parseInboundAttachment(attachment);
    const attachmentId = fields.id;
    const rawFilename = fields.filename;
    const filename = safeFilename(rawFilename || `piece-${attachmentId || "jointe"}`);
    const rawMimeType = normalizeRawMimeType(fields.content_type);
    const mimeType = normalizeAttachmentMimeType(rawMimeType, filename);
    const declaredSize = fields.size;
    const downloadUrl = normalizeAttachmentDownloadUrl(fields.download_url);
    if (
      !attachmentId ||
      !ALLOWED_ATTACHMENT_MIME_TYPES.has(mimeType) ||
      declaredSize === null ||
      declaredSize <= 0 ||
      declaredSize > MAX_ATTACHMENT_BYTES ||
      totalBytes + declaredSize > MAX_TOTAL_ATTACHMENT_BYTES ||
      !downloadUrl
    ) {
      rejected.push({
        filename,
        reason: rawMimeType.startsWith("video/")
          ? "Vidéo non traitée : demander un autre mode de transmission"
          : !downloadUrl
            ? "Lien de téléchargement absent ou non sécurisé"
            : !ALLOWED_ATTACHMENT_MIME_TYPES.has(mimeType)
              ? "Format non pris en charge"
              : "Taille hors limite",
      });
      continue;
    }

    const { data: existing, error: existingError } = await supabaseAdmin
      .from("information_agent_evidence_assets")
      .select("id,original_filename,mime_type,storage_path,size_bytes")
      .eq("message_id", messageId)
      .eq("provider_attachment_id", attachmentId)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing) {
      stored.push({
        id: existing.id,
        filename: existing.original_filename,
        mimeType: existing.mime_type,
        storagePath: existing.storage_path,
        size: Number(existing.size_bytes),
      });
      totalBytes += Number(existing.size_bytes);
      continue;
    }

    let response: Response;
    try {
      response = await fetchImpl(downloadUrl, {
        headers: { accept: mimeType },
        redirect: "error",
      });
    } catch {
      // A Resend attachment URL is short-lived. Let the signed webhook be
      // retried for transient transport failures so a fresh URL can be
      // obtained from the provider before falling back to manual review.
      throw new Error("Téléchargement temporairement indisponible ; nouvelle tentative requise.");
    }
    if (!response.ok) {
      if ([408, 425, 429].includes(response.status) || response.status >= 500) {
        throw new Error(
          `Téléchargement temporairement indisponible (HTTP ${response.status}) ; nouvelle tentative requise.`,
        );
      }
      rejected.push({
        filename,
        reason: `Téléchargement impossible (HTTP ${response.status}) ; contrôle manuel requis`,
      });
      continue;
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await readBoundedAttachment(
        response,
        Math.min(MAX_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES - totalBytes),
      );
    } catch {
      rejected.push({ filename, reason: "Lecture du fichier impossible ; contrôle manuel requis" });
      continue;
    }
    if (!bytes) {
      rejected.push({ filename, reason: "Taille réelle hors limite ou fichier vide" });
      continue;
    }

    await ensureInboundJobLease(assertJobLease);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const attachmentKey = createHash("sha256").update(attachmentId).digest("hex");
    const storagePath = `${sharedCase.id}/${messageId}/${attachmentKey}/${sha256}-${filename}`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from("information-agent-evidence")
      .upload(storagePath, bytes, {
        contentType: mimeType,
        upsert: false,
      });
    if (uploadError && !/already exists|duplicate/i.test(uploadError.message)) throw uploadError;

    await ensureInboundJobLease(assertJobLease);
    const { data: asset, error: assetError } = await supabaseAdmin
      .from("information_agent_evidence_assets")
      .insert({
        case_id: sharedCase.id,
        message_id: messageId,
        sale_id: sharedCase.sale_id,
        provider_attachment_id: attachmentId,
        storage_path: storagePath,
        original_filename: filename,
        mime_type: mimeType,
        size_bytes: bytes.length,
        sha256,
        metadata: {
          ...(fields.content_disposition
            ? { content_disposition: fields.content_disposition }
            : {}),
          ...(fields.content_id ? { content_id: fields.content_id } : {}),
          ...(rawMimeType ? { declared_content_type: rawMimeType } : {}),
          declared_size: declaredSize,
          ...(leaseId ? { inbound_lease_id: leaseId, inbound_message_id: messageId } : {}),
        },
      })
      .select("id")
      .single();
    if (assetError) {
      // A concurrent replay can win the same insert after this request's lookup.
      // Only reuse a row tied to the exact provider attachment and content.
      const { data: concurrentAsset, error: concurrentError } = await supabaseAdmin
        .from("information_agent_evidence_assets")
        .select("id,original_filename,mime_type,storage_path,size_bytes,sha256")
        .eq("message_id", messageId)
        .eq("provider_attachment_id", attachmentId)
        .maybeSingle();
      if (concurrentError || !concurrentAsset || concurrentAsset.sha256 !== sha256) {
        throw assetError;
      }
      stored.push({
        id: concurrentAsset.id,
        filename: concurrentAsset.original_filename,
        mimeType: concurrentAsset.mime_type,
        storagePath: concurrentAsset.storage_path,
        size: Number(concurrentAsset.size_bytes),
      });
      totalBytes += Number(concurrentAsset.size_bytes);
      continue;
    }
    stored.push({
      id: asset.id,
      filename,
      mimeType,
      storagePath,
      size: bytes.length,
    });
    totalBytes += bytes.length;
  }
  return { stored, rejected };
}

export async function persistFactCandidates({
  sharedCase,
  messageId,
  facts,
  assets,
  assertJobLease,
  leaseId,
}: {
  sharedCase: SharedCase;
  messageId: string;
  facts: ExtractedInformationAgentFact[];
  assets: Array<{
    id: string;
    filename: string;
    mimeType: string;
    storagePath: string;
    size: number;
  }>;
  assertJobLease?: InboundJobLeaseGuard;
  leaseId?: string;
}) {
  await ensureInboundJobLease(assertJobLease);
  const { data: sale, error: saleError } = await supabaseAdmin
    .from("auction_sales")
    .select(
      "surface_m2,app_surface_m2,land_surface_m2,rooms_count,occupancy_status,sale_date,starting_price_eur,property_type,address",
    )
    .eq("id", sharedCase.sale_id)
    .single();
  if (saleError) throw saleError;

  const rows: Database["public"]["Tables"]["information_agent_fact_candidates"]["Insert"][] = [
    ...facts.map((fact) => ({
      case_id: sharedCase.id,
      message_id: messageId,
      sale_id: sharedCase.sale_id,
      fact_key: fact.factKey,
      proposed_value: fact.proposedValue,
      display_value: fact.displayValue,
      evidence_excerpt: fact.evidenceExcerpt,
      confidence: fact.confidence,
      status: conflictsWithSale(fact, sale) ? ("conflict" as const) : ("pending" as const),
      ...(leaseId
        ? { metadata: { inbound_lease_id: leaseId, inbound_message_id: messageId } }
        : {}),
    })),
    ...assets.map((asset) => ({
      case_id: sharedCase.id,
      message_id: messageId,
      sale_id: sharedCase.sale_id,
      evidence_asset_id: asset.id,
      fact_key: asset.mimeType.startsWith("image/") ? ("photo" as const) : ("document" as const),
      proposed_value: { value: asset.id, storage_path: asset.storagePath },
      display_value: asset.filename,
      evidence_excerpt: null,
      confidence: 1,
      status: "pending" as const,
      ...(leaseId
        ? { metadata: { inbound_lease_id: leaseId, inbound_message_id: messageId } }
        : {}),
    })),
  ];
  if (!rows.length) return;
  await ensureInboundJobLease(assertJobLease);
  const { error } = await supabaseAdmin.from("information_agent_fact_candidates").upsert(rows, {
    onConflict: "message_id,fact_key,evidence_asset_id,source_page,display_value",
    ignoreDuplicates: true,
  });
  if (error) throw error;
}

async function readBoundedWebhookBody(request: Request): Promise<string> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BODY_BYTES) {
    throw new InformationAgentWebhookPayloadTooLargeError();
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_WEBHOOK_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The size error is the actionable outcome even if the client disconnects.
        }
        throw new InformationAgentWebhookPayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function normalizeRawMimeType(value: string | null): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function normalizeAttachmentMimeType(rawMimeType: string, filename: string): string {
  const alias = ATTACHMENT_MIME_ALIASES[rawMimeType];
  if (alias) return alias;
  if (ALLOWED_ATTACHMENT_MIME_TYPES.has(rawMimeType)) return rawMimeType;
  if (rawMimeType === "" || rawMimeType === "application/octet-stream") {
    const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
    return ATTACHMENT_EXTENSION_MIME_TYPES[extension] ?? "";
  }
  return "";
}

function normalizeAttachmentDownloadUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}
