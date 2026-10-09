import "server-only";
import { NextResponse } from "next/server";
import { PublicApiError } from "@/lib/api-errors";
import { apiRouteError } from "@/lib/api-observability";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const evidenceRightsReviewSchema = z.object({
  rightsStatus: z.enum(["authorized", "restricted"]),
  notes: z.string().trim().max(1000).nullable().optional(),
});
const evidenceAssetIdSchema = z.string().uuid();
const privateEvidenceBucket = "information-agent-evidence";

const publicationRevocationConflict = new PublicApiError(
  "Cette pièce est déjà publiée ou préparée pour publication : révoquez d'abord la publication " +
    "(suppression de l'objet public et de ses références dans les ventes), puis marquez la pièce comme restreinte.",
  409,
);

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");
    const { id: rawId } = await context.params;
    const id = evidenceAssetIdSchema.parse(rawId);
    const { data: asset, error: assetError } = await supabaseAdmin
      .from("information_agent_evidence_assets")
      .select("storage_bucket,storage_path")
      .eq("id", id)
      .single();
    if (assetError) throw assetError;
    if (asset.storage_bucket !== privateEvidenceBucket) {
      throw new PublicApiError("Pièce indisponible.", 404);
    }

    const { data, error } = await supabaseAdmin.storage
      .from(asset.storage_bucket)
      .createSignedUrl(asset.storage_path, 10 * 60);
    if (error) throw error;
    if (new URL(request.url).searchParams.get("format") === "json") {
      return NextResponse.json(
        { signedUrl: data.signedUrl },
        { headers: { "cache-control": "private, no-store" } },
      );
    }
    return NextResponse.redirect(data.signedUrl, {
      status: 307,
      headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer" },
    });
  } catch (error) {
    return apiRouteError(error, request, "admin.information-agent.evidence.id", {
      fallbackMessage: "Pièce indisponible.",
      fallbackStatus: 404,
    });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");
    const { id: rawId } = await context.params;
    const id = evidenceAssetIdSchema.parse(rawId);
    const input = evidenceRightsReviewSchema.parse(await request.json());
    const { data: current, error: currentError } = await supabaseAdmin
      .from("information_agent_evidence_assets")
      .select("metadata,review_status")
      .eq("id", id)
      .single();
    if (currentError) throw currentError;

    if (
      input.rightsStatus === "restricted" &&
      (current.review_status === "accepted" || hasApprovedPublication(current.metadata))
    ) {
      throw publicationRevocationConflict;
    }

    const metadata =
      current.metadata && typeof current.metadata === "object" && !Array.isArray(current.metadata)
        ? current.metadata
        : {};
    let updateQuery = supabaseAdmin
      .from("information_agent_evidence_assets")
      .update({
        rights_status: input.rightsStatus,
        metadata: {
          ...metadata,
          rights_reviewed_at: new Date().toISOString(),
          rights_reviewed_by: auth.userId,
          rights_review_notes: input.notes || null,
        },
      })
      .eq("id", id);

    // Acceptance and rights review use separate requests. Keep this update
    // from changing an asset after an acceptance committed between the read
    // above and this write.
    if (input.rightsStatus === "restricted") {
      updateQuery = updateQuery.neq("review_status", "accepted");
    }

    const { data, error } = await updateQuery
      .select("id,rights_status,review_status")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw publicationRevocationConflict;
    return NextResponse.json(
      { ok: true, asset: data },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return apiRouteError(
      isRightsRestrictionConflict(error) ? publicationRevocationConflict : error,
      request,
      "admin.information-agent.evidence.id",
      { fallbackMessage: "Révision impossible." },
    );
  }
}

function hasApprovedPublication(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const record = metadata as Record<string, unknown>;
  return (
    hasNonEmptyString(record.approved_public_path) ||
    hasNonEmptyString(record.approved_public_url) ||
    hasNonEmptyString(record.publication_staged_at)
  );
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isRightsRestrictionConflict(candidate: unknown): boolean {
  return (
    !!candidate &&
    typeof candidate === "object" &&
    "code" in candidate &&
    candidate.code === "55000" &&
    "message" in candidate &&
    typeof candidate.message === "string" &&
    candidate.message.startsWith("Published or staged evidence")
  );
}
