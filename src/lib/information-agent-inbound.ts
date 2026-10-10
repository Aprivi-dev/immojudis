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
  excerptAround,
  jsonObject,
  mergeJsonObject,
  normalizeComparableText,
  normalizeEmail,
  normalizeWhitespace,
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

export type ExtractedInformationAgentFact = {
  factKey:
    | "surface_m2"
    | "land_surface_m2"
    | "rooms_count"
    | "occupancy_status"
    | "visit_information"
    | "sale_date"
    | "starting_price_eur"
    | "energy_diagnostics"
    | "property_type"
    | "address";
  proposedValue: { value: number | string; unit?: string };
  displayValue: string;
  evidenceExcerpt: string;
  confidence: number;
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

export function extractInformationAgentFacts(bodyText: string): ExtractedInformationAgentFact[] {
  const normalized = replyTextForExtraction(bodyText).replace(/\u00a0/g, " ");
  const facts: ExtractedInformationAgentFact[] = [];
  const surfaceObservation = extractSurfaceObservation(normalized);
  if (surfaceObservation) {
    const { value, index, label } = surfaceObservation;
    if (value > 0 && value <= 1000000 && !hasAmbiguousCorrectionNear(normalized, index)) {
      facts.push({
        factKey: "surface_m2",
        proposedValue: { value, unit: "m2" },
        displayValue: `${label ? `${label} : ` : ""}${value.toLocaleString("fr-FR")} m²`,
        evidenceExcerpt: excerptAround(normalized, index),
        confidence: label ? 0.88 : 0.7,
      });
    }
  }

  const landSurfaceObservation = extractLandSurfaceObservation(normalized);
  if (
    landSurfaceObservation &&
    !hasAmbiguousCorrectionNear(normalized, landSurfaceObservation.index)
  ) {
    facts.push({
      factKey: "land_surface_m2",
      proposedValue: { value: landSurfaceObservation.value, unit: "m2" },
      displayValue: `Terrain : ${landSurfaceObservation.value.toLocaleString("fr-FR")} m²`,
      evidenceExcerpt: excerptAround(normalized, landSurfaceObservation.index),
      confidence: 0.88,
    });
  }

  const roomsMatches = [...normalized.matchAll(/(?<!\d)(\d{1,2})(?!\d)\s+pi[eè]ces?\b/gi)];
  const roomValues = new Set(roomsMatches.map((match) => Number(match[1])));
  const roomsMatch = roomValues.size === 1 ? roomsMatches[0] : undefined;
  if (roomsMatch) {
    const value = Number(roomsMatch[1]);
    if (
      value >= 1 &&
      value <= 100 &&
      !hasAmbiguousCorrectionNear(normalized, roomsMatch.index ?? 0)
    ) {
      facts.push({
        factKey: "rooms_count",
        proposedValue: { value },
        displayValue: `${value} pièce${value > 1 ? "s" : ""}`,
        evidenceExcerpt: excerptAround(normalized, roomsMatch.index ?? 0),
        confidence: 0.86,
      });
    }
  }

  const occupancyPatterns: Array<[RegExp, string, string]> = [
    [
      /\b(?:bien|logement|maison|appartement)\s+(?:(?:est|était|sera|serait)\s+)?occup[ée]e?s?\s+par\s+(?:le|la|les)\s+propri[ée]taire(?:s)?\b/iu,
      "owner_occupied",
      "Bien occupé par le propriétaire",
    ],
    [/\b(?:libre\s+de\s+toute\s+occupation|vacant|inoccup[ée])\b/iu, "vacant", "Bien libre"],
    [/\b(?:bail\s+en\s+cours|locataire|location)\b/iu, "rented", "Bien loué"],
    [
      /\b(?:bien|logement|maison|appartement)\s+(?:(?:est|était|sera|serait)\s+)?libres?(?![\p{L}\p{N}])/iu,
      "vacant",
      "Bien libre",
    ],
    [
      /\b(?:bien|logement|maison|appartement)\s+(?:(?:est|était|sera|serait)\s+)?lou[ée]e?s?(?![\p{L}\p{N}])/iu,
      "rented",
      "Bien loué",
    ],
    [
      /\b(?:bien|logement|maison|appartement)\s+(?:(?:est|était|sera|serait)\s+)?occup[ée]e?s?(?![\p{L}\p{N}])/iu,
      "occupied",
      "Bien occupé",
    ],
    [/\bsquatt[ée]e?s?(?![\p{L}\p{N}])/iu, "squatted", "Bien squatté"],
  ];
  const occupancyMatches = occupancyPatterns.flatMap(([pattern, value, label]) =>
    pattern.test(normalized) ? [{ pattern, value, label }] : [],
  );
  const effectiveOccupancyMatches = occupancyMatches.some(
    (match) => match.value === "owner_occupied",
  )
    ? occupancyMatches.filter((match) => match.value !== "occupied")
    : occupancyMatches;
  if (new Set(effectiveOccupancyMatches.map((match) => match.value)).size === 1) {
    for (const { pattern, value, label } of effectiveOccupancyMatches) {
      const match = normalized.match(pattern);
      if (!match) continue;
      if (
        !hasAmbiguousCorrectionNear(normalized, match.index ?? 0) &&
        !hasNegatedValueNear(normalized, match.index ?? 0)
      ) {
        facts.push({
          factKey: "occupancy_status",
          proposedValue: { value },
          displayValue: label,
          evidenceExcerpt: excerptAround(normalized, match.index ?? 0),
          confidence: 0.82,
        });
      }
      break;
    }
  }

  const visitObservation = extractVisitObservation(normalized);
  if (visitObservation) {
    facts.push({
      factKey: "visit_information",
      proposedValue: { value: visitObservation.value },
      displayValue: visitObservation.value,
      evidenceExcerpt: visitObservation.evidenceExcerpt,
      confidence: 0.72,
    });
  }

  const diagnosticObservation = extractEnergyDiagnosticObservation(normalized);
  if (diagnosticObservation) {
    facts.push({
      factKey: "energy_diagnostics",
      proposedValue: { value: diagnosticObservation.value },
      displayValue: diagnosticObservation.value,
      evidenceExcerpt: diagnosticObservation.evidenceExcerpt,
      confidence: 0.88,
    });
  }

  const propertyTypeObservation = extractPropertyTypeObservation(normalized);
  if (propertyTypeObservation) {
    facts.push({
      factKey: "property_type",
      proposedValue: { value: propertyTypeObservation.value },
      displayValue: propertyTypeObservation.displayValue,
      evidenceExcerpt: propertyTypeObservation.evidenceExcerpt,
      confidence: 0.84,
    });
  }

  const addressObservation = extractAddressObservation(normalized);
  if (addressObservation) {
    facts.push({
      factKey: "address",
      proposedValue: { value: addressObservation.value },
      displayValue: addressObservation.value,
      evidenceExcerpt: addressObservation.evidenceExcerpt,
      confidence: 0.8,
    });
  }

  const saleDateObservations = extractLabeledSaleDates(normalized);
  if (saleDateObservations.length) {
    const values = new Set(saleDateObservations.map((observation) => observation.value));
    if (values.size === 1) {
      const observation = saleDateObservations[0];
      if (observation && !hasAmbiguousCorrectionNear(normalized, observation.index)) {
        facts.push({
          factKey: "sale_date",
          proposedValue: { value: observation.value },
          displayValue: formatFrenchDate(observation.value),
          evidenceExcerpt: excerptAround(normalized, observation.index),
          confidence: 0.94,
        });
      }
    }
  }

  const startingPriceObservations = extractLabeledStartingPrices(normalized);
  if (startingPriceObservations.length) {
    const values = new Set(startingPriceObservations.map((observation) => observation.value));
    if (values.size === 1) {
      const observation = startingPriceObservations[0];
      if (observation && !hasAmbiguousCorrectionNear(normalized, observation.index)) {
        facts.push({
          factKey: "starting_price_eur",
          proposedValue: { value: observation.value, unit: "EUR" },
          displayValue: `${observation.value.toLocaleString("fr-FR")} €`,
          evidenceExcerpt: excerptAround(normalized, observation.index),
          confidence: 0.95,
        });
      }
    }
  }
  return facts;
}

type SurfaceObservation = { value: number; index: number; label: string | null };

function extractSurfaceObservation(text: string): SurfaceObservation | null {
  const labelledPattern =
    /\b(surface(?:\s+(?:habitable|carrez|privative|utile|totale|au\s+sol))?)[^\d]{0,45}(\d{1,8}(?:[.,]\d{1,2})?)\s*m(?:²|2)(?![\p{L}\p{N}])/giu;
  const genericPattern = /(?<![\d.,])(\d{1,8}(?:[.,]\d{1,2})?)\s*m(?:²|2)(?![\p{L}\p{N}])/giu;
  const labelled: SurfaceObservation[] = [];
  for (const match of text.matchAll(labelledPattern)) {
    const rawValue = match[2];
    const matchIndex = match.index ?? 0;
    const trailingClause =
      text
        .slice(matchIndex + (match[0]?.length ?? 0), matchIndex + (match[0]?.length ?? 0) + 60)
        .split(/[.!?\n;]/u, 1)[0] ?? "";
    if (
      !rawValue ||
      isLandSurfaceContext(text, matchIndex) ||
      /\b(?:terrain|parcelle|contenance)\b/iu.test(match[0] ?? "") ||
      hasExplicitUncertainty(match[0] ?? "") ||
      hasExplicitUncertainty(trailingClause)
    )
      continue;
    const value = Number(rawValue.replace(",", "."));
    if (Number.isFinite(value) && value > 0 && value <= 1_000_000) {
      labelled.push({
        value,
        index: matchIndex,
        label: normalizeWhitespace(match[1] ?? "surface"),
      });
    }
  }

  const generic: SurfaceObservation[] = [];
  for (const match of text.matchAll(genericPattern)) {
    const value = Number((match[1] ?? "").replace(",", "."));
    const index = match.index ?? 0;
    if (
      !Number.isFinite(value) ||
      value <= 0 ||
      value > 1_000_000 ||
      isLandSurfaceContext(text, index) ||
      hasExplicitUncertainty(
        text.slice(
          Math.max(0, index - 70),
          Math.min(text.length, index + (match[0]?.length ?? 0) + 70),
        ),
      ) ||
      labelled.some((observation) => observation.index === index)
    ) {
      continue;
    }
    generic.push({ value, index, label: null });
  }
  const genericValues = new Set(generic.map((observation) => observation.value));
  const preferred = labelled.filter((observation) =>
    /habitable|privative|utile|totale|au sol/i.test(observation.label ?? ""),
  );
  const carrez = labelled.filter((observation) => /carrez/i.test(observation.label ?? ""));
  for (const candidates of [preferred, carrez, labelled]) {
    const values = new Set(candidates.map((observation) => observation.value));
    if (values.size > 1) return null;
    const candidate = candidates[0];
    if (candidate && [...genericValues].every((value) => value === candidate.value)) {
      return candidate;
    }
  }
  const values = new Set(generic.map((observation) => observation.value));
  return values.size === 1 ? (generic[0] ?? null) : null;
}

function extractLandSurfaceObservation(text: string): { value: number; index: number } | null {
  const pattern =
    /\b(?:surface\s+(?:du|de\s+la)\s+terrain|terrain|parcelle|contenance)[^\d]{0,60}(\d{1,10}(?:[.,]\d{1,2})?)\s*m(?:²|2)(?![\p{L}\p{N}])/giu;
  const observations: Array<{ value: number; index: number }> = [];
  for (const match of text.matchAll(pattern)) {
    const value = Number((match[1] ?? "").replace(",", "."));
    if (Number.isFinite(value) && value > 0 && value <= 100_000_000) {
      observations.push({ value, index: match.index ?? 0 });
    }
  }
  const values = new Set(observations.map((observation) => observation.value));
  return values.size === 1 ? (observations[0] ?? null) : null;
}

function isLandSurfaceContext(text: string, index: number): boolean {
  return /\b(?:terrain|parcelle|contenance)\b/i.test(text.slice(Math.max(0, index - 70), index));
}

function extractVisitObservation(text: string): { value: string; evidenceExcerpt: string } | null {
  const pattern = /\bvisites?\b/giu;
  const observations: Array<{ value: string; evidenceExcerpt: string }> = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const source = text.slice(start, Math.min(text.length, start + 240));
    const nextLabel =
      /\b(?:DPE|GES|mise\s+[àa]\s+prix|date\s+de\s+la\s+vente|surface|diagnostic|frais)\b/iu.exec(
        source.slice(match[0].length),
      );
    let end = nextLabel ? match[0].length + (nextLabel.index ?? 0) : source.length;
    for (let index = match[0].length; index < end; index++) {
      const character = source[index];
      if (
        character === "\n" ||
        character === "\r" ||
        character === ";" ||
        character === "!" ||
        character === "?"
      ) {
        end = index;
        break;
      }
      if (character === "." && !isDigit(source[index - 1]) && !isDigit(source[index + 1])) {
        end = index;
        break;
      }
      if (character === "." && !isDigit(source[index + 1])) {
        end = index;
        break;
      }
    }
    const raw = normalizeWhitespace(source.slice(0, end));
    const detail = raw.replace(/^visites?\b\s*[:-]?\s*/iu, "").trim();
    const rawWithPrefix = normalizeWhitespace(
      `${text.slice(Math.max(0, start - 40), start)} ${raw}`,
    );
    if (
      !detail ||
      /\b(?:aucun(?:e)?|pas\s+de)\s+visites?\b|\bvisites?\s+(?:impossible|indisponible|non\s+(?:possible|disponible)|pas\s+possible|à\s+confirmer|a\s+confirmer)\b/iu.test(
        rawWithPrefix,
      ) ||
      /^(?:aucun(?:e)?|pas\s+de|impossible|indisponible|non\s+(?:possible|disponible)|pas\s+possible)\b/iu.test(
        detail,
      ) ||
      !hasVisitSignal(detail)
    )
      continue;
    const value = raw ? `${raw.slice(0, 1).toLocaleUpperCase("fr-FR")}${raw.slice(1)}` : raw;
    observations.push({
      value: value.slice(0, 500),
      evidenceExcerpt: excerptAround(text, match.index ?? 0),
    });
  }
  const unique = new Map(
    observations.map((observation) => [observation.value.toLowerCase(), observation]),
  );
  return unique.size === 1 ? (unique.values().next().value ?? null) : null;
}

