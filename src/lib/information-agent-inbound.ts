import { createHash, randomUUID } from "node:crypto";
import { Parser } from "htmlparser2";
import { Resend, type AttachmentData, type EmailReceivedEvent } from "resend";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024;
const MAX_LISTED_ATTACHMENTS = 500;
const MAX_HTML_BODY_CHARS = 500_000;
const MAX_EXTRACTED_BODY_CHARS = 20_000;
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
const INBOUND_ATTACHMENT_LINK_TTL_MS = 55 * 60 * 1000;
const INBOUND_PROCESSING_VERSION = "inbound-v2";
const OPEN_INFORMATION_AGENT_CASE_STATUSES = ["sending", "sent", "replied", "review"] as const;
const HTML_LINE_BREAK_TAGS = new Set([
  "blockquote",
  "br",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "p",
  "tr",
]);
const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "text/plain",
]);

type SharedCase = Database["public"]["Tables"]["information_agent_cases"]["Row"];
type Mission = Database["public"]["Tables"]["information_agent_missions"]["Row"];

const RESEND_AUTHENTICATION_RESULTS = [
  "pass",
  "fail",
  "gray",
  "processing_failed",
  "unknown",
] as const;
type ResendAuthenticationResult = (typeof RESEND_AUTHENTICATION_RESULTS)[number];
type NormalizedInboundAuthenticationResult = ResendAuthenticationResult | "missing";

type InboundSenderAuthentication = {
  status: "pass" | "fail" | "unverified";
  spf: NormalizedInboundAuthenticationResult;
  dkim: NormalizedInboundAuthenticationResult;
  dmarc: NormalizedInboundAuthenticationResult;
};

type InboundReviewReason =
  | "sender_mismatch"
  | "sender_authentication_failed"
  | "sender_authentication_unverified";

export type ExtractedInformationAgentFact = {
  factKey: "surface_m2" | "rooms_count" | "occupancy_status" | "sale_date" | "starting_price_eur";
  proposedValue: { value: number | string; unit?: string };
  displayValue: string;
  evidenceExcerpt: string;
  confidence: number;
};

export type InformationAgentInboundResult = {
  accepted: boolean;
  ignored?: boolean;
  duplicate?: boolean;
  caseId?: string;
  messageId?: string;
  factCount?: number;
  attachmentCount?: number;
  processingStatus?: "completed" | "review" | "ignored" | "queued";
};

type InboundMessageRef = {
  id: string;
  duplicate: boolean;
  metadata: Json;
};

type InboundProcessingState = {
  version: string;
  status: "queued" | "processing" | "completed" | "failed" | "review" | "ignored";
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
};

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
    requireEmailAuthentication: env.INFORMATION_AGENT_REQUIRE_EMAIL_AUTHENTICATION === "true",
    deferProcessing,
  });
}

