import "server-only";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { apiRouteError } from "@/lib/api-observability";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  getOfferOpeningNotification,
  offerOpeningNotificationSchema,
  setOfferOpeningNotification,
} from "@/lib/offer-opening-notification";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";

const NO_STORE = { "cache-control": "private, no-store" };

/** Has the signed-in user asked to be told when subscriptions open? */
export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    return NextResponse.json(await getOfferOpeningNotification({ auth }), { headers: NO_STORE });
  } catch (error) {
    return apiRouteError(error, request, "billing-opening-notification", {
      fallbackMessage: "Demande indisponible",
    });
  }
}

/** Records (or withdraws) the explicit, timestamped request to be told once at opening. */
export async function PUT(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "billing.opening-notification",
      ...RATE_LIMIT_POLICIES.formSubmit,
    });
    const input = offerOpeningNotificationSchema.parse(await request.json());
    const response = await setOfferOpeningNotification({ auth, admin: supabaseAdmin, input });
    return NextResponse.json(response, { headers: NO_STORE });
  } catch (error) {
    return apiRouteError(error, request, "billing-opening-notification", {
      fallbackMessage: "Demande impossible",
    });
  }
}
