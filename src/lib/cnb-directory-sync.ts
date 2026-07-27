import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import {
  decodeCnbCsv,
  fetchCnbCsv,
  fetchLatestCnbDatasetResource,
  parseCnbRealEstateLawyers,
} from "@/lib/cnb-open-data";

type ImportInsert = Database["public"]["Tables"]["cnb_lawyer_directory_imports"]["Insert"];
type LawyerInsert = Database["public"]["Tables"]["cnb_lawyer_directory"]["Insert"];

const UPSERT_CHUNK_SIZE = 200;

export async function syncCnbLawyerDirectory(): Promise<Record<string, unknown>> {
  const resource = await fetchLatestCnbDatasetResource();
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("cnb_lawyer_directory_imports")
    .select("status,record_count")
    .eq("resource_id", resource.id)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing?.status === "success") {
    return {
      skipped: true,
      reason: "already_imported",
      resourceId: resource.id,
      records: existing.record_count,
    };
  }

  const startedAt = new Date();
  const importRow: ImportInsert = {
    resource_id: resource.id,
    resource_title: resource.title,
    resource_url: resource.url,
    source_published_at: resource.publishedAt,
    status: "running",
    record_count: 0,
    started_at: startedAt.toISOString(),
    completed_at: null,
    error_message: null,
  };
  const { error: startError } = await supabaseAdmin
    .from("cnb_lawyer_directory_imports")
    .upsert(importRow, { onConflict: "resource_id" });
  if (startError) throw startError;

  try {
    const bytes = await fetchCnbCsv(resource);
    const rows = parseCnbRealEstateLawyers(decodeCnbCsv(bytes), resource, startedAt);

    for (let index = 0; index < rows.length; index += UPSERT_CHUNK_SIZE) {
      const chunk = rows.slice(index, index + UPSERT_CHUNK_SIZE) satisfies LawyerInsert[];
      const { error } = await supabaseAdmin
        .from("cnb_lawyer_directory")
        .upsert(chunk, { onConflict: "source_key" });
      if (error) throw error;
    }

    const { data: removed, error: deleteError } = await supabaseAdmin
      .from("cnb_lawyer_directory")
      .delete()
      .neq("source_resource_id", resource.id)
      .select("source_key");
    if (deleteError) throw deleteError;

    const { error: completeError } = await supabaseAdmin
      .from("cnb_lawyer_directory_imports")
      .update({
        status: "success",
        record_count: rows.length,
        completed_at: new Date().toISOString(),
        error_message: null,
      })
      .eq("resource_id", resource.id);
    if (completeError) throw completeError;

    return {
      skipped: false,
      resourceId: resource.id,
      resourceTitle: resource.title,
      records: rows.length,
      removed: removed?.length ?? 0,
      sourcePublishedAt: resource.publishedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const { error: failureUpdateError } = await supabaseAdmin
      .from("cnb_lawyer_directory_imports")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        error_message: message.slice(0, 2_000),
      })
      .eq("resource_id", resource.id);
    if (failureUpdateError)
      console.error("[CNB] Impossible de consigner l'échec", failureUpdateError);
    throw error;
  }
}
