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
import {
  estimateSaleValueWithEnteredSurface,
  refreshSaleValuationOnDemand,
} from "@/lib/sale-market-estimates";
import { getFavoriteEnteredSurface } from "@/lib/favorite-dossier";
import type { MarketContext } from "@/lib/market.server";
import { recordFeatureUsageEvent } from "@/lib/usage";
import { z } from "zod";

const requestSchema = z.object({
  saleId: z.string().guid(),
  /**
   * La valeur du plafond est recalculée sur la surface que le compte a saisie dans « Mon dossier ».
   * La surface est relue sur le compte, jamais prise dans la demande.
   */
  enteredSurface: z.literal(true).optional(),
});

function contextStatus(context: MarketContext): number {
  return context.estimate
    ? 200
    : context.status === "queued"
      ? 202
      : context.status === "insufficient_data"
        ? 422
        : 503;
}

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "market-estimate",
      ...RATE_LIMIT_POLICIES.compute,
    });
    const { saleId, enteredSurface } = requestSchema.parse(await request.json());
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
    if (enteredSurface) {
      // Surface lue dans les pièces par ce compte : la valeur n'est ni stockée, ni journalisée, ni
      // comptée (aucun événement d'usage) ; elle ne sert qu'au plafond de ce compte. Toujours la
      // projection du plafond : le détail de l'estimation (Analyse) reste celui de l'annonce.
      const surface = await getFavoriteEnteredSurface({ auth, saleId });
      if (surface == null) {
        throw new PublicApiError("Aucune surface saisie dans votre dossier pour cette vente.", 404);
      }
      const context = await estimateSaleValueWithEnteredSurface(saleId, surface);
      if (!context) {
        throw new PublicApiError("L’annonce publie déjà la surface de cette vente.", 409);
      }
      return NextResponse.json(ceilingMarketContext(context), {
        status: contextStatus(context),
        headers: { "cache-control": "private, no-store" },
      });
    }
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
      // Mesure par compte : « estimation servie » (événement `bid_ceiling_calculated`, nom gardé pour
      // les données). La valeur de référence du plafond est servie pour cette vente ; le calcul du
      // plafond se fait dans le navigateur, mesuré à part (`ceiling_viewed`).
      await recordAccountProductEvent(auth.userId, { type: "bid_ceiling_calculated", saleId });
    }
    const status = contextStatus(response);
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
