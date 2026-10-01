import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { POST as prepareUploadRoute } from "@/app/api/information-agent/contributions/[missionId]/upload/route";
import { POST as submitContributionRoute } from "@/app/api/information-agent/contributions/[missionId]/submit/route";
import { informationAgentContributionUrl } from "@/lib/information-agent-contribution";
import {
  processInformationAgentInboundWebhook,
  runInformationAgentInboundQueue,
} from "@/lib/information-agent-inbound";
import type { Database } from "@/integrations/supabase/types";

const enabled = process.env.IMMOJUDIS_LOCAL_INTEGRATION === "true";
const describeLocal = enabled ? describe : describe.skip;
const BUCKET = "information-agent-evidence";
const PORTAL_SECRET = "local-information-agent-portal-secret-32-bytes";
const INBOUND_DOMAIN = "reponses.example.test";
const RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from("local-resend-webhook-secret").toString("base64")}`;
const RESEND_EMAIL_ID = "resend-local-email-1";
const RESEND_ATTACHMENT_ID = "resend-local-attachment-1";

type LocalClient = ReturnType<typeof createClient<Database>>;

type LocalResendAttachmentFixture = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  downloadPath: string;
  bytes: Uint8Array;
};

type LocalResendFixture = {
  emailId: string;
  to: string[];
  from: string;
  subject: string;
  text: string;
  createdAt: string;
  attachments: LocalResendAttachmentFixture[];
};

let admin: LocalClient;
let userId: string;
let saleId: string;
let missionId: string;
let caseId: string;
let inboundToken: string;
let portalStoragePath: string;
let resendStoragePath: string;
let resendServer: Server | undefined;
let resendBaseUrl: string;
const resendFixtures = new Map<string, LocalResendFixture>();
const additionalSaleIds: string[] = [];

const localEnv = () => {
  const url = process.env.SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  const databaseUrl = process.env.SUPABASE_DB_URL?.trim();
  if (!url || !serviceKey || !publishableKey || !databaseUrl) {
    throw new Error("The local integration needs the Supabase URL, database URL, and local keys.");
  }
  if (
    !["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    !["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname)
  ) {
    throw new Error(
      "The information-agent integration refuses a non-local Supabase or database URL.",
    );
  }
  return { url, serviceKey, publishableKey, databaseUrl };
};

describeLocal("information-agent local integration", () => {
  const recipientEmail = "contact@example.test";
  const pdfBytes = new TextEncoder().encode("%PDF-1.7\nlocal information-agent fixture\n");

  beforeAll(async () => {
    resendServer = createServer((request, response) => {
      if (request.method !== "GET") {
        response.writeHead(405).end();
        return;
      }
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const receivingMatch = /^\/emails\/receiving\/([^/]+)(\/attachments)?$/.exec(
        requestUrl.pathname,
      );
      if (receivingMatch) {
        const fixture = resendFixtures.get(decodeURIComponent(receivingMatch[1] ?? ""));
        if (!fixture) {
          response.writeHead(404).end();
          return;
        }
        if (receivingMatch[2]) {
          respondJson(response, {
            data: fixture.attachments.map((attachment) => ({
              id: attachment.id,
              filename: attachment.filename,
              content_type: attachment.contentType,
              size: attachment.size,
              download_url: `${resendBaseUrl}${attachment.downloadPath}`,
              content_disposition: "attachment",
            })),
            has_more: false,
          });
          return;
        }
        respondJson(response, {
          from: fixture.from,
          to: fixture.to,
          subject: fixture.subject,
          text: fixture.text,
          html: null,
          created_at: fixture.createdAt,
          authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
        });
        return;
      }
      const attachment = [...resendFixtures.values()]
        .flatMap((fixture) => fixture.attachments)
        .find((candidate) => candidate.downloadPath === requestUrl.pathname);
      if (attachment) {
        response
          .writeHead(200, { "content-type": attachment.contentType })
          .end(Buffer.from(attachment.bytes));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      resendServer?.once("error", reject).listen(0, "127.0.0.1", resolve);
    });
    const address = resendServer.address();
    if (!address || typeof address === "string")
      throw new Error("Local Resend server did not start.");
    resendBaseUrl = `http://127.0.0.1:${address.port}`;

    const { url, serviceKey, publishableKey, databaseUrl } = localEnv();
    Object.assign(process.env, {
      SUPABASE_URL: url,
      NEXT_PUBLIC_SUPABASE_URL: url,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishableKey,
      INFORMATION_AGENT_PORTAL_SECRET: PORTAL_SECRET,
      INFORMATION_AGENT_INBOUND_DOMAIN: INBOUND_DOMAIN,
      RESEND_API_KEY: "local-resend-fixture-key",
      RESEND_BASE_URL: resendBaseUrl,
      RESEND_WEBHOOK_SECRET,
      INFORMATION_AGENT_REQUIRE_EMAIL_AUTHENTICATION: "true",
      SITE_URL: "https://portal.example.test",
    });
    admin = createClient<Database>(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const userEmail = `information-agent-${randomUUID()}@example.test`;
    const { data: createdUser, error: userError } = await admin.auth.admin.createUser({
      email: userEmail,
      password: "local-integration-password-123!",
      email_confirm: true,
    });
    if (userError || !createdUser.user) throw userError ?? new Error("Local user was not created.");
    userId = createdUser.user.id;

    // Role assignment is deliberately unavailable through the service-role
    // Data API. The isolated local test fixture uses its local DB owner.
    const localDatabase = postgres(databaseUrl, { max: 1 });
    try {
      await localDatabase`
        insert into public.user_profiles (user_id, email, user_role)
        values (${userId}, ${userEmail}, 'admin')
        on conflict (user_id) do update set user_role = 'admin'
      `;
    } finally {
      await localDatabase.end();
    }

    saleId = randomUUID();
    const sourceUrl = `https://example.test/local-information-agent/${saleId}`;
    const { error: saleError } = await admin.from("auction_sales").insert({
      id: saleId,
      source_name: "local-information-agent-integration",
      source_url: sourceUrl,
      title: "Local information-agent fixture",
      city: "Bordeaux",
      status: "upcoming",
      raw_payload: { integration: true },
    });
    if (saleError) throw saleError;

    missionId = randomUUID();
    const bodyText = "Merci de transmettre la surface et les pièces du bien.";
    const { data: mission, error: missionError } = await admin
      .from("information_agent_missions")
      .insert({
        id: missionId,
        user_id: userId,
        sale_id: saleId,
        status: "sent",
        recipient_kind: "manual_professional",
        recipient_name: "Contact de test",
        recipient_email: recipientEmail,
        subject: "Informations sur la vente",
        body_text: bodyText,
        question_keys: ["surface_m2"],
        missing_information: ["surface_m2"],
        sale_snapshot: { source_url: sourceUrl },
        privacy_version: "local-integration",
        metadata: { integration: true },
      })
      .select("id,created_at")
      .single();
    if (missionError || !mission) throw missionError ?? new Error("Local mission was not created.");

    caseId = randomUUID();
    inboundToken = randomUUID();
    const { error: caseError } = await admin.from("information_agent_cases").insert({
      id: caseId,
      sale_id: saleId,
      created_by: userId,
      status: "sent",
      recipient_kind: "manual_professional",
      recipient_name: "Contact de test",
      recipient_email: recipientEmail,
      normalized_recipient_email: recipientEmail,
      subject: "Informations sur la vente",
      body_text: bodyText,
      question_keys: ["surface_m2"],
      missing_information: ["surface_m2"],
      inbound_token: inboundToken,
      initiator_mission_id: mission.id,
      metadata: { integration: true },
    });
    if (caseError) throw caseError;

    const { error: missionLinkError } = await admin
      .from("information_agent_missions")
      .update({ case_id: caseId })
      .eq("id", missionId);
    if (missionLinkError) throw missionLinkError;
  }, 30_000);

  afterAll(async () => {
    if (admin) {
      const saleIds = [saleId, ...additionalSaleIds].filter(Boolean);
      const { data: evidenceAssets } = await admin
        .from("information_agent_evidence_assets")
        .select("storage_path")
        .in("sale_id", saleIds);
      const paths = [
        portalStoragePath,
        resendStoragePath,
        ...(evidenceAssets ?? []).map((asset) => asset.storage_path),
      ].filter(Boolean);
      if (paths.length) await admin.storage.from(BUCKET).remove(paths);
      for (const id of saleIds) await admin.from("auction_sales").delete().eq("id", id);
      if (userId) await admin.auth.admin.deleteUser(userId);
    }
    if (resendServer) {
      await new Promise<void>((resolve, reject) =>
        resendServer?.close((error) => (error ? reject(error) : resolve())),
      );
    }
    resendFixtures.clear();
  }, 30_000);

  it("runs signed portal upload, local Resend receipt, Storage persistence, and review", async () => {
    const contributionUrl = informationAgentContributionUrl(await missionRow(), process.env);
    expect(contributionUrl).toMatch(new RegExp(`/contribuer/${missionId}#`));

    const prepareResponse = await prepareUploadRoute(
      jsonRequest({
        filename: "piece.pdf",
        mimeType: "application/pdf",
        size: pdfBytes.byteLength,
        token: contributionUrl.split("#")[1],
      }),
      { params: Promise.resolve({ missionId }) },
    );
    expect(prepareResponse.status).toBe(200);
    const prepared = (await prepareResponse.json()) as {
      path: string;
      token: string;
      ticket: string;
    };
    portalStoragePath = prepared.path;
    expect(portalStoragePath).toContain(`${caseId}/portal/`);

    const { error: signedUploadError } = await admin.storage
      .from(BUCKET)
      .uploadToSignedUrl(
        portalStoragePath,
        prepared.token,
        new Blob([pdfBytes], { type: "application/pdf" }),
        { contentType: "application/pdf" },
      );
    if (signedUploadError) throw signedUploadError;

    const submitResponse = await submitContributionRoute(
      jsonRequest({
        token: contributionUrl.split("#")[1],
        submissionId: randomUUID(),
        senderName: "Contact de test",
        senderEmail: recipientEmail,
        note: "Voici la pièce demandée pour le dossier de test.",
        externalLinks: [],
        authorizedToTransmit: true,
        files: [
          {
            path: portalStoragePath,
            filename: "piece.pdf",
            mimeType: "application/pdf",
            size: pdfBytes.byteLength,
            ticket: prepared.ticket,
          },
        ],
      }),
      { params: Promise.resolve({ missionId }) },
    );
    expect(submitResponse.status).toBe(201);
    expect(await submitResponse.json()).toMatchObject({ ok: true, assetCount: 1 });

    const { data: portalAsset, error: portalAssetError } = await admin
      .from("information_agent_evidence_assets")
      .select("id,case_id,storage_path,sha256,review_status,rights_status")
      .eq("storage_path", portalStoragePath)
      .single();
    if (portalAssetError || !portalAsset)
      throw portalAssetError ?? new Error("Portal asset missing.");
    expect(portalAsset.case_id).toBe(caseId);
    expect(portalAsset.review_status).toBe("pending");
    expect(portalAsset.rights_status).toBe("unverified");

    const { data: downloadedPortal, error: portalDownloadError } = await admin.storage
      .from(BUCKET)
      .download(portalStoragePath);
    if (portalDownloadError || !downloadedPortal) {
      throw portalDownloadError ?? new Error("Portal object cannot be downloaded.");
    }
    expect(new Uint8Array(await downloadedPortal.arrayBuffer())).toEqual(pdfBytes);

    const { data: portalFact, error: portalFactError } = await admin
      .from("information_agent_fact_candidates")
      .select("id,evidence_asset_id,status,fact_key")
      .eq("evidence_asset_id", portalAsset.id)
      .single();
    if (portalFactError || !portalFact) throw portalFactError ?? new Error("Portal fact missing.");
    expect(portalFact.fact_key).toBe("document");
    expect(portalFact.status).toBe("pending");

    const { data: extraction, error: extractionError } = await admin
      .from("information_agent_evidence_extractions")
      .select("asset_id,status")
      .eq("asset_id", portalAsset.id)
      .single();
    if (extractionError || !extraction) {
      throw extractionError ?? new Error("Portal extraction queue row missing.");
    }
    expect(extraction.status).toBe("queued");

    const blockedAcceptance = await admin.rpc("review_information_agent_fact_candidate", {
      p_reviewer_id: userId,
      p_fact_id: portalFact.id,
      p_decision: "accepted",
      p_notes: "The local integration deliberately checks the attachment rights gate.",
    });
    expect(blockedAcceptance.error?.code).toBe("55000");

    const rejected = await admin.rpc("review_information_agent_fact_candidate", {
      p_reviewer_id: userId,
      p_fact_id: portalFact.id,
      p_decision: "rejected",
      p_notes: "Local integration fixture rejected after the gate check.",
    });
    if (rejected.error) throw rejected.error;

    const address = `enquete+${inboundToken}@${INBOUND_DOMAIN}`;
    registerResendFixture({
      emailId: RESEND_EMAIL_ID,
      to: [address],
      from: `Contact de test <${recipientEmail}>`,
      subject: "Re: Informations sur la vente",
      text: "La surface habitable est de 84 m².",
      createdAt: "2026-09-28T12:00:00.000Z",
      attachments: [
        {
          id: RESEND_ATTACHMENT_ID,
          filename: "reponse.pdf",
          contentType: "application/pdf",
          size: pdfBytes.byteLength,
          downloadPath: "/attachments/local.pdf",
          bytes: pdfBytes,
        },
      ],
    });
    const webhookPayload = JSON.stringify({
      type: "email.received",
      created_at: "2026-09-28T12:00:00.000Z",
      data: { email_id: RESEND_EMAIL_ID, to: [address], received_for: [address] },
    });
    const resendResponse = await processInformationAgentInboundWebhook({
      request: webhookRequest(webhookPayload, "local-svix-id"),
      deferProcessing: false,
    });
    expect(resendResponse).toMatchObject({
      accepted: true,
      caseId,
      attachmentCount: 1,
      processingStatus: "review",
    });

    const { data: inboundMessage, error: inboundMessageError } = await admin
      .from("information_agent_messages")
      .select("id,metadata")
      .eq("provider_message_id", RESEND_EMAIL_ID)
      .single();
    if (inboundMessageError || !inboundMessage) {
      throw inboundMessageError ?? new Error("Inbound message missing.");
    }
    expect(inboundMessage.metadata).toMatchObject({
      sender_authentication: { status: "pass", spf: "pass", dkim: "pass", dmarc: "pass" },
      inbound_processing: { status: "review" },
    });

    const { data: resendAsset, error: resendAssetError } = await admin
      .from("information_agent_evidence_assets")
      .select("id,storage_path,sha256,review_status")
      .eq("provider_attachment_id", RESEND_ATTACHMENT_ID)
      .single();
    if (resendAssetError || !resendAsset)
      throw resendAssetError ?? new Error("Resend asset missing.");
    resendStoragePath = resendAsset.storage_path;
    expect(resendAsset.review_status).toBe("pending");
    expect(resendStoragePath).toContain(`${caseId}/${inboundMessage.id}/`);

    const { data: downloadedResend, error: resendDownloadError } = await admin.storage
      .from(BUCKET)
      .download(resendStoragePath);
    if (resendDownloadError || !downloadedResend) {
      throw resendDownloadError ?? new Error("Resend object cannot be downloaded.");
    }
    expect(new Uint8Array(await downloadedResend.arrayBuffer())).toEqual(pdfBytes);

    const { data: surfaceFact, error: surfaceFactError } = await admin
      .from("information_agent_fact_candidates")
      .select("id,proposed_value,status")
      .eq("message_id", inboundMessage.id)
      .eq("fact_key", "surface_m2")
      .single();
    if (surfaceFactError || !surfaceFact) {
      throw surfaceFactError ?? new Error("Resend surface candidate missing.");
    }
    expect(surfaceFact.status).toBe("pending");

    const accepted = await admin.rpc("review_information_agent_fact_candidate", {
      p_reviewer_id: userId,
      p_fact_id: surfaceFact.id,
      p_decision: "accepted",
      p_notes: "Local integration review of the simulated provider response.",
    });
    if (accepted.error) throw accepted.error;
    expect(accepted.data).toMatchObject({ status: "accepted", sale_id: saleId });

    const { data: saleAfterReview, error: saleAfterReviewError } = await admin
      .from("auction_sales")
      .select("surface_m2,app_surface_m2,surface_source,raw_payload")
      .eq("id", saleId)
      .single();
    if (saleAfterReviewError || !saleAfterReview) {
      throw saleAfterReviewError ?? new Error("Reviewed sale missing.");
    }
    expect(Number(saleAfterReview.surface_m2)).toBe(84);
    expect(Number(saleAfterReview.app_surface_m2)).toBe(84);
    expect(saleAfterReview.surface_source).toBe("information_agent_verified");

    const duplicate = await processInformationAgentInboundWebhook({
      request: webhookRequest(webhookPayload, "local-svix-id-duplicate"),
      deferProcessing: false,
    });
    expect(duplicate).toMatchObject({ duplicate: true, processingStatus: "review" });
    const { count: duplicateAssetCount, error: duplicateAssetCountError } = await admin
      .from("information_agent_evidence_assets")
      .select("id", { count: "exact", head: true })
      .eq("provider_attachment_id", RESEND_ATTACHMENT_ID);
    if (duplicateAssetCountError) throw duplicateAssetCountError;
    expect(duplicateAssetCount).toBe(1);
  }, 30_000);

  it("retries after a post-candidate failure without crossing into another sale", async () => {
    const retryFixture = await createAdditionalConversation("retry");
    const retryEmailId = "resend-local-retry-email";
    const retryAttachmentId = "resend-local-retry-attachment";
    const retryBytes = new TextEncoder().encode(
      "%PDF-1.7\nlocal retry fixture stored before the failure\n",
    );
    const address = `enquete+${retryFixture.inboundToken}@${INBOUND_DOMAIN}`;
    registerResendFixture({
      emailId: retryEmailId,
      to: [address],
      from: `Contact de test <${recipientEmail}>`,
      subject: "Re: Informations sur la vente retry",
      text: "La surface habitable est de 91 m² et le bien comprend 3 pièces.",
      createdAt: "2026-09-28T12:05:00.000Z",
      attachments: [
        {
          id: retryAttachmentId,
          filename: "reponse-retry.pdf",
          contentType: "application/pdf",
          size: retryBytes.byteLength,
          downloadPath: "/attachments/retry.pdf",
          bytes: retryBytes,
        },
      ],
    });
    const webhookPayload = JSON.stringify({
      type: "email.received",
      created_at: "2026-09-28T12:05:00.000Z",
      data: { email_id: retryEmailId, to: [address], received_for: [address] },
    });
    const { databaseUrl } = localEnv();
    const firstWorkerNow = new Date(Date.now() + 1_000);

    await withTransientMissionReplyFailure(databaseUrl, async () => {
      const queued = await processInformationAgentInboundWebhook({
        request: webhookRequest(webhookPayload, "local-svix-id-retry-first"),
        deferProcessing: true,
      });
      expect(queued).toMatchObject({
        accepted: true,
        caseId: retryFixture.caseId,
        attachmentCount: 0,
        processingStatus: "queued",
      });

      const firstWorker = await runInformationAgentInboundQueue({
        env: process.env,
        now: firstWorkerNow,
        limit: 1,
      });
      expect(firstWorker).toMatchObject({ claimed: 1, reviewed: 0, failed: 1 });
    });

    const { data: failedMessage, error: failedMessageError } = await admin
      .from("information_agent_messages")
      .select("id,metadata")
      .eq("provider_message_id", retryEmailId)
      .single();
    if (failedMessageError || !failedMessage) {
      throw failedMessageError ?? new Error("Failed retry message missing.");
    }
    expect(failedMessage.metadata).toMatchObject({
      inbound_processing: {
        status: "failed",
        attempts: 1,
        last_error: "Traitement entrant impossible.",
      },
    });

    const { data: failedJob, error: failedJobError } = await admin
      .from("information_agent_inbound_jobs")
      .select("status,attempts,last_error")
      .eq("provider_email_id", retryEmailId)
      .single();
    if (failedJobError || !failedJob) {
      throw failedJobError ?? new Error("Failed retry job missing.");
    }
    expect(failedJob).toMatchObject({
      status: "failed",
      attempts: 1,
      last_error: "Traitement entrant impossible.",
    });

    const { data: storedAsset, error: storedAssetError } = await admin
      .from("information_agent_evidence_assets")
      .select("id,case_id,sale_id,storage_path,provider_attachment_id")
      .eq("provider_attachment_id", retryAttachmentId)
      .single();
    if (storedAssetError || !storedAsset) {
      throw storedAssetError ?? new Error("Stored retry attachment missing.");
    }
    expect(storedAsset).toMatchObject({
      case_id: retryFixture.caseId,
      sale_id: retryFixture.saleId,
      provider_attachment_id: retryAttachmentId,
    });
    const { data: storedBytes, error: storedBytesError } = await admin.storage
      .from(BUCKET)
      .download(storedAsset.storage_path);
    if (storedBytesError || !storedBytes) {
      throw storedBytesError ?? new Error("Stored retry attachment cannot be downloaded.");
    }
    expect(new Uint8Array(await storedBytes.arrayBuffer())).toEqual(retryBytes);

    const { data: failedFacts, error: failedFactsError } = await admin
      .from("information_agent_fact_candidates")
      .select("id,case_id,sale_id,fact_key")
      .eq("message_id", failedMessage.id);
    if (failedFactsError) throw failedFactsError;
    expect(failedFacts).toHaveLength(3);
    expect(failedFacts?.every((fact) => fact.case_id === retryFixture.caseId)).toBe(true);
    expect(failedFacts?.every((fact) => fact.sale_id === retryFixture.saleId)).toBe(true);

    const { count: crossSaleAssetCount, error: crossSaleAssetError } = await admin
      .from("information_agent_evidence_assets")
      .select("id", { count: "exact", head: true })
      .eq("sale_id", saleId)
      .eq("provider_attachment_id", retryAttachmentId);
    if (crossSaleAssetError) throw crossSaleAssetError;
    expect(crossSaleAssetCount).toBe(0);

    const retry = await runInformationAgentInboundQueue({
      env: process.env,
      now: new Date(firstWorkerNow.getTime() + 31_000),
      limit: 1,
    });
    expect(retry).toMatchObject({ claimed: 1, completed: 0, reviewed: 1, failed: 0 });

    const { count: assetCount, error: assetCountError } = await admin
      .from("information_agent_evidence_assets")
      .select("id", { count: "exact", head: true })
      .eq("provider_attachment_id", retryAttachmentId);
    if (assetCountError) throw assetCountError;
    expect(assetCount).toBe(1);

    const { count: factCount, error: factCountError } = await admin
      .from("information_agent_fact_candidates")
      .select("id", { count: "exact", head: true })
      .eq("message_id", failedMessage.id);
    if (factCountError) throw factCountError;
    expect(factCount).toBe(3);

    const { data: completedMessage, error: completedMessageError } = await admin
      .from("information_agent_messages")
      .select("metadata")
      .eq("id", failedMessage.id)
      .single();
    if (completedMessageError || !completedMessage) {
      throw completedMessageError ?? new Error("Retried message missing.");
    }
    expect(completedMessage.metadata).toMatchObject({
      inbound_processing: { status: "review", attempts: 2 },
    });

    const { data: retriedJob, error: retriedJobError } = await admin
      .from("information_agent_inbound_jobs")
      .select("status,attempts,lease_id,last_error")
      .eq("provider_email_id", retryEmailId)
      .single();
    if (retriedJobError || !retriedJob) {
      throw retriedJobError ?? new Error("Retried inbound job missing.");
    }
    expect(retriedJob).toMatchObject({
      status: "review",
      attempts: 2,
      lease_id: null,
      last_error: null,
    });

    // Simulate a worker dying after its tenth claim: the next scheduler pass
    // must release the stale lease and make the message visible for review.
    const terminalClaimNow = new Date(firstWorkerNow.getTime() + 11 * 60_000);
    const { error: staleLeaseError } = await admin
      .from("information_agent_inbound_jobs")
      .update({
        status: "processing",
        attempts: 10,
        locked_at: firstWorkerNow.toISOString(),
        lease_id: randomUUID(),
        last_error: null,
      })
      .eq("provider_email_id", retryEmailId);
    if (staleLeaseError) throw staleLeaseError;

    const { error: terminalClaimError } = await admin.rpc("claim_information_agent_inbound_jobs", {
      p_limit: 1,
      p_now: terminalClaimNow.toISOString(),
    });
    if (terminalClaimError) throw terminalClaimError;

    const { data: recoveredJob, error: recoveredJobError } = await admin
      .from("information_agent_inbound_jobs")
      .select("status,attempts,lease_id,locked_at,last_error")
      .eq("provider_email_id", retryEmailId)
      .single();
    if (recoveredJobError || !recoveredJob) {
      throw recoveredJobError ?? new Error("Expired final-attempt lease was not found.");
    }
    expect(recoveredJob).toMatchObject({
      status: "review",
      attempts: 10,
      lease_id: null,
      locked_at: null,
      last_error: "Inbound worker lease expired after retry budget was exhausted.",
    });
  }, 30_000);
});

