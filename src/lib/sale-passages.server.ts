import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { mapSalePassages, type SalePassagesResponse } from "@/lib/sale-passages";

/** Timeline and earlier passages of one sale (service role: the plan is checked by the caller). */
export async function getSalePassages(
  saleId: string,
  currentStartingPrice: number | null,
): Promise<Extract<SalePassagesResponse, { access: "full" }>> {
  const { data, error } = await supabaseAdmin.rpc("get_sale_passages", { p_sale_id: saleId });
  if (error) throw error;
  return mapSalePassages(data as Parameters<typeof mapSalePassages>[0], currentStartingPrice);
}
