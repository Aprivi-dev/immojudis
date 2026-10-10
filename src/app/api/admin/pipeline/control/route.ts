import "server-only";
import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const client = supabaseAdmin;

const pipelineControlSettingsSchema = z
  .object({
    enabled: z.boolean(),
    source_details_enabled: z.boolean(),
    max_ai_predictions_per_run: z.number().int().min(1).max(100),
    daily_ai_budget_usd: z.number().finite().min(0).max(10_000),
  })
  .strict()
  .partial()
  .refine((input) => Object.keys(input).length > 0, {
    message: "Au moins un paramètre de contrôle est requis",
  });

async function authorize(request: Request) {
  const context = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
  if (!context.isAdmin) throw new Error("Forbidden: accès administrateur requis");
}

function failure(error: unknown, request: Request) {
  return apiRouteError(error, request, "admin.pipeline.control", {
    fallbackMessage: "Contrôle du pipeline indisponible",
  });
}

export async function PATCH(request: Request) {
  try {
    await authorize(request);
    const input = pipelineControlSettingsSchema.parse(await request.json());
    const { data, error } = await client
      .from("auction_pipeline_control")
      .update({ ...input, updated_at: new Date().toISOString() })
      .eq("id", true)
      .select("*")
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return NextResponse.json({ error: "Contrôle du pipeline introuvable" }, { status: 404 });
    }

    return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return failure(error, request);
  }
}
