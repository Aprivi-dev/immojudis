import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { parseApiResponse } from "@/lib/api-error-detail";
import { apiRoute } from "@/lib/api-route";
import { assertFeatureEntitlement } from "@/lib/entitlements.server";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import {
  tribunalJudicialActivityQuerySchema,
  tribunalJudicialActivityResponseSchema,
} from "@/lib/tribunal-judicial-activity";
import { getTribunalJudicialActivity } from "@/lib/tribunal-judicial-activity-repository";

export const GET = apiRoute(
  {
    scope: "tribunal.judicial_activity",
    fallbackMessage: "Activité judiciaire du tribunal temporairement indisponible.",
    fallbackStatus: 503,
    versionedApi: true,
  },
  async (request, { api }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      context: api,
      bucketKey: "v1.tribunal-judicial-activity",
      ...RATE_LIMIT_POLICIES.compute,
    });
    await assertFeatureEntitlement(
      auth,
      "sales.statistics",
      "Activité judiciaire réservée à l’offre Analyse.",
    );
    const url = new URL(request.url);
    const input = tribunalJudicialActivityQuerySchema.parse(
      Object.fromEntries(url.searchParams.entries()),
    );
    return parseApiResponse(
      tribunalJudicialActivityResponseSchema,
      await getTribunalJudicialActivity(input),
    );
  },
);
