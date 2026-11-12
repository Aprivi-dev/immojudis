import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  ANALYSIS_TRIAL_DAYS,
  resolveAnalysisOfferLabel,
  STRIPE_CHECKOUT_TRIAL_OFFERED,
} from "@/lib/analysis-offer";
import { apiRoute } from "@/lib/api-route";
import { analysisCheckoutReadiness } from "@/lib/analysis-checkout-readiness";
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
export const GET = apiRoute(
  { scope: "api.billing.offer", fallbackMessage: "Offre indisponible.", fallbackStatus: 503 },
  async (request) => {
    await enforceIpRateLimit({
      request,
      bucketKey: "billing.offer",
      ...RATE_LIMIT_POLICIES.publicIp,
    });
    // Même définition que le checkout (`analysisCheckoutReadiness`).
    const configured = analysisCheckoutReadiness().open;
    // L'essai est accordé à l'inscription : le checkout n'en ajoute pas de second.
    const personalized =
      configured && STRIPE_CHECKOUT_TRIAL_OFFERED && request.headers.has("authorization");
    let trialAvailable = STRIPE_CHECKOUT_TRIAL_OFFERED;
    if (personalized) {
      const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
      trialAvailable = (await resolveAnalysisCheckoutAvailability(auth)).trialAvailable;
    }
    const body = {
      configured,
      trialDays: ANALYSIS_TRIAL_DAYS,
      trialAvailable,
      label: resolveAnalysisOfferLabel(),
    };
    if (personalized) return body;
    return NextResponse.json(body, {
      headers: {
        "cache-control": `public, s-maxage=${BILLING_OFFER_CACHE_SECONDS}, stale-while-revalidate=60`,
      },
    });
  },
);
