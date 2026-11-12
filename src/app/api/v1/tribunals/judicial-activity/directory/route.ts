import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { parseApiResponse } from "@/lib/api-error-detail";
import { apiRoute } from "@/lib/api-route";
import { assertFeatureEntitlement } from "@/lib/property-reports";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import {
  tribunalJudicialActivityDirectoryQuerySchema,
  tribunalJudicialActivityDirectoryResponseSchema,
} from "@/lib/tribunal-judicial-activity-directory";
import { getTribunalJudicialActivityDirectory } from "@/lib/tribunal-judicial-activity-repository";

export const GET = apiRoute(
  {
    scope: "tribunal.judicial_activity.directory",
    fallbackMessage: "Répertoire statistique des tribunaux temporairement indisponible.",
    fallbackStatus: 503,
    versionedApi: true,
  },
  async (request, { api }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      context: api,
      bucketKey: "v1.tribunal-judicial-activity-directory",
      ...RATE_LIMIT_POLICIES.compute,
    });
    await assertFeatureEntitlement(
      auth,
      "sales.statistics",
      "Répertoire des tribunaux réservé à l’offre Analyse.",
    );
    const url = new URL(request.url);
    const input = tribunalJudicialActivityDirectoryQuerySchema.parse(
      Object.fromEntries(url.searchParams.entries()),
    );
    return parseApiResponse(
      tribunalJudicialActivityDirectoryResponseSchema,
      await getTribunalJudicialActivityDirectory(input),
    );
  },
);
