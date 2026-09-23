import { z } from "zod";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { optimizeInformationAgentPhoto } from "@/lib/information-agent-image";
import {
  createAdminInformationAgentDraft,
  informationAgentAdminActionSchema,
  informationAgentCreateSchema,
  informationAgentListQuerySchema,
  listAdminInformationAgentMissions,
  runAdminInformationAgentAction,
  type InformationAgentAdminActionPayload,
  type InformationAgentAdminListResponse,
  type InformationAgentAdminResponse,
} from "@/lib/information-agent";

export const adminInformationAgentCreateSchema = informationAgentCreateSchema;
export const adminInformationAgentActionSchema = informationAgentAdminActionSchema;
export const adminInformationAgentListQuerySchema = informationAgentListQuerySchema;

export type AdminInformationAgentAction = InformationAgentAdminActionPayload;

export async function listAdminInformationAgentMissionsForToken({
  authToken,
  saleId,
}: {
  authToken: string;
  saleId?: string;
}): Promise<InformationAgentAdminListResponse> {
  const auth = await requireAdmin(authToken);
  return listAdminInformationAgentMissions({ auth, saleId });
}

export async function createAdminInformationAgentMissionForToken({
  authToken,
  input,
}: {
  authToken: string;
  input: z.output<typeof adminInformationAgentCreateSchema>;
}): Promise<InformationAgentAdminResponse> {
  const auth = await requireAdmin(authToken);
  return createAdminInformationAgentDraft({ auth, input });
}

export async function runAdminInformationAgentMissionActionForToken({
  authToken,
  input,
}: {
  authToken: string;
  input: AdminInformationAgentAction;
}): Promise<InformationAgentAdminListResponse> {
  const auth = await requireAdmin(authToken);
  return runAdminInformationAgentAction({ auth, input });
}

