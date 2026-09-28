import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { POST as prepareUploadRoute } from "@/app/api/information-agent/contributions/[missionId]/upload/route";
import { POST as submitContributionRoute } from "@/app/api/information-agent/contributions/[missionId]/submit/route";
import { informationAgentContributionUrl } from "@/lib/information-agent-contribution";
import { processInformationAgentInboundWebhook } from "@/lib/information-agent-inbound";
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

const localEnv = () => {
  const url = process.env.SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !serviceKey || !publishableKey) {
    throw new Error("The local integration needs the Supabase URL and local keys.");
  }
  const hostname = new URL(url).hostname;
  if (!["127.0.0.1", "localhost"].includes(hostname)) {
    throw new Error("The information-agent integration refuses a non-local Supabase URL.");
  }
  return { url, serviceKey, publishableKey };
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
      if (requestUrl.pathname === `/emails/receiving/${RESEND_EMAIL_ID}`) {
        respondJson(response, {
          from: `Contact de test <${recipientEmail}>`,
          to: [`enquete+${inboundToken}@${INBOUND_DOMAIN}`],
          subject: "Re: Informations sur la vente",
          text: "La surface habitable est de 84 m².",
          html: null,
          created_at: "2026-09-28T12:00:00.000Z",
          authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
        });
        return;
      }
      if (requestUrl.pathname === `/emails/receiving/${RESEND_EMAIL_ID}/attachments`) {
        respondJson(response, {
          data: [
            {
              id: RESEND_ATTACHMENT_ID,
              filename: "reponse.pdf",
              content_type: "application/pdf",
              size: pdfBytes.byteLength,
              download_url: `${resendBaseUrl}/attachments/local.pdf`,
              content_disposition: "attachment",
            },
          ],
          has_more: false,
        });
        return;
      }
      if (requestUrl.pathname === "/attachments/local.pdf") {
        response.writeHead(200, { "content-type": "application/pdf" }).end(Buffer.from(pdfBytes));
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

    const { url, serviceKey, publishableKey } = localEnv();
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

    const { error: profileError } = await admin
      .from("user_profiles")
      .update({ user_role: "admin" })
      .eq("user_id", userId);
    if (profileError) throw profileError;

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
      const paths = [portalStoragePath, resendStoragePath].filter(Boolean);
      if (paths.length) await admin.storage.from(BUCKET).remove(paths);
      if (saleId) await admin.from("auction_sales").delete().eq("id", saleId);
      if (userId) await admin.auth.admin.deleteUser(userId);
    }
    if (resendServer) {
      await new Promise<void>((resolve, reject) =>
        resendServer?.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 30_000);

  it("runs signed portal upload, local Resend receipt, Storage persistence, and review", async () => {
    const contributionUrl = informationAgentContributionUrl(
      { id: missionId, created_at: (await missionRow()).created_at },
      process.env,
    );
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
      .uploadToSignedUrl(portalStoragePath, prepared.token, new Blob([pdfBytes]), {
        contentType: "application/pdf",
      });
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
});

async function missionRow() {
  const { data, error } = await admin
    .from("information_agent_missions")
    .select("created_at")
    .eq("id", missionId)
    .single();
  if (error || !data) throw error ?? new Error("Local mission missing.");
  return data as { created_at: string };
}

function respondJson(response: import("node:http").ServerResponse, body: unknown) {
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
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
