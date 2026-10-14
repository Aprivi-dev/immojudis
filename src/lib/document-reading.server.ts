import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { mapDocumentReading, type DocumentReadingResponse } from "@/lib/document-reading";
import { redactReadingTexts } from "@/lib/document-reading-redaction";

/**
 * Stored reading of one sale (service role: the plan is checked by the caller). The names of
 * private individuals in the quoted passages are replaced by their role.
 */
export async function getDocumentReading(
  saleId: string,
): Promise<Extract<DocumentReadingResponse, { access: "full" }>> {
  const { data, error } = await supabaseAdmin
    .from("auction_document_readings")
    .select("status,points,documents,generated_at,input_truncated")
    .eq("sale_id", saleId)
    .maybeSingle();
  if (error) throw error;
  return redactReadingTexts(mapDocumentReading(data));
}
