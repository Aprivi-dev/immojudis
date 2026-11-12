import { NextResponse } from "next/server";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { NotFoundError } from "@/lib/api-errors";
import { apiRoute } from "@/lib/api-route";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { getPrecomputedMarketEstimate } from "@/lib/sale-market-estimates";
import { buildValuePreview } from "@/lib/value-preview";

const saleIdSchema = z.string().guid();

/**
 * Valuation preview for any signed-in account: the estimated range and the gap
 * with the starting price. The detailed estimate, comparables and bid ceiling
 * stay with the Analyse offer (`/api/market-estimate`). Only stored estimates
 * are read: a free preview never triggers a new computation.
 */
export const GET = apiRoute<{ id: string }>(
  { scope: "value-preview", fallbackMessage: "Aperçu de la valeur indisponible." },
  async (request, { params }) => {
    const saleId = saleIdSchema.parse(params.id);
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "value-preview",
      ...RATE_LIMIT_POLICIES.compute,
    });
    const { data: sale, error } = await auth.supabase
      .from("v_auction_sales_discovery")
      .select("id, starting_price_eur, occupancy_status")
      .eq("id", saleId)
      .maybeSingle();
    if (error) throw error;
    if (!sale) throw new NotFoundError("Vente introuvable.");
    const preview = buildValuePreview(
      await getPrecomputedMarketEstimate(saleId),
      (sale as { starting_price_eur: number | null }).starting_price_eur,
      (sale as { occupancy_status: string | null }).occupancy_status,
    );
    return NextResponse.json(preview, {
      headers: { "cache-control": "private, max-age=300, stale-while-revalidate=3600" },
    });
  },
);
