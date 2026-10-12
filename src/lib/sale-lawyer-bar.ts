import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { tribunalBarAssociation } from "@/lib/lawyer-bar";

/**
 * Bar association of the tribunal judiciaire that holds a sale. The tribunal label is read first;
 * when it does not name the seat, the reference tribunal (by code) is used. The sale's own city,
 * postal code and department are never used.
 */
export async function resolveSaleBarAssociation(sale: {
  tribunal?: string | null;
  tribunal_code?: string | null;
}): Promise<string | null> {
  const fromLabel = tribunalBarAssociation(sale.tribunal);
  if (fromLabel) return fromLabel;

  const code = sale.tribunal_code?.trim();
  if (!code) return null;
  const { data, error } = await supabaseAdmin
    .from("tribunals")
    .select("canonical_name,city")
    .eq("code", code)
    .maybeSingle();
  if (error) throw error;
  return tribunalBarAssociation(data?.canonical_name) ?? (data?.city?.trim() || null);
}