function hasVisitSignal(value: string): boolean {
  return /\b(?:\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?|\d{1,2}\s+(?:janv|févr|fevr|mars|avr|mai|juin|juil|ao[uû]t|sept?|oct|nov|déc|dec)[a-zéû]*|\d{1,2}\s*h|rendez[- ]vous|inscription|sur\s+rendez|organis|possible|aucune?|pas\s+de|contact)\b/iu.test(
    value,
  );
}

function extractEnergyDiagnosticObservation(
  text: string,
): { value: string; evidenceExcerpt: string } | null {
  const diagnosticPattern =
    /\b(?:DPE|diagnostic\s+de\s+performance\s+[ée]nerg[ée]tique)\b[^\n.]{0,180}/giu;
  const observations: Array<{ value: string; evidenceExcerpt: string }> = [];
  for (const match of text.matchAll(diagnosticPattern)) {
    const segment = normalizeWhitespace(match[0] ?? "");
    if (containsUncertainQualifier(segment)) continue;
    const dpe =
      /\b(?:DPE|classe\s+(?:énerg(?:ie|étique)|energie|energetique)|étiquette\s+énergie)\s*[:-]?\s*([A-G])\b/iu
        .exec(segment)?.[1]
        ?.toUpperCase();
    const ges = /\bGES\s*[:-]?\s*([A-G])\b/iu.exec(segment)?.[1]?.toUpperCase();
    if (!dpe && !ges && !/\b(?:disponible|réalis[ée]|a[nn]ex[ée]|joint|transmis)/iu.test(segment))
      continue;
    const value =
      [dpe ? `DPE ${dpe}` : null, ges ? `GES ${ges}` : null].filter(Boolean).join(" · ") || segment;
    observations.push({
      value: value.slice(0, 500),
      evidenceExcerpt: excerptAround(text, match.index ?? 0),
    });
  }
  const unique = new Map(
    observations.map((observation) => [observation.value.toLowerCase(), observation]),
  );
  return unique.size === 1 ? (unique.values().next().value ?? null) : null;
}

