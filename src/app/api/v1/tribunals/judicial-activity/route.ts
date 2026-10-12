import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";
import { assertFeatureEntitlement } from "@/lib/property-reports";
import {
  tribunalJudicialActivityQuerySchema,
  tribunalJudicialActivityResponseSchema,
  TribunalCourtUnresolvedError,
} from "@/lib/tribunal-judicial-activity";
import { getTribunalJudicialActivity } from "@/lib/tribunal-judicial-activity-repository";

export async function GET(request: Request) {
  const context = createApiRequestContext(request, "tribunal.judicial_activity");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await assertFeatureEntitlement(
      auth,
      "sales.statistics",
      "Activité judiciaire réservée au plan Analyse.",
    );
    const url = new URL(request.url);
    const input = tribunalJudicialActivityQuerySchema.parse(
      Object.fromEntries(url.searchParams.entries()),
    );
    const activity = tribunalJudicialActivityResponseSchema.parse(
      await getTribunalJudicialActivity(input),
    );
    return apiJson(activity, context, {
      headers: {
        "cache-control": "private, no-store",
        vary: "authorization",
      },
    });
  } catch (error) {
    if (error instanceof TribunalCourtUnresolvedError) {
      return apiJson(
        {
          ok: false,
          code: "COURT_UNRESOLVED",
          error: "Le rattachement exact au tribunal reste à confirmer.",
          requestId: context.requestId,
        },
        context,
        { status: 422 },
      );
    }
    const response = apiError(error, context, {
      fallbackMessage: "Activité judiciaire du tribunal temporairement indisponible.",
      fallbackStatus: 503,
    });
    response.headers.set("cache-control", "private, no-store");
    response.headers.set("vary", "authorization");
    return response;
  }
}
