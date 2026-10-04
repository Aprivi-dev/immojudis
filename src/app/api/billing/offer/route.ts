import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { ANALYSIS_TRIAL_DAYS, resolveAnalysisOfferLabel } from "@/lib/analysis-offer";
import { resolveAnalysisCheckoutAvailability } from "@/lib/billing";

/**
 * Exposes only the non-sensitive presentation state needed before checkout.
 * The Stripe Price ID itself stays server-only; checkout validates it again.
 */
export async function GET(request: Request) {
  const configured = Boolean(process.env.STRIPE_ANALYSIS_PRICE_ID?.trim());
  let trialAvailable = true;
  if (configured && request.headers.has("authorization")) {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    trialAvailable = (await resolveAnalysisCheckoutAvailability(auth)).trialAvailable;
  }
  return Response.json(
    {
      configured,
      trialDays: ANALYSIS_TRIAL_DAYS,
      trialAvailable,
      label: resolveAnalysisOfferLabel(),
    },
    {
      headers: { "cache-control": "no-store" },
    },
  );
}
