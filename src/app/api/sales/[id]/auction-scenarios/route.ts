import { NextResponse, after } from "next/server";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { PublicApiError } from "@/lib/api-errors";
import { apiRouteError } from "@/lib/api-observability";
import type { AuctionScenariosResponse } from "@/lib/auction-scenarios";
import { getAuctionScenarios } from "@/lib/auction-scenarios.server";
import { assertFeatureEntitlementVia } from "@/lib/property-reports";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { DETAIL_VIEW, DISCOVERY_VIEW } from "@/lib/sale-views";
import { recordFeatureUsageEvent } from "@/lib/usage";

const saleIdSchema = z.string().guid();

/**
 * The usage event is written once the response is sent (`after()`): a slow or failing write never
 * delays or breaks the answer, including when the call itself throws before returning a promise.
 */
function recordUsageAfterResponse(
  auth: Parameters<typeof recordFeatureUsageEvent>[0]["auth"],
  saleId: string,
  body: AuctionScenariosResponse,
): void {
  try {
    after(async () => {
      try {
        await recordFeatureUsageEvent({
          auth,
          eventKey: "sales.statistics_viewed",
          subjectType: "auction_sale",
          subjectId: saleId,
          metadata: {
            view: "auction_scenarios",
            court_sample: body.scenarios?.courtSample ?? 0,
            dvf_sample: body.history.dvf?.sample ?? 0,
          },
        });
      } catch {
        // Measurement only: nothing to report to the member.
      }
    });
  } catch {
    // `after()` unavailable (called outside a request): the answer does not depend on it.
  }
}

/**
 * « Scénarios d'enchères » (offre Analyse) : répartition observée des issues et
 * fourchette de prix d'adjudication, d'après les trois dernières années d'adjudications
 * du tribunal. The sale must be visible to the caller first; the figures themselves are cached
 * per (court, starting-price band, property group), after that check. A Découverte account that unlocked
 * this sale (« 3 déblocages par mois ») reads it too, for this sale only.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const saleId = saleIdSchema.parse((await context.params).id);
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    // The entitlement and the rate limit do not depend on each other: one round trip each, in
    // parallel. The entitlement error wins (403 before 429), as when they ran one after the other.
    const [entitlement, rateLimit] = await Promise.allSettled([
      assertFeatureEntitlementVia(
        auth,
        "property.advancedBidScenarios",
        "Les scénarios d’enchères sont réservés à l’offre Analyse.",
        { saleId },
      ),
      enforceUserRateLimit({
        userId: auth.userId,
        bucketKey: "auction-scenarios",
        ...RATE_LIMIT_POLICIES.compute,
      }),
    ]);
    if (entitlement.status === "rejected") throw entitlement.reason;
    if (rateLimit.status === "rejected") throw rateLimit.reason;
    const { door } = entitlement.value;
    const { data: sale, error } = await auth.supabase
      .from(door === "plan" ? DETAIL_VIEW : DISCOVERY_VIEW)
      .select("id, tribunal, tribunal_code, starting_price_eur, property_type")
      .eq("id", saleId)
      .maybeSingle();
    if (error) throw error;
    if (!sale) throw new PublicApiError("Vente introuvable.", 404);

    // Only after the sale is known to be visible: the figures are cached per (court, band, type).
    const body = await getAuctionScenarios(sale as Parameters<typeof getAuctionScenarios>[0]);
    recordUsageAfterResponse(auth, saleId, body);
    return NextResponse.json(body, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return apiRouteError(error, request, "auction-scenarios", {
      fallbackMessage: "Scénarios d’enchères indisponibles.",
    });
  }
}
