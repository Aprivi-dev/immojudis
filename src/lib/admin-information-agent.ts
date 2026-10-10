import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { adminPageQueryShape } from "@/lib/admin-page-query";
import { ADMIN_PAGE_SIZE, adminPageMeta } from "@/lib/admin-pagination";
import { optimizeInformationAgentPhoto } from "@/lib/information-agent-image";
import { flattenPdfForPublication } from "@/lib/information-agent-pdf";
import {
  createAdminInformationAgentDraft,
  informationAgentAdminActionSchema,
  informationAgentCreateSchema,
  informationAgentListQuerySchema,
  listAdminInformationAgentMissions,
  runAdminInformationAgentAction,
  type InformationAgentAdminActionPayload,
  type InformationAgentAdminListResponse,
  type InformationAgentAdminMissionPage,
  type InformationAgentAdminResponse,
} from "@/lib/information-agent";

export const adminInformationAgentCreateSchema = informationAgentCreateSchema;
export const adminInformationAgentActionSchema = informationAgentAdminActionSchema;
export const adminInformationAgentListQuerySchema = informationAgentListQuerySchema;

export type AdminInformationAgentAction = InformationAgentAdminActionPayload;

export async function listAdminInformationAgentMissionsForToken({
  authToken,
  saleId,
  offset,
  limit,
}: {
  authToken: string;
  saleId?: string;
  offset?: number;
  limit?: number;
}): Promise<InformationAgentAdminMissionPage> {
  const auth = await requireAdmin(authToken);
  return listAdminInformationAgentMissions({ auth, saleId, offset, limit });
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
  /** "Caviardage vérifié": required to accept a document or a photo for publication. */
  redactionConfirmed: z.boolean().optional(),
  redactionVerifiedBy: z.string().trim().min(3).max(120).optional(),
});

export type AdminInformationAgentReviewInput = z.output<typeof adminInformationAgentReviewSchema>;

export const adminInformationAgentReviewQuerySchema = z.object(adminPageQueryShape);

type AdminInformationAgentReviewListOptions = {
  offset?: number;
  limit?: number;
};

/**
 * Réponses reçues et faits à contrôler, 50 par page (`offset` / `limit`, validés par zod à la
 * route). Les deux listes avancent ensemble : la page N montre les lignes N·limit … de chacune,
 * `factsTotal` et `messagesTotal` donnent leur taille, `total` la plus grande des deux.
 */
export async function listAdminInformationAgentReview(
  authToken: string,
  options: AdminInformationAgentReviewListOptions = {},
) {
  await requireAdmin(authToken);
  const offset = options.offset ?? 0;
  const limit = options.limit ?? ADMIN_PAGE_SIZE;
  const to = offset + limit - 1;

  const [factsResult, messagesResult] = await Promise.all([
    supabaseAdmin
      .from("information_agent_fact_candidates")
      .select("*", { count: "exact" })
      .in("status", ["pending", "conflict"])
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, to),
    // created_at est non nul pour chaque message ; l'id départage les réponses simultanées.
    supabaseAdmin
      .from("information_agent_messages")
      .select("id,case_id,from_email,subject,body_text,created_at,received_at,metadata", {
        count: "exact",
      })
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, to),
  ]);
  if (factsResult.error) throw factsResult.error;
  if (messagesResult.error) throw messagesResult.error;
  const facts = factsResult.data ?? [];
  const messages = messagesResult.data ?? [];
  const factsTotal = factsResult.count ?? offset + facts.length;
  const messagesTotal = messagesResult.count ?? offset + messages.length;

  const caseIds = [
    ...new Set([
      ...facts.map((fact) => fact.case_id),
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

  // Un dossier peut accumuler plus de pièces que la limite de réponse de PostgREST : la page
  // de revue n'a besoin que des pièces liées à ses faits.
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
    factsTotal,
    messagesTotal,
    ...adminPageMeta({ offset, limit, total: Math.max(factsTotal, messagesTotal) }),
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
    const publication = await stageApprovedEvidencePublication(input.factId, {
      adminId: auth.userId,
      confirmed: input.redactionConfirmed === true,
      verifiedBy: input.redactionVerifiedBy ?? "",
    });
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

type RedactionCheck = { adminId: string; confirmed: boolean; verifiedBy: string };

export const REDACTION_CHECK_REQUIRED_MESSAGE =
  "Caviardage vérifié : cochez la case et indiquez le nom de la personne qui a contrôlé la pièce avant de la publier.";

async function stageApprovedEvidencePublication(
  factId: string,
  redaction: RedactionCheck,
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

  // Mandatory human step: someone checked that personal data is redacted on the visible pages.
  if (!redaction.confirmed || redaction.verifiedBy.trim().length < 3) {
    throw new Error(REDACTION_CHECK_REQUIRED_MESSAGE);
  }
  const publishable = publicRenditionKind(fact.fact_key, asset.mime_type);
  if (!publishable) {
    throw new Error(
      "Ce format de pièce ne peut pas être publié : seuls les PDF et les images le sont.",
    );
  }
  const { error: redactionError } = await supabaseAdmin
    .from("information_agent_evidence_assets")
    .update({
      metadata: {
        ...recordOrEmpty(asset.metadata),
        redaction_verified_at: new Date().toISOString(),
        redaction_verified_by: redaction.verifiedBy.trim(),
        redaction_verified_by_admin_id: redaction.adminId,
      },
    })
    .eq("id", asset.id);
  if (redactionError) throw redactionError;

  const attemptId = randomUUID();
  const publicPath =
    publishable === "photo"
      ? `${fact.sale_id}/${asset.id}/photo-${attemptId}.webp`
      : publishable === "image"
        ? `${fact.sale_id}/${asset.id}/piece-jointe-${attemptId}.webp`
        : `${fact.sale_id}/${asset.id}/piece-jointe-${attemptId}.pdf`;
  // The bucket is private: this URL only identifies the object (older guards validate its shape).
  // Readers obtain a 10-minute signed URL from /api/information-agent/evidence.
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
    // Never copy the original: every published rendition is rebuilt (photo/image re-encoded without
    // metadata, PDF flattened to page images without author/XMP), so hidden content cannot leak.
    const { data: original, error: downloadError } = await supabaseAdmin.storage
      .from(asset.storage_bucket)
      .download(asset.storage_path);
    if (downloadError || !original) throw downloadError ?? new Error("Pièce source introuvable.");
    const originalBytes = new Uint8Array(await original.arrayBuffer());
    const isPdf = publishable === "pdf";
    const rendition = isPdf
      ? await flattenPdfForPublication(originalBytes)
      : await optimizeInformationAgentPhoto(originalBytes);
    const { error: uploadError } = await supabaseAdmin.storage
      .from("information-agent-approved")
      .upload(publicPath, rendition, {
        contentType: isPdf ? "application/pdf" : "image/webp",
        upsert: false,
      });
    if (uploadError) throw uploadError;
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

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** What can be published for an attachment: photos and images become WebP, PDFs are flattened. */
export function publicRenditionKind(
  factKey: string,
  mimeType: string,
): "photo" | "image" | "pdf" | null {
  if (factKey === "photo") return mimeType.startsWith("image/") ? "photo" : null;
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("image/")) return "image";
  return null;
}

async function requireAdmin(authToken: string) {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");
  return auth;
}

const reviewableCaseStatuses = new Set(["sending", "sent", "replied", "review"]);
