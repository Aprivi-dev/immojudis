import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  getOfferOpeningNotification,
  offerOpeningNotificationSchema,
  offerOpeningSurveySchema,
  setOfferOpeningNotification,
  setOfferOpeningSurvey,
} from "@/lib/offer-opening-notification";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import type { ApiRequestContext } from "@/lib/api-observability";

/** PUT and PATCH share one bucket: both write the same request of the signed-in user. */
async function authorizeWrite(request: Request, api: ApiRequestContext) {
  const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
  await enforceUserRateLimit({
    userId: auth.userId,
    bucketKey: "billing.opening-notification",
    ...RATE_LIMIT_POLICIES.formSubmit,
    context: api,
  });
  return auth;
}

/** Has the signed-in user asked to be told when subscriptions open? */
export const GET = apiRoute(
  { scope: "api.billing.opening-notification.read", fallbackMessage: "Demande indisponible" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    return getOfferOpeningNotification({ auth });
  },
);

/** Records (or withdraws) the explicit, timestamped request to be told once at opening. */
export const PUT = apiRoute(
  { scope: "api.billing.opening-notification.write", fallbackMessage: "Demande impossible" },
  async (request, { api }) => {
    const auth = await authorizeWrite(request, api);
    const input = offerOpeningNotificationSchema.parse(await request.json());
    return setOfferOpeningNotification({ auth, admin: supabaseAdmin, input });
  },
);

/**
 * Optional answers of the qualified waiting list (profile, sales studied per month, two price
 * marks, interview of about 45 minutes). Only for someone whose request is active: nothing here is required
 * to join the list.
 */
export const PATCH = apiRoute(
  {
    scope: "api.billing.opening-notification.survey",
    fallbackMessage: "Réponses impossibles à enregistrer",
  },
  async (request, { api }) => {
    const auth = await authorizeWrite(request, api);
    const input = offerOpeningSurveySchema.parse(await request.json());
    return setOfferOpeningSurvey({ auth, admin: supabaseAdmin, input });
  },
);
