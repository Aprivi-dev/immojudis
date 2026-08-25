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
      .select("metadata")
      .eq("id", id)
      .single();
    if (currentError) throw currentError;
    const metadata =
      current.metadata && typeof current.metadata === "object" && !Array.isArray(current.metadata)
        ? current.metadata
        : {};
    const { data, error } = await supabaseAdmin
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
      .eq("id", id)
      .select("id,rights_status,review_status")
      .single();
    if (error) throw error;
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
        : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