async function ingestReceivedEmail({
  event,
  resend,
  inboundDomain,
  fetchImpl,
  requireEmailAuthentication,
  deferProcessing = false,
}: {
  event: EmailReceivedEvent;
  resend: Resend;
  inboundDomain: string;
  fetchImpl: typeof fetch;
  requireEmailAuthentication: boolean;
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
  const receivedTokens = collectInboundTokens(received.to, inboundDomain);
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
  const senderAuthentication = normalizeInboundSenderAuthentication(
    (received as unknown as { authentication?: unknown }).authentication,
  );
  const inboundMessage = await insertOrLoadInboundMessage({
    sharedCase,
    mission,
    providerMessageId: event.data.email_id,
    from: received.from,
    to: received.to.join(", "),
    subject: received.subject || `Re: ${sharedCase.subject}`,
    bodyText,
    receivedAt,
    senderMatches,
    senderAuthentication,
  });
  const messageId = inboundMessage.id;
  // A worker may fetch a more complete provider result than the initial
  // receipt. Carry it into the next processing-state write without issuing a
  // separate stale-snapshot update for a duplicate delivery.
  let inboundMetadata = inboundMessage.duplicate
    ? mergeJsonObject(inboundMessage.metadata, {
        sender_matches_recipient: senderMatches,
        sender_authentication: senderAuthentication,
      })
    : inboundMessage.metadata;
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

  const reviewReason = inboundReviewReason({
    senderMatches,
    senderAuthentication,
    requireEmailAuthentication,
  });

  if (deferProcessing) {
    const initialClosedStatus = await ignoreIfCaseClosed(sharedCase.id, messageId);
    if (initialClosedStatus) {
      inboundMetadata = mergeJsonObject(inboundMetadata, {
        processing_ignored_case_status: initialClosedStatus,
      });
      await updateInboundProcessingState(messageId, inboundMetadata, {
        status: "ignored",
        attempts: existingProcessing?.attempts ?? 0,
        providerEmailId: event.data.email_id,
        queuedAt: existingProcessing?.queuedAt ?? receivedAt,
        reason: "case_closed",
      });
      return {
        accepted: true,
        caseId: sharedCase.id,
        messageId,
        factCount: 0,
        attachmentCount: 0,
        processingStatus: "ignored",
      };
    }

    // The case address is a routing key, not proof that the sender or the
    // provider's authentication result is safe for automatic extraction.
    if (reviewReason) {
      const caseUpdated = await updateOpenInformationAgentCase(sharedCase.id, {
        status: "review",
        replied_at: receivedAt,
        metadata: mergeJsonObject(sharedCase.metadata, {
          last_inbound_email_id: event.data.email_id,
          last_inbound_sender_matches_recipient: senderMatches,
          last_inbound_sender_authentication_status: senderAuthentication.status,
        }),
      });
      await updateInboundProcessingState(messageId, inboundMetadata, {
        status: "review",
        attempts: existingProcessing?.attempts ?? 0,
        providerEmailId: event.data.email_id,
        queuedAt: existingProcessing?.queuedAt ?? receivedAt,
        reason: caseUpdated ? reviewReason : "case_closed_during_processing",
      });
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
      await updateInboundProcessingState(messageId, inboundMetadata, {
        status: "queued",
        attempts: existingProcessing?.attempts ?? 0,
        providerEmailId: event.data.email_id,
        queuedAt: existingProcessing?.queuedAt ?? receivedAt,
        attachmentLinkExpiresAt: new Date(
          Date.parse(receivedAt) + INBOUND_ATTACHMENT_LINK_TTL_MS,
        ).toISOString(),
      });
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

  inboundMetadata = await updateInboundProcessingState(messageId, inboundMetadata, {
    status: "processing",
    attempts: (existingProcessing?.attempts ?? 0) + 1,
    providerEmailId: event.data.email_id,
    queuedAt: existingProcessing?.queuedAt ?? receivedAt,
    startedAt: new Date().toISOString(),
    attachmentLinkExpiresAt: new Date(
      Date.parse(receivedAt) + INBOUND_ATTACHMENT_LINK_TTL_MS,
    ).toISOString(),
  });
  const initialClosedStatus = await ignoreIfCaseClosed(sharedCase.id, messageId);
  if (initialClosedStatus) {
    inboundMetadata = mergeJsonObject(inboundMetadata, {
      processing_ignored_case_status: initialClosedStatus,
    });
    await updateInboundProcessingState(messageId, inboundMetadata, {
      status: "ignored",
      attempts: inboundProcessingState(inboundMetadata)?.attempts ?? 1,
      providerEmailId: event.data.email_id,
      queuedAt: existingProcessing?.queuedAt ?? receivedAt,
      reason: "case_closed",
    });
    return {
      accepted: true,
      caseId: sharedCase.id,
      messageId,
      factCount: 0,
      attachmentCount: 0,
      processingStatus: "ignored",
    };
  }

  // The case address is a routing key, not proof that the sender or the
  // provider's authentication result is safe for automatic extraction.
  if (reviewReason) {
    const caseUpdated = await updateOpenInformationAgentCase(sharedCase.id, {
      status: "review",
      replied_at: receivedAt,
      metadata: mergeJsonObject(sharedCase.metadata, {
        last_inbound_email_id: event.data.email_id,
        last_inbound_sender_matches_recipient: senderMatches,
        last_inbound_sender_authentication_status: senderAuthentication.status,
      }),
    });
    if (!caseUpdated) {
      await updateInboundProcessingState(messageId, inboundMetadata, {
        status: "review",
        attempts: inboundProcessingState(inboundMetadata)?.attempts ?? 1,
        providerEmailId: event.data.email_id,
        queuedAt: existingProcessing?.queuedAt ?? receivedAt,
        reason: "case_closed_during_processing",
      });
      return {
        accepted: true,
        caseId: sharedCase.id,
        messageId,
        factCount: 0,
        attachmentCount: 0,
        processingStatus: "review",
      };
    }
    await updateInboundProcessingState(messageId, inboundMetadata, {
      status: "review",
      attempts: inboundProcessingState(inboundMetadata)?.attempts ?? 1,
      providerEmailId: event.data.email_id,
      queuedAt: existingProcessing?.queuedAt ?? receivedAt,
      reason: reviewReason,
    });
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
    const { attachments, truncated } = await fetchInboundAttachments(resend, event.data.email_id);
    const { stored: storedAssets, rejected } = await storeInboundAttachments({
      attachments,
      sharedCase,
      messageId,
      fetchImpl,
    });
    if (truncated)
      rejected.push({
        filename: "Lot de pièces jointes",
        reason: "Plus de 500 pièces jointes : traitement partiel, contrôle manuel requis",
      });
    if (rejected.length) {
      inboundMetadata = mergeJsonObject(inboundMetadata, {
        imported_manually: false,
        content_trust: "untrusted",
        sender_matches_recipient: senderMatches,
        rejected_attachment_count: rejected.length,
        rejected_attachments: rejected.slice(0, 50),
      });
      const { error } = await supabaseAdmin
        .from("information_agent_messages")
        .update({ metadata: inboundMetadata })
        .eq("id", messageId);
      if (error) throw error;
    }
    const closedStatus = await ignoreIfCaseClosed(sharedCase.id, messageId);
    if (closedStatus) {
      inboundMetadata = mergeJsonObject(inboundMetadata, {
        processing_ignored_case_status: closedStatus,
      });
      await updateInboundProcessingState(messageId, inboundMetadata, {
        status: "ignored",
        attempts: inboundProcessingState(inboundMetadata)?.attempts ?? 1,
        providerEmailId: event.data.email_id,
        queuedAt: existingProcessing?.queuedAt ?? receivedAt,
        reason: "case_closed",
      });
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
    await persistFactCandidates({
      sharedCase,
      messageId,
      facts: extractedFacts,
      assets: storedAssets,
    });

    const now = new Date().toISOString();
    const hasReviewableEvidence = Boolean(
      extractedFacts.length || storedAssets.length || rejected.length,
    );
    const caseUpdated = await updateInboundReplyCase({
      sharedCase,
      hasReviewableEvidence,
      replied_at: receivedAt,
      failure_reason: null,
      metadata: mergeJsonObject(sharedCase.metadata, {
        last_inbound_email_id: event.data.email_id,
        last_inbound_sender_matches_recipient: senderMatches,
        last_inbound_sender_authentication_status: senderAuthentication.status,
      }),
    });
    if (!caseUpdated) {
      await updateInboundProcessingState(messageId, inboundMetadata, {
        status: "review",
        attempts: inboundProcessingState(inboundMetadata)?.attempts ?? 1,
        providerEmailId: event.data.email_id,
        queuedAt: existingProcessing?.queuedAt ?? receivedAt,
        reason: "case_closed_during_processing",
      });
      return {
        accepted: true,
        caseId: sharedCase.id,
        messageId,
        factCount: extractedFacts.length + storedAssets.length,
        attachmentCount: storedAssets.length,
        processingStatus: "review",
      };
    }

    const { error: updateMissionsError } = await supabaseAdmin
      .from("information_agent_missions")
      .update({ status: "replied", replied_at: receivedAt, updated_at: now })
      .eq("case_id", sharedCase.id)
      .in("status", ["sent", "subscribed", "replied"]);
    if (updateMissionsError) throw updateMissionsError;

    const processingStatus =
      extractedFacts.length || storedAssets.length || rejected.length ? "review" : "completed";
    await updateInboundProcessingState(messageId, inboundMetadata, {
      status: processingStatus,
      attempts: inboundProcessingState(inboundMetadata)?.attempts ?? 1,
      providerEmailId: event.data.email_id,
      queuedAt: existingProcessing?.queuedAt ?? receivedAt,
      completedAt: now,
      reason: processingStatus === "review" ? "candidate_or_attachment_review" : undefined,
    });

    return {
      accepted: true,
      caseId: sharedCase.id,
      messageId,
      factCount: extractedFacts.length + storedAssets.length,
      attachmentCount: storedAssets.length,
      processingStatus,
    };
  } catch (error) {
    const currentProcessing = inboundProcessingState(inboundMetadata);
    await updateInboundProcessingState(messageId, inboundMetadata, {
      status: "failed",
      attempts: currentProcessing?.attempts ?? 1,
      providerEmailId: event.data.email_id,
      queuedAt: currentProcessing?.queuedAt ?? receivedAt,
      failedAt: new Date().toISOString(),
      nextAttemptAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      lastError: boundedInboundError(error),
    });
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
  const errors: string[] = [];

  for (const job of jobs ?? []) {
    if (
      Date.parse(job.attachment_link_expires_at) - now.getTime() <=
      INBOUND_ATTACHMENT_LINK_TTL_MS / 5
    ) {
      expiredLinkRisk++;
    }
    try {
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
        await markInboundMessageIgnored({
          messageId: job.message_id,
          providerEmailId: job.provider_email_id,
          queuedAt: job.created_at,
          caseStatus: sharedCase.status,
        });
        await settleInformationAgentInboundJob(job, "ignored");
        ignored++;
        continue;
      }

      const result = await ingestReceivedEmail({
        event: replayEventForInboundJob(job, sharedCase.inbound_token, inboundDomain),
        resend,
        inboundDomain,
        fetchImpl,
        requireEmailAuthentication: env.INFORMATION_AGENT_REQUIRE_EMAIL_AUTHENTICATION === "true",
      });
      const status: "completed" | "review" | "ignored" =
        result.processingStatus === "completed" || result.processingStatus === "review"
          ? result.processingStatus
          : result.processingStatus === "ignored" || result.ignored
            ? "ignored"
            : "review";
      await settleInformationAgentInboundJob(job, status);
      if (status === "completed") completed++;
      else if (status === "review") reviewed++;
      else if (status === "ignored") ignored++;
      else {
        failed++;
        errors.push(`Message ${job.provider_email_id}: statut inattendu ${status}`);
      }
    } catch (error) {
      failed++;
      const message = boundedInboundError(error);
      errors.push(`Message ${job.provider_email_id}: ${message}`);
      try {
        await failInformationAgentInboundJob(job, message, now);
      } catch (settleError) {
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
    expiredLinkRisk,
    errors,
  };
}

async function markInboundMessageIgnored({
  messageId,
  providerEmailId,
  queuedAt,
  caseStatus,
}: {
  messageId: string;
  providerEmailId: string;
  queuedAt: string;
  caseStatus: string;
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

async function settleInformationAgentInboundJob(
  job: Database["public"]["Tables"]["information_agent_inbound_jobs"]["Row"],
  status: "completed" | "review" | "ignored",
) {
  if (!job.lease_id) throw new Error("Lease de file entrante manquant.");
  const { error } = await supabaseAdmin
    .from("information_agent_inbound_jobs")
    .update({
      status,
      locked_at: null,
      lease_id: null,
      last_error: null,
    })
    .eq("id", job.id)
    .eq("lease_id", job.lease_id);
  if (error) throw error;
}

async function failInformationAgentInboundJob(
  job: Database["public"]["Tables"]["information_agent_inbound_jobs"]["Row"],
  errorMessage: string,
  now: Date,
) {
  if (!job.lease_id) throw new Error("Lease de file entrante manquant.");
  const delayMs = Math.min(10 * 60 * 1000, 30 * 1000 * 2 ** Math.max(0, job.attempts - 1));
  const terminalReview = job.attempts >= 10;
  const { error } = await supabaseAdmin
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
    .eq("lease_id", job.lease_id);
  if (error) throw error;
}

async function updateInboundReplyCase({
  sharedCase,
  hasReviewableEvidence,
  ...values
}: {
  sharedCase: SharedCase;
  hasReviewableEvidence: boolean;
  replied_at: string;
  failure_reason: null;
  metadata: Json;
}): Promise<boolean> {
  const keepReview = hasReviewableEvidence || sharedCase.status === "review";
  if (keepReview) {
    return updateOpenInformationAgentCase(sharedCase.id, {
      ...values,
      status: "review",
    });
  }

  const { data: repliedCase, error: repliedError } = await supabaseAdmin
    .from("information_agent_cases")
    .update({ ...values, status: "replied" })
    .eq("id", sharedCase.id)
    .in("status", ["sending", "sent", "replied"])
    .select("id")
    .maybeSingle();
  if (repliedError) throw repliedError;
  if (repliedCase) return true;

  // A concurrent response may have moved the case to review after the
  // snapshot above. Preserve that stronger state and update only its timing
  // metadata; never let this reply downgrade it back to replied.
  const { data: currentCase, error: currentError } = await supabaseAdmin
    .from("information_agent_cases")
    .select("status")
    .eq("id", sharedCase.id)
    .maybeSingle();
  if (currentError) throw currentError;
  if (currentCase?.status !== "review") return false;

  const { data: preservedCase, error: preserveError } = await supabaseAdmin
    .from("information_agent_cases")
    .update({ replied_at: values.replied_at })
    .eq("id", sharedCase.id)
    .eq("status", "review")
    .select("id")
    .maybeSingle();
  if (preserveError) throw preserveError;
  return Boolean(preservedCase);
}

async function updateOpenInformationAgentCase(
  caseId: string,
  values: Database["public"]["Tables"]["information_agent_cases"]["Update"],
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("information_agent_cases")
    .update(values)
    .eq("id", caseId)
    .in("status", [...OPEN_INFORMATION_AGENT_CASE_STATUSES])
    .select("id");
  if (error) throw error;
  return data?.some((row) => row.id === caseId) ?? false;
}

async function ignoreIfCaseClosed(caseId: string, messageId: string): Promise<string | null> {
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
  const { error: updateError } = await supabaseAdmin
    .from("information_agent_messages")
    .update({
      metadata: mergeJsonObject(message.metadata, {
        processing_ignored_case_status: currentCase.status,
      }),
    })
    .eq("id", messageId);
  if (updateError) throw updateError;
  return currentCase.status;
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
}): Promise<InboundMessageRef> {
  const id = randomUUID();
  const queuedAt = new Date().toISOString();
  const metadata: Json = {
    imported_manually: false,
    content_trust: "untrusted",
    sender_matches_recipient: senderMatches,
    sender_authentication: senderAuthentication,
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

async function updateInboundProcessingState(
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
): Promise<Json> {
  const previous = inboundProcessingState(currentMetadata);
  const state: Record<string, Json> = {
    version: previous?.version ?? INBOUND_PROCESSING_VERSION,
    status: patch.status,
    attempts: Math.max(0, Math.min(10, Math.trunc(patch.attempts))),
    provider_email_id: patch.providerEmailId,
    queued_at: previous?.queuedAt ?? patch.queuedAt,
  };
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
  const { error } = await supabaseAdmin
    .from("information_agent_messages")
    .update({ metadata: nextMetadata })
    .eq("id", messageId);
  if (error) throw error;
  return nextMetadata;
}

function normalizeInboundSenderAuthentication(value: unknown): InboundSenderAuthentication {
  const authentication =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const spf = normalizeInboundAuthenticationResult(authentication.spf);
  const dkim = normalizeInboundAuthenticationResult(authentication.dkim);
  const dmarc = normalizeInboundAuthenticationResult(authentication.dmarc);

  // DMARC passes when at least one aligned mechanism (SPF or DKIM) passes.
  // Do not require both mechanisms: legitimate forwarded or relayed mail can
  // fail one while still carrying a valid aligned result through the other.
  const hasAlignedAuthentication = dmarc === "pass" && (spf === "pass" || dkim === "pass");
  // A failed DMARC check, or failures from both alignment mechanisms, is an
  // explicit authentication failure. A single SPF/DKIM failure is compatible
  // with a passing DMARC result through the other aligned mechanism.
  const hasAuthenticationFailure = dmarc === "fail" || (spf === "fail" && dkim === "fail");

  return {
    status: hasAlignedAuthentication ? "pass" : hasAuthenticationFailure ? "fail" : "unverified",
    spf,
    dkim,
    dmarc,
  };
}

function normalizeInboundAuthenticationResult(
  value: unknown,
): NormalizedInboundAuthenticationResult {
  if (value === undefined || value === null) return "missing";
  return isResendAuthenticationResult(value) ? value : "unknown";
}

function isResendAuthenticationResult(value: unknown): value is ResendAuthenticationResult {
  return (
    typeof value === "string" &&
    (RESEND_AUTHENTICATION_RESULTS as readonly string[]).includes(value)
  );
}

function inboundReviewReason({
  senderMatches,
  senderAuthentication,
  requireEmailAuthentication,
}: {
  senderMatches: boolean;
  senderAuthentication: InboundSenderAuthentication;
  requireEmailAuthentication: boolean;
}): InboundReviewReason | null {
  if (!senderMatches) return "sender_mismatch";
  if (senderAuthentication.status === "fail") return "sender_authentication_failed";
  if (requireEmailAuthentication && senderAuthentication.status !== "pass") {
    return "sender_authentication_unverified";
  }
  return null;
}

function inboundProcessingState(metadata: Json): InboundProcessingState | null {
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

function jsonObject(value: Json | undefined): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asOptionalString(value: Json | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boundedInboundError(error: unknown): string {
  const value = error instanceof Error ? error.message : "Traitement entrant impossible.";
  return value.replace(/[\r\n]+/g, " ").slice(0, 500);
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

async function storeInboundAttachments({
  attachments,
  sharedCase,
  messageId,
  fetchImpl,
}: {
  attachments: AttachmentData[];
  sharedCase: SharedCase;
  messageId: string;
  fetchImpl: typeof fetch;
}) {
  const stored: Array<{
    id: string;
    filename: string;
    mimeType: string;
    storagePath: string;
    size: number;
  }> = [];
  const rejected: Array<{ filename: string; reason: string }> = [];
  let totalBytes = 0;

  for (const attachment of attachments) {
    const filename = safeFilename(attachment.filename || `piece-${attachment.id}`);
    const mimeType =
      typeof attachment.content_type === "string"
        ? attachment.content_type.split(";", 1)[0].trim().toLowerCase()
        : "";
    if (
      typeof attachment.id !== "string" ||
      attachment.id.length === 0 ||
      !ALLOWED_ATTACHMENT_MIME_TYPES.has(mimeType) ||
      !Number.isSafeInteger(attachment.size) ||
      attachment.size <= 0 ||
      attachment.size > MAX_ATTACHMENT_BYTES ||
      totalBytes + attachment.size > MAX_TOTAL_ATTACHMENT_BYTES
    ) {
      rejected.push({
        filename,
        reason: mimeType.startsWith("video/")
          ? "Vidéo non traitée : demander un autre mode de transmission"
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
      .eq("provider_attachment_id", attachment.id)
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
      response = await fetchImpl(attachment.download_url, {
        headers: { accept: mimeType },
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

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const attachmentKey = createHash("sha256").update(attachment.id).digest("hex");
    const storagePath = `${sharedCase.id}/${messageId}/${attachmentKey}/${sha256}-${filename}`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from("information-agent-evidence")
      .upload(storagePath, bytes, {
        contentType: mimeType,
        upsert: false,
      });
    if (uploadError && !/already exists|duplicate/i.test(uploadError.message)) throw uploadError;

    const { data: asset, error: assetError } = await supabaseAdmin
      .from("information_agent_evidence_assets")
      .insert({
        case_id: sharedCase.id,
        message_id: messageId,
        sale_id: sharedCase.sale_id,
        provider_attachment_id: attachment.id,
        storage_path: storagePath,
        original_filename: filename,
        mime_type: mimeType,
        size_bytes: bytes.length,
        sha256,
        metadata: { content_disposition: attachment.content_disposition },
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
        .eq("provider_attachment_id", attachment.id)
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
}) {
  const { data: sale, error: saleError } = await supabaseAdmin
    .from("auction_sales")
    .select("surface_m2,app_surface_m2,rooms_count,occupancy_status,sale_date,starting_price_eur")
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
    })),
  ];
  if (!rows.length) return;
  const { error } = await supabaseAdmin.from("information_agent_fact_candidates").upsert(rows, {
    onConflict: "message_id,fact_key,evidence_asset_id,source_page,display_value",
    ignoreDuplicates: true,
  });
  if (error) throw error;
}

export function findInboundToken(
  addresses: readonly string[],
  inboundDomain: string,
): string | null {
  const tokens = collectInboundTokens(addresses, inboundDomain);
  return tokens.length === 1 ? tokens[0] : null;
}

export function replyTextForExtraction(bodyText: string): string {
  const quotedStart =
    /^(?:-{2,}\s*(?:message d.origine|original message)\s*-{2,}|le .+ a écrit\s*:|on .+ wrote\s*:|de\s*:\s*.+@.+)$/im;
  const match = quotedStart.exec(bodyText);
  return (match ? bodyText.slice(0, match.index) : bodyText)
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .trim();
}

function collectInboundTokens(addresses: readonly string[], inboundDomain: string): string[] {
  const expectedDomain = inboundDomain.trim().toLowerCase();
  const localPartPattern =
    /^enquete\+([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
  const tokens = new Set<string>();
  for (const address of addresses) {
    const email = normalizeEmail(address);
    const separatorIndex = email.lastIndexOf("@");
    if (separatorIndex <= 0 || email.slice(separatorIndex + 1) !== expectedDomain) continue;
    const match = localPartPattern.exec(email.slice(0, separatorIndex));
    if (match?.[1]) tokens.add(match[1].toLowerCase());
  }
  return [...tokens];
}

export function htmlToPlainText(value: string) {
  let output = "";
  let suppressedDepth = 0;
  let quotedDepth = 0;
  const append = (text: string) => {
    if (output.length >= MAX_EXTRACTED_BODY_CHARS) return;
    output += text.slice(0, MAX_EXTRACTED_BODY_CHARS - output.length);
  };
  const parser = new Parser(
    {
      onopentag(name) {
        const tag = name.toLowerCase();
        if (tag === "script" || tag === "style") {
          suppressedDepth += 1;
        } else if (tag === "blockquote") {
          quotedDepth += 1;
        } else if (suppressedDepth === 0 && quotedDepth === 0 && HTML_LINE_BREAK_TAGS.has(tag)) {
          append("\n");
        }
      },
      ontext(text) {
        if (suppressedDepth === 0 && quotedDepth === 0) append(text);
      },
      onclosetag(name) {
        const tag = name.toLowerCase();
        if (tag === "script" || tag === "style") {
          suppressedDepth = Math.max(0, suppressedDepth - 1);
        } else if (tag === "blockquote") {
          quotedDepth = Math.max(0, quotedDepth - 1);
        } else if (suppressedDepth === 0 && quotedDepth === 0 && HTML_LINE_BREAK_TAGS.has(tag)) {
          append("\n");
        }
      },
    },
    { decodeEntities: true },
  );
  parser.end(value.slice(0, MAX_HTML_BODY_CHARS));
  return output
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractInformationAgentFacts(bodyText: string): ExtractedInformationAgentFact[] {
  const normalized = replyTextForExtraction(bodyText).replace(/\u00a0/g, " ");
  const facts: ExtractedInformationAgentFact[] = [];
  const surfaceMatches = [
    ...normalized.matchAll(
      /(?:surface(?:\s+(?:habitable|carrez|totale))?[^\d]{0,30})?(?<!\d)(\d{1,4}(?:[.,]\d{1,2})?)(?![\d.,])\s*m(?:²|2)(?![a-z0-9])/gi,
    ),
  ];
  const surfaceValues = new Set(surfaceMatches.map((match) => Number(match[1].replace(",", "."))));
  const surfaceMatch = surfaceValues.size === 1 ? surfaceMatches[0] : undefined;
  if (surfaceMatch) {
    const value = Number(surfaceMatch[1].replace(",", "."));
    if (value > 0 && value <= 1000000) {
      facts.push({
        factKey: "surface_m2",
        proposedValue: { value, unit: "m2" },
        displayValue: `${value.toLocaleString("fr-FR")} m²`,
        evidenceExcerpt: excerptAround(normalized, surfaceMatch.index ?? 0),
        confidence: /surface/i.test(surfaceMatch[0]) ? 0.88 : 0.7,
      });
    }
  }

  const roomsMatches = [...normalized.matchAll(/(?<!\d)(\d{1,2})(?!\d)\s+pi[eè]ces?\b/gi)];
  const roomValues = new Set(roomsMatches.map((match) => Number(match[1])));
  const roomsMatch = roomValues.size === 1 ? roomsMatches[0] : undefined;
  if (roomsMatch) {
    const value = Number(roomsMatch[1]);
    if (value >= 1 && value <= 100) {
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
  if (new Set(occupancyMatches.map((match) => match.value)).size === 1) {
    for (const { pattern, value, label } of occupancyMatches) {
      const match = normalized.match(pattern);
      if (!match) continue;
      facts.push({
        factKey: "occupancy_status",
        proposedValue: { value },
        displayValue: label,
        evidenceExcerpt: excerptAround(normalized, match.index ?? 0),
        confidence: 0.82,
      });
      break;
    }
  }

  const saleDateObservations = extractLabeledSaleDates(normalized);
  if (saleDateObservations.length) {
    const values = new Set(saleDateObservations.map((observation) => observation.value));
    if (values.size === 1) {
      const observation = saleDateObservations[0];
      if (observation) {
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
      if (observation) {
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

function conflictsWithSale(
  fact: ExtractedInformationAgentFact,
  sale: {
    surface_m2: number | null;
    app_surface_m2: number | null;
    rooms_count: number | null;
    occupancy_status: string | null;
    sale_date: string | null;
    starting_price_eur: number | null;
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
  if (fact.factKey === "occupancy_status") {
    return sale.occupancy_status != null && sale.occupancy_status !== value;
  }
  if (fact.factKey === "sale_date") {
    return sale.sale_date != null && String(sale.sale_date).slice(0, 10) !== String(value);
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
  return /(?<![\p{L}\p{N}])(?:pas|aucun[e]?|inconnu[e]?|non\s+communiqu[ée]e?|à\s+confirmer|a\s+confirmer|à\s+d[ée]finir|a\s+definir|sous\s+r[ée]serve|report[ée]e?|en\s+attente)(?![\p{L}\p{N}])/iu.test(
    value,
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

function cleanInboundBody(text: string | null, html: string | null) {
  const source =
    text?.trim() || htmlToPlainText(html || "") || "Réponse reçue sans corps de texte.";
  return source.slice(0, 16000);
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

function safeFilename(value: string) {
  const safe = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return safe || "piece-jointe";
}

function excerptAround(value: string, index: number) {
  return value.slice(Math.max(0, index - 80), Math.min(value.length, index + 240)).trim();
}

export function normalizeEmail(value: string) {
  const input = value.trim();
  if (!input) return "";

  const angleStart = input.indexOf("<");
  const angleEnd = input.indexOf(">");
  if (angleStart !== -1 || angleEnd !== -1) {
    if (
      angleStart < 0 ||
      angleEnd !== input.length - 1 ||
      input.indexOf("<", angleStart + 1) !== -1 ||
      input.indexOf(">", angleEnd + 1) !== -1 ||
      /[<>;,]/.test(input.slice(0, angleStart))
    ) {
      return "";
    }
    const address = input.slice(angleStart + 1, angleEnd).trim();
    return SIMPLE_EMAIL_PATTERN.test(address) ? address.toLowerCase() : "";
  }
  return SIMPLE_EMAIL_PATTERN.test(input) ? input.toLowerCase() : "";
}

const SIMPLE_EMAIL_PATTERN =
  /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)*$/i;

function requiredHeader(request: Request, name: string) {
  const value = request.headers.get(name)?.trim();
  if (!value) throw new Error(`Signature webhook incomplète: ${name}.`);
  return value;
}

function mergeJsonObject(current: Json, extra: Record<string, Json>): Json {
  const base = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  return { ...base, ...extra };
}
