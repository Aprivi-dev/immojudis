import { NextResponse } from "next/server";
import { recordAccountProductEvent } from "@/lib/account-product-events.server";
import { apiRouteError } from "@/lib/api-observability";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { PublicApiError } from "@/lib/api-errors";
import { DETAIL_VIEW, DISCOVERY_VIEW } from "@/lib/sale-views";
import { assertFeatureEntitlementVia, featureIncludedForSale } from "@/lib/property-reports";
import { ceilingMarketContext } from "@/lib/market-estimate-ceiling";
import { refreshSaleValuationOnDemand } from "@/lib/sale-market-estimates";
import { recordFeatureUsageEvent } from "@/lib/usage";
import { z } from "zod";

const requestSchema = z.object({ saleId: z.string().guid() });

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "market-estimate",
      ...RATE_LIMIT_POLICIES.compute,
    });
    const { saleId } = requestSchema.parse(await request.json());
    // Analyse reads the detailed estimate. A Découverte account that unlocked this very sale
    // (« 3 déblocages par mois ») gets the reference value under the bid-ceiling right, reduced to
    // what the ceiling reads: the detailed estimate (range, quartiles, comparables) stays with
    // Analyse.
    const detailed = await featureIncludedForSale(auth, "property.valueEstimate", saleId);
    if (!detailed) {
      await assertFeatureEntitlementVia(
        auth,
        "property.bidCeiling",
        "Estimation de marché réservée à l’offre Analyse.",
        { saleId },
      );
    }
    // Same visibility rule as the sale page: the sale must be readable by this user in
    // the catalogue view (published and ready), not merely present in auction_sales. An unlock
    // reads the redacted catalogue view; its right to the sale was confirmed just above.
    const { data: visibleSale, error: visibilityError } = await auth.supabase
      .from(detailed ? DETAIL_VIEW : DISCOVERY_VIEW)
      .select("id")
      .eq("id", saleId)
      .maybeSingle();
    if (visibilityError) throw visibilityError;
    if (!visibleSale) throw new PublicApiError("Vente introuvable.", 404);
    const response = await refreshSaleValuationOnDemand(saleId);
    if (response.estimate) {
      await recordFeatureUsageEvent({
        auth,
        eventKey: "valuation.estimated",
        subjectType: "auction_sale",
        subjectId: saleId,
        metadata: {
          source: "precomputed",
          engine_version: response.estimate.engineVersion ?? "v3",
          engine_kind: response.estimate.engineKind ?? "comparable_ensemble",
          segment: response.estimate.segment ?? null,
          sample_size: response.estimate.sampleSize,
          quality_score: response.estimate.qualityScore,
          actionable: response.estimate.actionable === true,
        },
      });
      // Mesure par compte : la valeur de référence du plafond d'enchère est servie pour cette vente
      // (le calcul du plafond lui-même se fait dans le navigateur, à partir de cette valeur).
      await recordAccountProductEvent(auth.userId, { type: "bid_ceiling_calculated", saleId });
    }
    const status = response.estimate
      ? 200
      : response.status === "queued"
        ? 202
        : response.status === "insufficient_data"
          ? 422
          : 503;
    return NextResponse.json(detailed ? response : ceilingMarketContext(response), {
      status,
      headers: {
        "cache-control": response.estimate
          ? "private, max-age=300, stale-while-revalidate=3600"
          : "no-store",
        ...(response.retryAfterSeconds
          ? { "retry-after": String(response.retryAfterSeconds) }
          : {}),
      },
    });
  } catch (error) {
    return apiRouteError(error, request, "market-estimate", {
      fallbackMessage: "Unauthorized",
      extra: { estimate: null },
    });
  }
}
