import { NextResponse } from "next/server";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { PublicApiError } from "@/lib/api-errors";
import { apiRouteError } from "@/lib/api-observability";
import { getAuctionScenarios } from "@/lib/auction-scenarios.server";
import { assertFeatureEntitlement } from "@/lib/property-reports";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { DETAIL_VIEW } from "@/lib/sale-views";
import { recordFeatureUsageEvent } from "@/lib/usage";

const saleIdSchema = z.string().uuid();

/**
 * « Scénarios d'enchères » (offre Analyse) : chances de chaque issue et
 * fourchette de prix final, d'après les trois dernières années d'adjudications
 * du tribunal. The sale must be visible to the caller first.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const saleId = saleIdSchema.parse((await context.params).id);
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await assertFeatureEntitlement(
      auth,
      "property.advancedBidScenarios",
      "Les scénarios d’enchères sont réservés à l’offre Analyse.",
    );
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "auction-scenarios",
      ...RATE_LIMIT_POLICIES.compute,
    });
    const { data: sale, error } = await auth.supabase
      .from(DETAIL_VIEW)
      .select(
        "id, tribunal, tribunal_code, starting_price_eur, property_type, habitable_surface_m2, app_surface_m2",
      )
      .eq("id", saleId)
      .maybeSingle();
    if (error) throw error;
    if (!sale) throw new PublicApiError("Vente introuvable.", 404);

    const body = await getAuctionScenarios(sale as Parameters<typeof getAuctionScenarios>[0]);
    void recordFeatureUsageEvent({
      auth,
      eventKey: "sales.statistics_viewed",
      subjectType: "auction_sale",
      subjectId: saleId,
      metadata: {
        view: "auction_scenarios",
        court_sample: body.scenarios?.courtSample ?? 0,
        dvf_sample: body.history.dvf?.sample ?? 0,
      },
    }).catch(() => undefined);
    return NextResponse.json(body, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return apiRouteError(error, request, "auction-scenarios", {
      fallbackMessage: "Scénarios d’enchères indisponibles.",
    });
  }
}