async function missionRow() {
  const { data, error } = await admin
    .from("information_agent_missions")
    .select("id,created_at,case_id,recipient_email,contribution_token_version")
    .eq("id", missionId)
    .single();
  if (error || !data) throw error ?? new Error("Local mission missing.");
  return data as {
    id: string;
    created_at: string;
    case_id: string;
    recipient_email: string;
    contribution_token_version: number;
  };
}

function respondJson(response: import("node:http").ServerResponse, body: unknown) {
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function registerResendFixture(fixture: LocalResendFixture) {
  resendFixtures.set(fixture.emailId, fixture);
}

async function createAdditionalConversation(prefix: string) {
  const newSaleId = randomUUID();
  const newMissionId = randomUUID();
  const newCaseId = randomUUID();
  const newInboundToken = randomUUID();
  const sourceUrl = `https://example.test/local-information-agent/${prefix}/${newSaleId}`;
  const bodyText = "Merci de transmettre les informations du bien demandé.";

  const { error: saleError } = await admin.from("auction_sales").insert({
    id: newSaleId,
    source_name: "local-information-agent-integration",
    source_url: sourceUrl,
    title: `Local information-agent ${prefix} fixture`,
    city: "Bordeaux",
    status: "upcoming",
    raw_payload: { integration: true, prefix },
  });
  if (saleError) throw saleError;
  additionalSaleIds.push(newSaleId);

  const { data: mission, error: missionError } = await admin
    .from("information_agent_missions")
    .insert({
      id: newMissionId,
      user_id: userId,
      sale_id: newSaleId,
      status: "sent",
      recipient_kind: "manual_professional",
      recipient_name: "Contact de test",
      recipient_email: "contact@example.test",
      subject: `Informations sur la vente ${prefix}`,
      body_text: bodyText,
      question_keys: ["surface_m2"],
      missing_information: ["surface_m2"],
      sale_snapshot: { source_url: sourceUrl },
      privacy_version: "local-integration",
      metadata: { integration: true, prefix },
    })
    .select("id")
    .single();
  if (missionError || !mission) {
    throw missionError ?? new Error("Retry mission was not created.");
  }

  const { error: caseError } = await admin.from("information_agent_cases").insert({
    id: newCaseId,
    sale_id: newSaleId,
    created_by: userId,
    status: "sent",
    recipient_kind: "manual_professional",
    recipient_name: "Contact de test",
    recipient_email: "contact@example.test",
    normalized_recipient_email: "contact@example.test",
    subject: `Informations sur la vente ${prefix}`,
    body_text: bodyText,
    question_keys: ["surface_m2"],
    missing_information: ["surface_m2"],
    inbound_token: newInboundToken,
    initiator_mission_id: mission.id,
    metadata: { integration: true, prefix },
  });
  if (caseError) throw caseError;

  const { error: missionLinkError } = await admin
    .from("information_agent_missions")
    .update({ case_id: newCaseId })
    .eq("id", newMissionId);
  if (missionLinkError) throw missionLinkError;

  return {
    saleId: newSaleId,
    missionId: newMissionId,
    caseId: newCaseId,
    inboundToken: newInboundToken,
  };
}

async function withTransientMissionReplyFailure<T>(
  databaseUrl: string,
  action: () => Promise<T>,
): Promise<T> {
  const setupDatabase = postgres(databaseUrl, { max: 1 });
  try {
    await setupDatabase.unsafe(`
      drop trigger if exists information_agent_local_fail_once_trigger
        on public.information_agent_missions;
      drop function if exists public.information_agent_local_fail_once();
      drop sequence if exists public.information_agent_local_fail_once_seq;
      create sequence public.information_agent_local_fail_once_seq;
      create function public.information_agent_local_fail_once()
      returns trigger
      language plpgsql
      security definer
      set search_path = public
      as $function$
      begin
        if new.status = 'replied'
           and nextval('public.information_agent_local_fail_once_seq') = 1 then
          raise exception 'local candidate checkpoint failure';
        end if;
        return new;
      end;
      $function$;
      create trigger information_agent_local_fail_once_trigger
      before update of status on public.information_agent_missions
      for each row execute function public.information_agent_local_fail_once();
    `);
  } finally {
    await setupDatabase.end();
  }

  try {
    return await action();
  } finally {
    const cleanupDatabase = postgres(databaseUrl, { max: 1 });
    try {
      await cleanupDatabase.unsafe(`
        drop trigger if exists information_agent_local_fail_once_trigger
          on public.information_agent_missions;
        drop function if exists public.information_agent_local_fail_once();
        drop sequence if exists public.information_agent_local_fail_once_seq;
      `);
    } finally {
      await cleanupDatabase.end();
    }
  }
}

function webhookRequest(payload: string, id: string): Request {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac(
    "sha256",
    Buffer.from(RESEND_WEBHOOK_SECRET.slice("whsec_".length), "base64"),
  )
    .update(`${id}.${timestamp}.${payload}`)
    .digest("base64");
  return new Request("http://127.0.0.1/api/webhooks/resend/information-agent", {
    method: "POST",
    headers: {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    },
    body: payload,
  });
}

function jsonRequest(body: Record<string, unknown>): Request {
  return new Request("http://127.0.0.1/api/information-agent/contributions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
