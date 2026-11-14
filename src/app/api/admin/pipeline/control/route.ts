import "server-only";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { adminRoute } from "@/lib/admin-route-deadline";
import { NotFoundError } from "@/lib/api-errors";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

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

export const PATCH = adminRoute(
  {
    scope: "admin.pipeline.control",
    fallbackMessage: "Contrôle du pipeline indisponible",
    guard: "admin",
  },
  async (request) => {
    const input = pipelineControlSettingsSchema.parse(await request.json());
    const { data, error } = await supabaseAdmin
      .from("auction_pipeline_control")
      .update({ ...input, updated_at: new Date().toISOString() })
      .eq("id", true)
      .select("*")
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new NotFoundError("Contrôle du pipeline introuvable");
    return data;
  },
);
