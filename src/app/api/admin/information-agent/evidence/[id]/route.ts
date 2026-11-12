import "server-only";
import { assertAdminAuth } from "@/lib/admin-auth.server";
import { NextResponse } from "next/server";
import { NotFoundError, PublicApiError } from "@/lib/api-errors";
import { z } from "zod";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

const evidenceRightsReviewSchema = z.object({
  rightsStatus: z.enum(["authorized", "restricted"]),
  notes: z.string().trim().max(1000).nullable().optional(),
});
const evidenceAssetIdSchema = z.string().guid();
const privateEvidenceBucket = "information-agent-evidence";

const publicationRevocationConflict = new PublicApiError(
  "Cette pièce est déjà publiée ou préparée pour publication : révoquez d'abord la publication " +
    "(suppression de l'objet public et de ses références dans les ventes), puis marquez la pièce comme restreinte.",
  409,
);

export const GET = adminRoute<{ id: string }>(
  {
    scope: "admin.information-agent.evidence.id",
    fallbackMessage: "Pièce indisponible.",
    // Une pièce absente arrive comme une erreur de `.single()` : elle doit rester un 404.
    fallbackStatus: 404,
  },
  async (request, { params }) => {
    await assertAdminAuth(bearerTokenFromRequest(request));
    const id = evidenceAssetIdSchema.parse(params.id);
    const { data: asset, error: assetError } = await supabaseAdmin
      .from("information_agent_evidence_assets")
      .select("storage_bucket,storage_path")
      .eq("id", id)
      .single();
    if (assetError) throw assetError;
    if (asset.storage_bucket !== privateEvidenceBucket) {
      throw new NotFoundError("Pièce indisponible.");
    }

    const { data, error } = await supabaseAdmin.storage
      .from(asset.storage_bucket)
      .createSignedUrl(asset.storage_path, 10 * 60);
    if (error) throw error;
    if (new URL(request.url).searchParams.get("format") === "json") {
      return { signedUrl: data.signedUrl };
    }
    return NextResponse.redirect(data.signedUrl, {
      status: 307,
      headers: { "referrer-policy": "no-referrer" },
    });
  },
);

export const PATCH = adminRoute<{ id: string }>(
  { scope: "admin.information-agent.evidence.id", fallbackMessage: "Révision impossible." },
  async (request, { params }) => {
    try {
      const auth = await assertAdminAuth(bearerTokenFromRequest(request));
      const id = evidenceAssetIdSchema.parse(params.id);
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
      return { ok: true, asset: data };
    } catch (error) {
      throw isRightsRestrictionConflict(error) ? publicationRevocationConflict : error;
    }
  },
);

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
