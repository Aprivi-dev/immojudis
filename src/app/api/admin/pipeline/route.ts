import "server-only";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { adminRoute } from "@/lib/admin-route-deadline";
import { NotFoundError, PublicApiError } from "@/lib/api-errors";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

const OPTIONS = { scope: "admin.pipeline", fallbackMessage: "Supervision indisponible" };

export const GET = adminRoute({ ...OPTIONS, guard: "admin" }, async () => {
  const [sourcesResult, controlResult, alertsResult, usageResult] = await Promise.all([
    supabaseAdmin.from("auction_source_state").select("*").order("source_name"),
    supabaseAdmin.from("auction_pipeline_control").select("*").single(),
    supabaseAdmin
      .from("operational_alerts")
      .select("alert_key,status,details,notification_status,notification_event,last_seen_at")
      .like("alert_key", "pipeline.%")
      .order("last_seen_at", { ascending: false }),
    supabaseAdmin.rpc("pipeline_usage_summary"),
  ]);

  for (const result of [sourcesResult, controlResult, alertsResult, usageResult]) {
    if (result.error) throw result.error;
  }

  // The health observer appends one row per source on every tick. A global
  // limit therefore returns several rows for the busiest source and can
  // silently omit the others. Query the indexed latest row per configured
  // source so the admin panel always displays the current metric for each
  // source, plus the enrichment queue observation.
  const sourceNames = [
    ...(sourcesResult.data ?? []).map((source) => source.source_name),
    "enrichment-queue",
  ].filter((sourceName, index, names) => names.indexOf(sourceName) === index);
  const observationResults = await Promise.all(
    sourceNames.map((sourceName) =>
      supabaseAdmin
        .from("auction_pipeline_observations")
        .select("source_name,observed_at,metrics")
        .eq("source_name", sourceName)
        .order("observed_at", { ascending: false })
        .limit(1),
    ),
  );
  for (const result of observationResults) {
    if (result.error) throw result.error;
  }

  return {
    sources: sourcesResult.data,
    control: controlResult.data,
    observations: observationResults.flatMap((result) => result.data ?? []),
    alerts: alertsResult.data,
    usage: usageResult.data,
  };
});

export const PATCH = adminRoute({ ...OPTIONS, guard: "admin" }, async (request) => {
  const input = z
    .object({ source: z.string().min(1).max(60), enabled: z.boolean() })
    .strict()
    .parse(await request.json());
  const { data, error } = await supabaseAdmin
    .from("auction_source_state")
    .update({
      enabled: input.enabled,
      suspension_reason: input.enabled ? null : "Suspendue depuis l’administration",
      updated_at: new Date().toISOString(),
    })
    .eq("source_name", input.source)
    .select("source_name,enabled")
    .maybeSingle();
  // Une source retirée du catalogue ne se réactive pas ici : il faut lever le retrait
  // (select public.set_catalogue_source_withdrawal('<source>', false)).
  // (seule contrainte CHECK qu'une mise à jour de `enabled` peut enfreindre : code 23514)
  if (error?.code === "23514") {
    throw new PublicApiError(
      "Source retirée du catalogue : lever d'abord le retrait en base.",
      409,
    );
  }
  if (error) throw error;
  if (!data) throw new NotFoundError("Source inconnue");
  return data;
});
