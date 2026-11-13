import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiRoute } from "@/lib/api-route";
import { getAuctionScenarios } from "@/lib/auction-scenarios.server";
import { assertFeatureEntitlementVia, readSaleThroughDoor } from "@/lib/entitlements.server";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { recordFeatureUsageEvent } from "@/lib/usage";

const saleIdSchema = z.string().guid();

/**
 * « Scénarios d'enchères » (offre Analyse) : répartition observée des issues et
 * fourchette de prix d'adjudication, d'après les trois dernières années d'adjudications
 * du tribunal. The sale must be visible to the caller first; the figures themselves are cached
 * per (court, starting-price band, property group), after that check. A Découverte account that unlocked
 * this sale (« 3 déblocages par mois ») reads it too, for this sale only.
 */
export const GET = apiRoute<{ id: string }>(
  { scope: "auction-scenarios", fallbackMessage: "Scénarios d’enchères indisponibles." },
  async (request, { params }) => {
    const saleId = saleIdSchema.parse(params.id);
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
    const sale = await readSaleThroughDoor<Parameters<typeof getAuctionScenarios>[0]>(
      auth,
      saleId,
      door,
      "id, tribunal, tribunal_code, starting_price_eur, property_type",
    );

    // Only after the sale is known to be visible: the figures are cached per (court, band, type).
    const body = await getAuctionScenarios(sale);
    recordFeatureUsageEvent({
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
    return body;
  },
);
