import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
  type SupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  ANALYSIS_TRIAL_DAYS,
  resolveAnalysisOfferLabel,
  SALE_UNLOCK_PRICE_CENTS,
  SALE_UNLOCK_PRICE_LABEL,
  STRIPE_CHECKOUT_TRIAL_OFFERED,
} from "@/lib/analysis-offer";
import { apiRoute } from "@/lib/api-route";
import { AuthRequiredError } from "@/lib/api-errors";
import { analysisCheckoutReadiness } from "@/lib/analysis-checkout-readiness";
import { resolveAnalysisCheckoutAvailability } from "@/lib/billing";
import { previewFirstMonthDeductionCents } from "@/lib/billing-unit-deduction";
import { saleUnlockCheckoutReadiness } from "@/lib/sale-unlock-checkout-readiness";
import type { BillingOfferResponse } from "@/lib/client-billing";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";

/**
 * Exposes only the non-sensitive presentation state needed before checkout.
 * The Stripe Price ID itself stays server-only; checkout validates it again.
 *
 * Anonymous visitors get a response that is identical for everyone, so it is cached
 * at the edge for five minutes. A signed-in caller gets a private, uncached answer
 * because the trial eligibility and the deduction of the unit purchases from the first
 * month (`firstMonthDeductionCents`) depend on the account. A token that does not
 * authenticate gets the anonymous answer.
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
    // Rien de propre au compte tant que la souscription n'est pas ouverte : ni essai, ni déduction.
    const auth =
      configured && request.headers.has("authorization") ? await signedInAccount(request) : null;
    // L'essai est accordé à l'inscription : le checkout n'en ajoute pas de second.
    const trialAvailable =
      auth && STRIPE_CHECKOUT_TRIAL_OFFERED
        ? (await resolveAnalysisCheckoutAvailability(auth)).trialAvailable
        : STRIPE_CHECKOUT_TRIAL_OFFERED;
    const body: BillingOfferResponse = {
      configured,
      trialDays: ANALYSIS_TRIAL_DAYS,
      trialAvailable,
      label: resolveAnalysisOfferLabel(),
      saleUnlock: {
        open: saleUnlockCheckoutReadiness().open,
        label: SALE_UNLOCK_PRICE_LABEL,
        amountCents: SALE_UNLOCK_PRICE_CENTS,
      },
      firstMonthDeductionCents: auth ? await firstMonthDeduction(auth) : 0,
    };
    if (auth) return body;
    return NextResponse.json(body, {
      headers: {
        "cache-control": "public, s-maxage=300, stale-while-revalidate=60",
      },
    });
  },
);

/** Le compte de la requête ; `null` pour un jeton qui n'authentifie pas (réponse anonyme). */
async function signedInAccount(request: Request) {
  try {
    return await requireSupabaseAuthContext(bearerTokenFromRequest(request));
  } catch (error) {
    if (error instanceof AuthRequiredError) return null;
    throw error;
  }
}

/**
 * Aperçu de la déduction du premier mois. Il n'est qu'indicatif (le checkout la recalcule en base) :
 * une lecture impossible, par exemple avant la migration de l'achat à l'unité, affiche 0 au lieu de
 * rendre toute l'offre indisponible.
 */
async function firstMonthDeduction(auth: SupabaseAuthContext): Promise<number> {
  try {
    return await previewFirstMonthDeductionCents(auth);
  } catch (error) {
    console.error("[billing] first month deduction preview failed", error);
    return 0;
  }
}