type PropertyTypeValue =
  | "house"
  | "apartment"
  | "building"
  | "commercial"
  | "mixed"
  | "land"
  | "parking";

const PROPERTY_TYPE_OBSERVATIONS: Array<{
  value: PropertyTypeValue;
  displayValue: string;
  pattern: RegExp;
}> = [
  { value: "house", displayValue: "Maison", pattern: /\b(?:maison|villa|pavillon)\b/iu },
  {
    value: "apartment",
    displayValue: "Appartement",
    pattern: /\b(?:appartement|studio|duplex|triplex|T\s*[1-9]\d?)\b/iu,
  },
  { value: "building", displayValue: "Immeuble", pattern: /\bimmeuble\b/iu },
  {
    value: "commercial",
    displayValue: "Local commercial",
    pattern: /\b(?:local\s+commercial|commerce|bureau)\b/iu,
  },
  { value: "mixed", displayValue: "Bien mixte", pattern: /\bbien\s+mixte\b/iu },
  {
    value: "land",
    displayValue: "Terrain",
    pattern: /\b(?:terrain|parcelle)\s+(?:à|a)\s+(?:bâtir|batir|construire)\b/iu,
  },
  { value: "parking", displayValue: "Parking", pattern: /\b(?:parking|box\s+(?:fermé|ferme))\b/iu },
];

