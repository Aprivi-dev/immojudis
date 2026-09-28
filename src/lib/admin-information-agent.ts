import { randomUUID } from "node:crypto";
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

const REVIEW_PAGE_SIZE = 100;
const REVIEW_DONE_CURSOR = "__done__";
const reviewCursorSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
});

type AdminInformationAgentReviewListOptions = {
  factCursor?: string;
  messageCursor?: string;
};

export async function listAdminInformationAgentReview(
  authToken: string,
  options: AdminInformationAgentReviewListOptions = {},
) {
  await requireAdmin(authToken);
  const factCursor = parseReviewCursor(options.factCursor);
  const messageCursor = parseReviewCursor(options.messageCursor);

  let factQuery = supabaseAdmin
    .from("information_agent_fact_candidates")
    .select("*")
    .in("status", ["pending", "conflict"])
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (factCursor && factCursor !== REVIEW_DONE_CURSOR) {
    factQuery = factQuery.or(cursorFilter(factCursor, "asc"));
  }
  const { data: factRows, error: factsError } =
    factCursor === REVIEW_DONE_CURSOR
      ? { data: [], error: null }
      : await factQuery.range(0, REVIEW_PAGE_SIZE);
  if (factsError) throw factsError;
  const facts = (factRows ?? []).slice(0, REVIEW_PAGE_SIZE);

  // created_at is non-null for every message; pairing it with the UUID keeps
  // the cursor stable when several replies share the same timestamp.
  let messageQuery = supabaseAdmin
    .from("information_agent_messages")
    .select("id,case_id,from_email,subject,body_text,created_at,received_at,metadata")
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });
  if (messageCursor && messageCursor !== REVIEW_DONE_CURSOR) {
    messageQuery = messageQuery.or(cursorFilter(messageCursor, "desc"));
  }
  const { data: messageRows, error: messagesError } =
    messageCursor === REVIEW_DONE_CURSOR
      ? { data: [], error: null }
      : await messageQuery.range(0, REVIEW_PAGE_SIZE);
  if (messagesError) throw messagesError;
  const messages = (messageRows ?? []).slice(0, REVIEW_PAGE_SIZE);

  const caseIds = [
    ...new Set([
      ...(facts ?? []).map((fact) => fact.case_id),
      ...messages.flatMap((message) => (message.case_id ? [message.case_id] : [])),
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

  // A case can accumulate more evidence than PostgREST's default response
  // cap. The review page only needs assets linked to its facts.
  const evidenceAssetIds = [
    ...new Set(facts.flatMap((fact) => (fact.evidence_asset_id ? [fact.evidence_asset_id] : []))),
  ];
  const { data: assets, error: assetsError } = evidenceAssetIds.length
    ? await supabaseAdmin
        .from("information_agent_evidence_assets")
        .select("*")
        .in("id", evidenceAssetIds)
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
    facts,
    assets: assets ?? [],
    extractions: extractions ?? [],
    messages,
    hasMoreFacts: (factRows ?? []).length > REVIEW_PAGE_SIZE,
    nextFactsCursor:
      (factRows ?? []).length > REVIEW_PAGE_SIZE && facts.length
        ? encodeReviewCursor(facts[facts.length - 1])
        : null,
    hasMoreMessages: (messageRows ?? []).length > REVIEW_PAGE_SIZE,
    nextMessagesCursor:
      (messageRows ?? []).length > REVIEW_PAGE_SIZE && messages.length
        ? encodeReviewCursor(messages[messages.length - 1])
        : null,
  };
}

function parseReviewCursor(
  value: string | undefined,
): typeof REVIEW_DONE_CURSOR | z.output<typeof reviewCursorSchema> | null {
  if (!value) return null;
  if (value === REVIEW_DONE_CURSOR) return REVIEW_DONE_CURSOR;
  try {
    return reviewCursorSchema.parse(JSON.parse(value));
  } catch {
    throw new Error("Curseur de revue invalide.");
  }
}

function encodeReviewCursor(row: { created_at: string; id: string }): string {
  return JSON.stringify({ createdAt: row.created_at, id: row.id });
}

function cursorFilter(
  cursor: z.output<typeof reviewCursorSchema>,
  direction: "asc" | "desc",
): string {
  const operator = direction === "asc" ? "gt" : "lt";
  return `created_at.${operator}.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.${operator}.${cursor.id})`;
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
    const publication = await stageApprovedEvidencePublication(input.factId);
    if (publication) {
      try {
        const { data, error } = await callInformationAgentRpc(
          "review_information_agent_fact_candidate_with_path",
          {
            p_reviewer_id: auth.userId,
            p_fact_id: input.factId,
            p_decision: input.decision,
            p_notes: input.notes || null,
            p_expected_public_path: publication.publicPath,
          },
        );
        if (error) throw error;
        return { ok: true, result: data };
      } catch (error) {
        await abortFailedEvidencePublication(publication.factId, publication.publicPath);
        throw error;
      }
    }
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

type StagedEvidencePublication = {
  factId: string;
  publicPath: string;
};

type InformationAgentRpc = (
  functionName: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: unknown }>;

const callInformationAgentRpc: InformationAgentRpc = (functionName, args) =>
  (supabaseAdmin.rpc as unknown as InformationAgentRpc).call(supabaseAdmin, functionName, args);

async function stageApprovedEvidencePublication(
  factId: string,
): Promise<StagedEvidencePublication | null> {
  const { data: fact, error: factError } = await supabaseAdmin
    .from("information_agent_fact_candidates")
    .select("id,fact_key,evidence_asset_id,sale_id,status,case_id")
    .eq("id", factId)
    .single();
  if (factError) throw factError;
  if (fact.fact_key !== "document" && fact.fact_key !== "photo") return null;
  if (!fact.evidence_asset_id || (fact.status !== "pending" && fact.status !== "conflict")) {
    throw new Error("Pièce jointe non publiable dans son état actuel.");
  }
  const { data: informationCase, error: caseError } = await supabaseAdmin
    .from("information_agent_cases")
    .select("status")
    .eq("id", fact.case_id)
    .single();
  if (caseError) throw caseError;
  if (!reviewableCaseStatuses.has(informationCase.status)) {
    throw new Error("Le dossier n’est plus ouvert pour cette revue.");
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
  const { data: extraction, error: extractionError } = await supabaseAdmin
    .from("information_agent_evidence_extractions")
    .select("status")
    .eq("asset_id", asset.id)
    .single();
  if (extractionError || extraction?.status !== "completed") {
    throw new Error("L’analyse de la pièce doit être terminée avant sa publication.");
  }

  const attemptId = randomUUID();
  const publicPath =
    fact.fact_key === "photo"
      ? `${fact.sale_id}/${asset.id}/photo-${attemptId}.webp`
      : `${fact.sale_id}/${asset.id}/piece-jointe-${attemptId}.${extensionForMimeType(asset.mime_type)}`;
  const publicUrl = supabaseAdmin.storage
    .from("information-agent-approved")
    .getPublicUrl(publicPath).data.publicUrl;

  const { error: stageError } = await supabaseAdmin.rpc(
    "stage_information_agent_evidence_publication",
    {
      p_fact_id: fact.id,
      p_public_path: publicPath,
      p_public_url: publicUrl,
    },
  );
  if (stageError) throw stageError;

  try {
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
      if (uploadError) throw uploadError;
    } else {
      const { error: copyError } = await supabaseAdmin.storage
        .from(asset.storage_bucket)
        .copy(asset.storage_path, publicPath, { destinationBucket: "information-agent-approved" });
      if (copyError) throw copyError;
    }
  } catch (error) {
    await abortFailedEvidencePublication(fact.id, publicPath);
    throw error;
  }

  return { factId: fact.id, publicPath };
}

async function abortFailedEvidencePublication(factId: string, publicPath: string): Promise<void> {
  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await callInformationAgentRpc(
      "abort_information_agent_evidence_publication",
      { p_fact_id: factId, p_public_path: publicPath },
    ));
  } catch {
    return;
  }
  if (error || data !== true) return;

  try {
    await supabaseAdmin.storage.from("information-agent-approved").remove([publicPath]);
  } catch {
    // Keep the original publication error. A failed cleanup leaves the path for
    // the next operational cleanup pass rather than risking a broader delete.
  }
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

async function requireAdmin(authToken: string) {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");
  return auth;
}

const reviewableCaseStatuses = new Set(["sending", "sent", "replied", "review"]);
