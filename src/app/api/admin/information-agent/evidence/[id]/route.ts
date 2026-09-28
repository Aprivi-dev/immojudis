import { NextResponse } from "next/server";
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

const publicationRevocationConflict =
  "Conflict: cette pièce est déjà publiée ou a déjà été préparée pour publication. " +
  "Révoquez d'abord la publication par une opération atomique qui supprime l'objet public " +
  "et toutes ses références dans les ventes, puis marquez la pièce comme restreinte.";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");
    const { id } = await context.params;
    const { data: asset, error: assetError } = await supabaseAdmin
      .from("information_agent_evidence_assets")
      .select("storage_bucket,storage_path")
      .eq("id", id)
      .single();
    if (assetError) throw assetError;

    const { data, error } = await supabaseAdmin.storage
      .from(asset.storage_bucket)
      .createSignedUrl(asset.storage_path, 10 * 60);
    if (error) throw error;
    return NextResponse.redirect(data.signedUrl, 307);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Pièce indisponible.";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.startsWith("Forbidden")
        ? 403
        : 404;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");
    const { id } = await context.params;
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
      throw new Error(publicationRevocationConflict);
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
    if (!data) throw new Error(publicationRevocationConflict);
    return NextResponse.json(
      { ok: true, asset: data },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Révision impossible.";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.startsWith("Forbidden")
        ? 403
        : message.startsWith("Conflict") || isRightsRestrictionConflict(error)
          ? 409
          : 400;
    return NextResponse.json({ error: message }, { status });
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

function isRightsRestrictionConflict(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "55000" &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.startsWith("Published or staged evidence")
  );
}