export const adminInformationAgentReviewSchema = z.object({
  factId: z.string().uuid(),
  decision: z.enum(["accepted", "rejected"]),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export type AdminInformationAgentReviewInput = z.output<typeof adminInformationAgentReviewSchema>;

export async function listAdminInformationAgentReview(authToken: string) {
  await requireAdmin(authToken);
  const { data: facts, error: factsError } = await supabaseAdmin
    .from("information_agent_fact_candidates")
    .select("*")
    .in("status", ["pending", "conflict"])
    .order("created_at", { ascending: true })
    .limit(100);
  if (factsError) throw factsError;

  const { data: inboundMessages, error: messagesError } = await supabaseAdmin
    .from("information_agent_messages")
    .select("id,case_id,metadata,received_at")
    .eq("direction", "inbound")
    .filter("metadata->>rejected_attachment_count", "gt", "0")
    .order("received_at", { ascending: false })
    .limit(100);
  if (messagesError) throw messagesError;
  const rejectedMessages = (inboundMessages ?? []).filter(
    (message): message is typeof message & { case_id: string } =>
      !!message.case_id && Number(jsonObject(message.metadata).rejected_attachment_count) > 0,
  );
  const caseIds = [
    ...new Set([
      ...(facts ?? []).map((fact) => fact.case_id),
      ...rejectedMessages.map((message) => message.case_id),
    ]),
  ];
  const { data: cases, error: casesError } = caseIds.length
    ? await supabaseAdmin
        .from("information_agent_cases")
        .select(
          "id,sale_id,status,recipient_name,recipient_email,subject,sent_at,replied_at,updated_at",
        )
        .in("id", caseIds)
        .order("updated_at", { ascending: false })
    : { data: [], error: null };
  if (casesError) throw casesError;

  const { data: assets, error: assetsError } = caseIds.length
    ? await supabaseAdmin
        .from("information_agent_evidence_assets")
        .select("*")
        .in("case_id", caseIds)
        .order("created_at", { ascending: true })
    : { data: [], error: null };
  if (assetsError) throw assetsError;

  const assetIds = (assets ?? []).map((asset) => asset.id);
  const { data: extractions, error: extractionsError } = assetIds.length
    ? await supabaseAdmin
        .from("information_agent_evidence_extractions")
        .select(
          "id,asset_id,status,detected_mime_type,document_kind,page_count,is_encrypted,summary,error_code,error_message,attempts,completed_at,created_at,updated_at",
        )
        .in("asset_id", assetIds)
        .order("created_at", { ascending: true })
    : { data: [], error: null };
  if (extractionsError) throw extractionsError;

  return {
    cases: cases ?? [],
    facts: facts ?? [],
    assets: assets ?? [],
    extractions: extractions ?? [],
    rejectedMessages,
  };
}

export type AdminInformationAgentReviewResponse = Awaited<
  ReturnType<typeof listAdminInformationAgentReview>
>;

export async function reviewAdminInformationAgentFact({
  authToken,
  input,
}: {
  authToken: string;
  input: AdminInformationAgentReviewInput;
}) {
  const auth = await requireAdmin(authToken);
  if (input.decision === "accepted") {
    await stageApprovedEvidencePublication(input.factId);
  }
  const { data, error } = await supabaseAdmin.rpc("review_information_agent_fact_candidate", {
    p_reviewer_id: auth.userId,
    p_fact_id: input.factId,
    p_decision: input.decision,
    p_notes: input.notes || null,
  });
  if (error) throw error;
  return { ok: true, result: data };
}

async function stageApprovedEvidencePublication(factId: string): Promise<void> {
  const { data: fact, error: factError } = await supabaseAdmin
    .from("information_agent_fact_candidates")
    .select("id,fact_key,evidence_asset_id,sale_id,status")
    .eq("id", factId)
    .single();
  if (factError) throw factError;
  if (fact.fact_key !== "document" && fact.fact_key !== "photo") return;
  if (!fact.evidence_asset_id || (fact.status !== "pending" && fact.status !== "conflict")) {
    throw new Error("Pièce jointe non publiable dans son état actuel.");
  }

  const { data: asset, error: assetError } = await supabaseAdmin
    .from("information_agent_evidence_assets")
    .select("id,storage_bucket,storage_path,mime_type,rights_status,metadata")
    .eq("id", fact.evidence_asset_id)
    .single();
  if (assetError) throw assetError;
  if (asset.rights_status !== "authorized") {
    throw new Error("Les droits de diffusion de cette pièce doivent d’abord être autorisés.");
  }

  const staged = jsonObject(asset.metadata);
  const stagedPath = stringValue(staged.approved_public_path);
  const stagedUrl = stringValue(staged.approved_public_url);
  const publicPath =
    fact.fact_key === "photo"
      ? `${fact.sale_id}/${asset.id}/photo-v1.webp`
      : (stagedPath ??
        `${fact.sale_id}/${asset.id}/piece-jointe.${extensionForMimeType(asset.mime_type)}`);
  const reusableStaging = stagedPath === publicPath && !!stagedUrl;

  if (!reusableStaging) {
    if (fact.fact_key === "photo") {
      const { data: original, error: downloadError } = await supabaseAdmin.storage
        .from(asset.storage_bucket)
        .download(asset.storage_path);
      if (downloadError || !original) throw downloadError ?? new Error("Photo source introuvable.");
      const derivative = await optimizeInformationAgentPhoto(
        new Uint8Array(await original.arrayBuffer()),
      );
      const { error: uploadError } = await supabaseAdmin.storage
        .from("information-agent-approved")
        .upload(publicPath, derivative, { contentType: "image/webp", upsert: false });
      if (uploadError && !/already exists|duplicate/i.test(uploadError.message)) throw uploadError;
    } else {
      const { error: copyError } = await supabaseAdmin.storage
        .from(asset.storage_bucket)
        .copy(asset.storage_path, publicPath, { destinationBucket: "information-agent-approved" });
      if (copyError && !/already exists|duplicate/i.test(copyError.message)) throw copyError;
    }
  }

  const publicUrl = reusableStaging
    ? stagedUrl
    : supabaseAdmin.storage.from("information-agent-approved").getPublicUrl(publicPath).data
        .publicUrl;
  if (
    fact.fact_key === "photo" &&
    stagedPath &&
    stagedPath !== publicPath &&
    stagedPath.startsWith(`${fact.sale_id}/${asset.id}/`)
  ) {
    const { error: removeError } = await supabaseAdmin.storage
      .from("information-agent-approved")
      .remove([stagedPath]);
    if (removeError) throw removeError;
  }
  const { error: stageError } = await supabaseAdmin.rpc(
    "stage_information_agent_evidence_publication",
    {
      p_fact_id: fact.id,
      p_public_path: publicPath,
      p_public_url: publicUrl,
    },
  );
  if (stageError) throw stageError;
}

function extensionForMimeType(mimeType: string): string {
  const extensions: Record<string, string> = {
    "application/pdf": "pdf",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
    "text/plain": "txt",
  };
  return extensions[mimeType] ?? "bin";
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function requireAdmin(authToken: string) {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");
  return auth;
}