function extractPropertyTypeObservation(
  text: string,
): { value: string; displayValue: string; evidenceExcerpt: string } | null {
  const observations: Array<{ value: string; displayValue: string; evidenceExcerpt: string }> = [];
  for (const item of PROPERTY_TYPE_OBSERVATIONS) {
    const match = item.pattern.exec(text);
    if (!match) continue;
    if (!hasExplicitPropertyTypeContext(text, match.index ?? 0, match[0].length)) continue;
    observations.push({
      value: item.value,
      displayValue: item.displayValue,
      evidenceExcerpt: excerptAround(text, match.index ?? 0),
    });
  }
  const unique = new Map(observations.map((observation) => [observation.value, observation]));
  return unique.size === 1 ? (unique.values().next().value ?? null) : null;
}

function hasExplicitPropertyTypeContext(text: string, index: number, length: number): boolean {
  const before = text.slice(Math.max(0, index - 90), index);
  const after = text.slice(index + length, Math.min(text.length, index + length + 40));
  return (
    /(?:type\s+de\s+bien|nature\s+du\s+bien|cat[ée]gorie|propri[ée]t[ée]|lot)\s*[:=-]?\s*$/iu.test(
      before,
    ) ||
    /(?:\b(?:le\s+)?bien|c['’]est|il\s+s['’]agit)\s+(?:est\s+)?(?:d['’])?(?:un(?:e)?\s+)?$/iu.test(
      before,
    ) ||
    /^\s*(?:à|a)\s+(?:vendre|louer|b[âa]tir|construire)\b/iu.test(after)
  );
}

function extractAddressObservation(
  text: string,
): { value: string; evidenceExcerpt: string } | null {
  const pattern =
    /\b(?:adresse|sis(?:e)?|situ[ée]?(?:\s+(?:au|à|a))?)\b\s*[:-]?\s*([^\n]{5,180})/giu;
  const observations: Array<{ value: string; evidenceExcerpt: string }> = [];
  for (const match of text.matchAll(pattern)) {
    const value = normalizeWhitespace(match[1] ?? "")
      .replace(/[.,;]+$/, "")
      .trim();
    if (!value || hasExplicitUncertainty(value)) continue;
    observations.push({
      value: value.slice(0, 180),
      evidenceExcerpt: excerptAround(text, match.index ?? 0),
    });
  }
  const unique = new Map(
    observations.map((observation) => [observation.value.toLowerCase(), observation]),
  );
  return unique.size === 1 ? (unique.values().next().value ?? null) : null;
}

function conflictsWithSale(
  fact: ExtractedInformationAgentFact,
  sale: {
    surface_m2: number | null;
    app_surface_m2: number | null;
    land_surface_m2: number | null;
    rooms_count: number | null;
    occupancy_status: string | null;
    sale_date: string | null;
    starting_price_eur: number | null;
    property_type: string | null;
    address: string | null;
  },
) {
  const value = fact.proposedValue.value;
  if (fact.factKey === "surface_m2") {
    const existing = sale.app_surface_m2 ?? sale.surface_m2;
    return existing != null && Math.abs(existing - Number(value)) > 0.5;
  }
  if (fact.factKey === "rooms_count") {
    return sale.rooms_count != null && sale.rooms_count !== Number(value);
  }
  if (fact.factKey === "land_surface_m2") {
    return sale.land_surface_m2 != null && Math.abs(sale.land_surface_m2 - Number(value)) > 0.5;
  }
  if (fact.factKey === "occupancy_status") {
    return sale.occupancy_status != null && sale.occupancy_status !== value;
  }
  if (fact.factKey === "sale_date") {
    return sale.sale_date != null && String(sale.sale_date).slice(0, 10) !== String(value);
  }
  if (fact.factKey === "property_type") {
    return sale.property_type != null && sale.property_type !== String(value);
  }
  if (fact.factKey === "address") {
    return (
      sale.address != null &&
      normalizeComparableText(sale.address) !== normalizeComparableText(String(value))
    );
  }
  if (fact.factKey === "visit_information" || fact.factKey === "energy_diagnostics") {
    return false;
  }
  return (
    sale.starting_price_eur != null && Math.abs(sale.starting_price_eur - Number(value)) > 0.01
  );
}

type LabeledSaleDateObservation = { value: string; index: number };
type LabeledStartingPriceObservation = { value: number; index: number };

const SALE_DATE_LABEL_PATTERN =
  /(?:date\s+(?:de\s+la\s+|de\s+)?vente|date\s+(?:d['’]|de\s+l['’]\s*)adjudication|date\s+(?:d['’]|de\s+l['’]\s*)audience|audience\s+d['’]adjudication|adjudication\s+(?:prévue|prevue)|vente\s+(?:prévue|prevue))\b/giu;
const FRENCH_MONTH_PATTERN =
  "(?:janv(?:ier)?|févr(?:ier)?|fevr(?:ier)?|mars|avr(?:il)?|mai|juin|juil(?:let)?|ao[uû]t|sept?(?:embre)?|oct(?:obre)?|nov(?:embre)?|déc(?:embre)?|dec(?:embre)?)";
const DATE_TOKEN_PATTERN = new RegExp(
  `(?<!\\d)(?:\\d{1,2}[/.\\-]\\d{1,2}[/.\\-]\\d{4}|\\d{4}[/.\\-]\\d{1,2}[/.\\-]\\d{1,2}|\\d{1,2}\\s+${FRENCH_MONTH_PATTERN}\\s+\\d{4})(?!\\d)`,
  "iu",
);
const DATE_TOKEN_GLOBAL_PATTERN = new RegExp(DATE_TOKEN_PATTERN.source, "giu");
const STARTING_PRICE_LABEL_PATTERN =
  /(?:mise\s+[àa]\s+prix|prix\s+(?:de\s+)?(?:départ|depart|initial|d['’]ouverture|ouverture))\b/giu;
const NEXT_INFORMATION_LABEL_PATTERN = new RegExp(
  `(?:${SALE_DATE_LABEL_PATTERN.source}|${STARTING_PRICE_LABEL_PATTERN.source})`,
  "iu",
);
const MONEY_TOKEN_PATTERN = new RegExp(
  "(?<![\\d.,])((?:\\d{1,3}(?:[ .\\u00a0]\\d{3})+(?:[.,]\\d{1,2})?|\\d{4,10}|\\d{1,3}(?:[.,]\\d{1,2})?))(?:\\s*(k|m))?\\s*(?:€|euros?|eur)(?![\\p{L}\\p{N}])",
  "giu",
);

function extractLabeledSaleDates(text: string): LabeledSaleDateObservation[] {
  const observations: LabeledSaleDateObservation[] = [];
  for (const labelMatch of text.matchAll(SALE_DATE_LABEL_PATTERN)) {
    const labelIndex = labelMatch.index ?? 0;
    const clause = labeledClauseAfterLabel(text, labelIndex + labelMatch[0].length);
    const dateMatches = [...clause.text.matchAll(DATE_TOKEN_GLOBAL_PATTERN)];
    if (!dateMatches.length) continue;
    if (dateMatches.length !== 1) return [];
    const dateMatch = dateMatches[0];
    if (!dateMatch?.[0]) return [];
    if (containsUncertainQualifier(clause.text)) return [];
    const value = parseFrenchDate(dateMatch[0]);
    if (!value) return [];
    observations.push({
      value,
      index: clause.start + (dateMatch.index ?? 0),
    });
  }
  return observations;
}

function extractLabeledStartingPrices(text: string): LabeledStartingPriceObservation[] {
  const observations: LabeledStartingPriceObservation[] = [];
  for (const labelMatch of text.matchAll(STARTING_PRICE_LABEL_PATTERN)) {
    const labelIndex = labelMatch.index ?? 0;
    const clause = labeledClauseAfterLabel(text, labelIndex + labelMatch[0].length);
    const moneyMatches = [...clause.text.matchAll(MONEY_TOKEN_PATTERN)];
    if (moneyMatches.length !== 1) continue;
    const moneyMatch = moneyMatches[0];
    if (!moneyMatch?.[1]) continue;
    if (containsUncertainQualifier(clause.text)) return [];
    const value = parseFrenchMoney(moneyMatch[1], moneyMatch[2]);
    if (value == null || value <= 0 || value > 1_000_000_000) return [];
    observations.push({
      value,
      index: clause.start + (moneyMatch.index ?? 0),
    });
  }
  return observations;
}

function labeledClauseAfterLabel(text: string, start: number): { text: string; start: number } {
  const source = text.slice(start, Math.min(text.length, start + 100));
  const nextLabel = NEXT_INFORMATION_LABEL_PATTERN.exec(source);
  let end = nextLabel?.index ?? source.length;
  for (let index = 0; index < end; index++) {
    const character = source[index];
    if (
      character === "\n" ||
      character === "\r" ||
      character === ";" ||
      character === "!" ||
      character === "?"
    ) {
      end = index;
      break;
    }
    if (character === "." && !(isDigit(source[index - 1]) && isDigit(source[index + 1]))) {
      end = index;
      break;
    }
  }
  return { text: source.slice(0, end), start };
}

function isDigit(value: string | undefined): boolean {
  return value != null && value >= "0" && value <= "9";
}

function containsUncertainQualifier(value: string): boolean {
  return /(?<![\p{L}\p{N}])(?:pas|aucun[e]?|inconnu[e]?|non\s+communiqu[ée]e?|non\s+disponible|indisponible|à\s+confirmer|a\s+confirmer|à\s+d[ée]finir|a\s+definir|sous\s+r[ée]serve|report[ée]e?|en\s+attente)(?![\p{L}\p{N}])/iu.test(
    value,
  );
}

function hasExplicitUncertainty(value: string): boolean {
  return /(?<![\p{L}\p{N}])(?:à\s+confirmer|a\s+confirmer|à\s+d[ée]finir|a\s+definir|inconnu[e]?|incertain[e]?|non\s+communiqu[ée]e?|pas\s+communiqu[ée]e?|non\s+disponible|indisponible|sous\s+r[ée]serve|en\s+attente)(?![\p{L}\p{N}])/iu.test(
    value,
  );
}

const AMBIGUOUS_CORRECTION_PATTERN =
  /(?<![\p{L}\p{N}])(?:correction|corrig(?:é|ée|és|ées)|rectification|rectifi(?:é|ée|és|ées)|erratum|erreur|au\s+lieu\s+de|et\s+non)(?![\p{L}\p{N}])/iu;

function hasAmbiguousCorrectionNear(text: string, index: number): boolean {
  const start = Math.max(0, index - 120);
  const end = Math.min(text.length, index + 120);
  return AMBIGUOUS_CORRECTION_PATTERN.test(text.slice(start, end));
}

function hasNegatedValueNear(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 70), index);
  const after = text.slice(index, Math.min(text.length, index + 70));
  return (
    /(?:n['’]est|n['’]était|ne\s+\w+|pas|sans|non)\s+[^.!?\n]{0,35}$/iu.test(before) ||
    /^\s*(?:pas|non)\b/iu.test(after)
  );
}

function parseFrenchDate(value: string): string | null {
  const normalized = value
    .toLocaleLowerCase("fr-FR")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let day: number;
  let month: number;
  let year: number;
  const numeric = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(normalized);
  const iso = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/.exec(normalized);
  const words = new RegExp(`^(\\d{1,2})\\s+(${FRENCH_MONTH_PATTERN})\\s+(\\d{4})$`, "iu").exec(
    normalized,
  );
  if (numeric?.[1] && numeric[2] && numeric[3]) {
    day = Number(numeric[1]);
    month = Number(numeric[2]);
    year = Number(numeric[3]);
  } else if (iso?.[1] && iso[2] && iso[3]) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (words?.[1] && words[2] && words[3]) {
    day = Number(words[1]);
    month = frenchMonthNumber(words[2]);
    year = Number(words[3]);
  } else {
    return null;
  }
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) return null;
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
}

function frenchMonthNumber(value: string): number {
  const normalized = value.toLocaleLowerCase("fr-FR").replace(/[.]/g, "");
  const months: Record<string, number> = {
    janvier: 1,
    janv: 1,
    février: 2,
    fevrier: 2,
    févr: 2,
    fevr: 2,
    mars: 3,
    avril: 4,
    avr: 4,
    mai: 5,
    juin: 6,
    juillet: 7,
    juil: 7,
    août: 8,
    aout: 8,
    septembre: 9,
    sept: 9,
    octobre: 10,
    oct: 10,
    novembre: 11,
    nov: 11,
    décembre: 12,
    decembre: 12,
    déc: 12,
    dec: 12,
  };
  return months[normalized] ?? 0;
}

function parseFrenchMoney(value: string, multiplier: string | undefined): number | null {
  const compact = value.replace(/[ \u00a0]/g, "");
  let parsed: number;
  const separatorCount = (compact.match(/[.,]/g) ?? []).length;
  if (separatorCount > 1) {
    parsed = Number(compact.replace(/[.,]/g, ""));
  } else if (/[.,]/.test(compact)) {
    const separator = compact.includes(",") ? "," : ".";
    const [whole = "", fraction = ""] = compact.split(separator);
    parsed =
      fraction.length === 3 ? Number(`${whole}${fraction}`) : Number(compact.replace(",", "."));
  } else {
    parsed = Number(compact);
  }
  if (!Number.isFinite(parsed)) return null;
  const normalizedMultiplier = multiplier?.toLocaleLowerCase("fr-FR");
  if (normalizedMultiplier === "k") parsed *= 1_000;
  if (normalizedMultiplier === "m") parsed *= 1_000_000;
  return Number.isFinite(parsed) ? parsed : null;
}

function formatFrenchDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
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
