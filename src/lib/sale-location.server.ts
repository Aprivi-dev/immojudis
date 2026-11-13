import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { SaleLocation } from "@/lib/commune-risks.server";
import {
  isPublicationQuarantinedGuardRow,
  PUBLICATION_QUARANTINE_SELECT,
} from "@/lib/sale-publication-guard";

/**
 * Location of a listing for the commune-level blocks (risks, climate).
 *
 * Same visibility rule as the listing page and the other per-sale routes: a
 * sale is refused only when it does not exist or is quarantined. The returned
 * coordinates stay on the server; callers only expose commune or station data.
 */
export async function loadVisibleSaleLocation(saleId: string): Promise<SaleLocation | null> {
  const { data, error } = await supabaseAdmin
    .from("auction_sales")
    .select(
      `latitude,longitude,city,postal_code,department,${PUBLICATION_QUARANTINE_SELECT}` as const,
    )
    .eq("id", saleId)
    .maybeSingle();
  if (error) throw error;
  if (!data || isPublicationQuarantinedGuardRow(data)) return null;
  return {
    latitude: data.latitude,
    longitude: data.longitude,
    city: data.city,
    postalCode: data.postal_code,
    department: data.department,
  };
}
