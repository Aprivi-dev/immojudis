import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { parseApiResponse } from "@/lib/api-errors";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";
import { assertFeatureEntitlement } from "@/lib/property-reports";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import {
  tribunalJudicialActivityDirectoryQuerySchema,
  tribunalJudicialActivityDirectoryResponseSchema,
} from "@/lib/tribunal-judicial-activity-directory";
import { getTribunalJudicialActivityDirectory } from "@/lib/tribunal-judicial-activity-repository";

export async function GET(request: Request) {
  const context = createApiRequestContext(request, "tribunal.judicial_activity.directory");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      context,
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
    const directory = parseApiResponse(
      tribunalJudicialActivityDirectoryResponseSchema,
      await getTribunalJudicialActivityDirectory(input),
    );
    return apiJson(directory, context, {
      headers: {
        "cache-control": "private, no-store",
        vary: "authorization",
      },
    });
  } catch (error) {
    const response = apiError(error, context, {
      fallbackMessage: "Répertoire statistique des tribunaux temporairement indisponible.",
      fallbackStatus: 503,
    });
    response.headers.set("cache-control", "private, no-store");
    response.headers.set("vary", "authorization");
    return response;
  }
}
