import "server-only";
import { Resend, type EmailReceivedEvent } from "resend";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { z } from "zod";
import {
  INBOUND_ATTACHMENT_LINK_TTL_MS,
  type InformationAgentInboundResult,
  optionalText,
} from "@/lib/information-agent-inbound/types";
import {
  boundedInboundError,
  cleanInboundBody,
  mergeJsonObject,
  normalizeEmail,
  replyTextForExtraction,
  requiredHeader,
  stringArray,
} from "@/lib/information-agent-inbound/text";
import {
  ensureInboundJobLease,
  type InboundJobLeaseGuard,
  InformationAgentInboundLeaseLostError,
} from "@/lib/information-agent-inbound/lease";
import {
  inboundReviewReason,
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
import { extractInformationAgentFacts } from "@/lib/information-agent-inbound/fact-extraction";
import {
  fetchInboundAttachments,
  persistFactCandidates,
  persistInboundBodyEvidence,
  type StoredInboundEvidenceAsset,
  storeInboundAttachments,
} from "@/lib/information-agent-inbound/attachments";
import {
  enqueueInformationAgentInboundJob,
  failInformationAgentInboundJob,
  markInboundMessageIgnored,
  renewInformationAgentInboundJobLease,
  replayEventForInboundJob,
  settleInformationAgentInboundJob,
} from "@/lib/information-agent-inbound/job-queue";
import {
  finalizeInboundContactOptOut,
  ignoreIfCaseClosed,
  insertOrLoadInboundMessage,
  loadInitiatorMission,
  updateInboundReplyCase,
  updateOpenInformationAgentCase,
} from "@/lib/information-agent-inbound/case-updates";

export {
  fetchInboundAttachments,
  readBoundedAttachment,
  persistFactCandidates,
} from "@/lib/information-agent-inbound/attachments";

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
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

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

type ReceivedEmailExtras = z.infer<typeof receivedEmailExtrasSchema>;

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
