import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { ANALYSIS_TRIAL_DAYS, resolveAnalysisOfferLabel } from "@/lib/analysis-offer";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";
import { resolveAnalysisCheckoutAvailability } from "@/lib/billing";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { BILLING_OFFER_CACHE_SECONDS, RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";

/**
 * Exposes only the non-sensitive presentation state needed before checkout.
 * The Stripe Price ID itself stays server-only; checkout validates it again.
 *
 * Anonymous visitors get a response that is identical for everyone, so it is cached
 * at the edge for five minutes. A signed-in caller gets a private, uncached answer
 * because the trial eligibility depends on the account.
 */
export async function GET(request: Request) {
  const context = createApiRequestContext(request, "api.billing.offer");
  try {
    await enforceIpRateLimit({
      request,
      bucketKey: "billing.offer",
      ...RATE_LIMIT_POLICIES.publicIp,
    });
    const configured = Boolean(process.env.STRIPE_ANALYSIS_PRICE_ID?.trim());
    const personalized = configured && request.headers.has("authorization");
    let trialAvailable = true;
    if (personalized) {
      const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
      trialAvailable = (await resolveAnalysisCheckoutAvailability(auth)).trialAvailable;
    }
    return apiJson(
      {
        configured,
        trialDays: ANALYSIS_TRIAL_DAYS,
        trialAvailable,
        label: resolveAnalysisOfferLabel(),
      },
      context,
      {
        headers: {
          "cache-control": personalized
            ? "private, no-store"
            : `public, s-maxage=${BILLING_OFFER_CACHE_SECONDS}, stale-while-revalidate=60`,
        },
      },
    );
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Offre indisponible.",
      fallbackStatus: 503,
    });
  }
}
