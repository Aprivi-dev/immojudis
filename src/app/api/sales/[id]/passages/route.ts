import { NextResponse } from "next/server";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { PublicApiError } from "@/lib/api-errors";
import { apiRouteError } from "@/lib/api-observability";
import { featureIncludedForSale } from "@/lib/property-reports";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import type { SalePassagesResponse } from "@/lib/sale-passages";
import { getSalePassages } from "@/lib/sale-passages.server";
import { DETAIL_VIEW } from "@/lib/sale-views";
import { recordFeatureUsageEvent } from "@/lib/usage";

const saleIdSchema = z.string().uuid();

/**
 * « Historique de la vente ». Analyse, or a sale the account unlocked: the full
 * timeline and the earlier passages of the property. Other signed-in accounts:
 * the counts only, as an invitation to the offer. The sale must be visible to the caller first.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const saleId = saleIdSchema.parse((await context.params).id);
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "sale-passages",
      ...RATE_LIMIT_POLICIES.compute,
    });
    // Analyse, or a Découverte account that unlocked this very sale (« 3 déblocages par mois »).
    const full = await featureIncludedForSale(auth, "property.saleHistory", saleId);
    const { data: sale, error } = await auth.supabase
      .from(full ? DETAIL_VIEW : "v_auction_sales_discovery")
      .select("id, starting_price_eur")
      .eq("id", saleId)
      .maybeSingle();
    if (error) throw error;
    if (!sale) throw new PublicApiError("Vente introuvable.", 404);

    const passages = await getSalePassages(
      saleId,
      (sale as { starting_price_eur: number | null }).starting_price_eur,
    );
    let body: SalePassagesResponse = passages;
    if (full) {
      await recordFeatureUsageEvent({
        auth,
        eventKey: "sale_history.viewed",
        subjectType: "auction_sale",
        subjectId: saleId,
        metadata: { view: "passages", previous_passages: passages.summary.previousPassageCount },
      });
    } else {
      body = { access: "teaser", summary: passages.summary };
    }
    return NextResponse.json(body, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return apiRouteError(error, request, "sale-passages", {
      fallbackMessage: "Historique de la vente indisponible.",
    });
  }
}
